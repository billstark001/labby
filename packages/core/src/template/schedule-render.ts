import { resolveSessionTimeRange, type SessionTimeRange } from '../schedule/session.js';
import type { Person, ScheduleConfig, SchedulePlan, Session } from '../types.js';
import { getEnvironmentTimeZone, getTimeZoneOffsetMinutes, normalizeTimeZone } from '../timezone.js';
import { renderTemplate } from './renderer.js';

export interface ScheduleTableLabels {
  date: string;
  presenter: string;
  questioners: string;
}

export type ScheduleExportMode = 'semester' | 'window' | 'once';
export type ScheduleWindowUnit = 'week' | 'month' | 'quarter';
export type ScheduleDateGranularity = 'date' | 'date-time' | 'month-day' | 'month-day-time';
export type ScheduleIcsMode = 'presenters' | 'meeting';

export interface ScheduleDateDisplayOptions {
  locale?: string;
  granularity?: ScheduleDateGranularity;
  includeWeekday?: boolean;
  timeZone?: string;
}

export interface ScheduleRowBuildOptions {
  mode?: ScheduleExportMode;
  windowUnit?: ScheduleWindowUnit;
  windowCount?: number;
  anchorDate?: string;
  onceIndex?: number;
  dateDisplay?: ScheduleDateDisplayOptions;
  config?: ScheduleConfig;
}

export interface ScheduleRow {
  dateIso: string;
  dateLabel: string;
  presenter: string;
  questioners: string[];
}

export interface ScheduleTemplateBlocks {
  rows: ScheduleRow[];
  tableHtml: string;
  tableMarkdown: string;
  listMarkdown: string;
  plainText: string;
  csv: string;
}

export interface EmailTemplateVariableDoc {
  name: string;
  type: string;
  descriptions: {
    en: string;
    'zh-CN': string;
    'ja-JP': string;
  };
}

export const ICS_TEMPLATE_VARIABLE_DOCS: EmailTemplateVariableDoc[] = [
  { name: 'sessionNotes', type: 'string', descriptions: {
    en: 'Optional note for this calendar event’s meeting.', 'zh-CN': '当前日历事件对应组会的单次备注（未设置时为空）。', 'ja-JP': 'この予定のミーティングのメモ（未設定時は空文字列）。',
  } },
  { name: 'sessionDate', type: 'string', descriptions: {
    en: 'Meeting date in YYYY-MM-DD format.', 'zh-CN': '组会日期，格式为 YYYY-MM-DD。', 'ja-JP': 'ミーティングの日付（YYYY-MM-DD）。',
  } },
  { name: 'sessionStartTime', type: 'string', descriptions: {
    en: 'Meeting start time in the schedule timezone.', 'zh-CN': '排班时区中的组会开始时间。', 'ja-JP': 'スケジュールのタイムゾーンでの開始時刻。',
  } },
  { name: 'sessionEndTime', type: 'string', descriptions: {
    en: 'Meeting end time in the schedule timezone.', 'zh-CN': '排班时区中的组会结束时间。', 'ja-JP': 'スケジュールのタイムゾーンでの終了時刻。',
  } },
  { name: 'eventStart', type: 'string', descriptions: {
    en: 'This ICS event start as a UTC ISO timestamp.', 'zh-CN': '当前 ICS 事件的 UTC ISO 开始时间。', 'ja-JP': 'この ICS イベントの UTC ISO 開始日時。',
  } },
  { name: 'eventEnd', type: 'string', descriptions: {
    en: 'This ICS event end as a UTC ISO timestamp.', 'zh-CN': '当前 ICS 事件的 UTC ISO 结束时间。', 'ja-JP': 'この ICS イベントの UTC ISO 終了日時。',
  } },
  { name: 'timeZone', type: 'string', descriptions: {
    en: 'Resolved schedule timezone.', 'zh-CN': '最终采用的排班时区。', 'ja-JP': '確定したスケジュールのタイムゾーン。',
  } },
  { name: 'presenter', type: 'string', descriptions: {
    en: 'Current presenter name; empty in meeting mode.', 'zh-CN': '当前发表者姓名；组会模式下为空。', 'ja-JP': '現在の発表者名。ミーティングモードでは空文字列。',
  } },
  { name: 'presenters', type: 'string[]', descriptions: {
    en: 'Names of all presenters in this meeting.', 'zh-CN': '本场组会中所有发表者的姓名。', 'ja-JP': 'このミーティングの全発表者名。',
  } },
  { name: 'questioners', type: 'string[]', descriptions: {
    en: 'Current presenter’s questioners, or all unique questioners in meeting mode.', 'zh-CN': '当前发表者的提问者；组会模式下为所有不重复的提问者。', 'ja-JP': '現在の発表者の質問者。ミーティングモードでは重複のない全質問者。',
  } },
];

export interface BuildEmailTemplateScheduleVariablesOptions {
  plan?: SchedulePlan | null;
  persons?: Person[];
  personMap?: Map<string, Person>;
  config?: ScheduleConfig;
  locale?: string;
  granularity?: ScheduleDateGranularity;
  includeWeekday?: boolean;
  anchorDate?: string;
  labels?: Partial<ScheduleTableLabels>;
  displayName?: (person: Person) => string;
  /** Resolved schedule timezone; the email dispatch timezone does not format meetings. */
  timeZone?: string;
}

interface NextSessionSummary {
  dateText: string;
  timeText: string;
  dateTimeText: string;
  notes: string;
}

const DEFAULT_TABLE_LABELS: ScheduleTableLabels = {
  date: 'Date',
  presenter: 'Presenter',
  questioners: 'Questioners',
};

const EMPTY_BLOCKS: ScheduleTemplateBlocks = {
  rows: [],
  tableHtml: '<table><thead><tr><th>Date</th><th>Presenter</th><th>Questioners</th></tr></thead><tbody></tbody></table>',
  tableMarkdown: '| Date | Presenter | Questioners |\n| --- | --- | --- |',
  listMarkdown: '- (no sessions)',
  plainText: 'Date\tPresenter\tQuestioners',
  csv: 'date,presenter,questioners',
};

function fallbackEntityId(id?: string): string {
  return `ID:${id ?? '<empty>'}`;
}

function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function escapeMarkdown(text: string): string {
  return text.replaceAll('|', '\\|').replaceAll('\n', ' ');
}

function csvCell(raw: string): string {
  if (raw.includes(',') || raw.includes('"') || raw.includes('\n')) {
    return `"${raw.replaceAll('"', '""')}"`;
  }
  return raw;
}

function normalizeLocale(locale?: string): string {
  return locale && locale.trim() ? locale : 'en-US';
}

function localeToNameKey(locale: string): 'en' | 'zh' | 'ja' {
  if (locale.startsWith('zh')) return 'zh';
  if (locale.startsWith('ja')) return 'ja';
  return 'en';
}

function defaultDisplayName(person: Person, locale: string): string {
  const nameKey = localeToNameKey(locale);
  const localized = person.names?.[nameKey]?.trim();
  if (localized) return localized;
  if (person.name?.trim()) return person.name.trim();
  const anyName = Object.values(person.names ?? {}).map((value) => value.trim()).find(Boolean);
  return anyName || fallbackEntityId(person.id);
}

function parseDate(dateStr: string, timeZone?: string): Date {
  const [year, month, day] = dateStr.split('-').map(Number);
  const utcNoon = Date.UTC(year, (month ?? 1) - 1, day ?? 1, 12, 0, 0);
  const offset = timeZone ? getTimeZoneOffsetMinutes(timeZone, new Date(utcNoon)) : 0;
  return new Date(utcNoon - (offset ?? 0) * 60_000);
}

function parseClock(timeStr: string): { hour: number; minute: number } | null {
  const match = timeStr.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return { hour, minute };
}

function formatTimeLabel(timeStr: string, locale: string): string {
  const parsed = parseClock(timeStr);
  if (!parsed) return timeStr;
  const date = new Date(Date.UTC(2000, 0, 1, parsed.hour, parsed.minute));
  return new Intl.DateTimeFormat(normalizeLocale(locale), {
    timeZone: 'UTC',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(date);
}

function formatTimeRangeLabel(timeRange: SessionTimeRange, locale: string): string {
  const [start, end] = timeRange;
  const startLabel = formatTimeLabel(start, locale);
  const endLabel = formatTimeLabel(end, locale);
  return `${startLabel} - ${endLabel}`;
}

function pickNextSession(plan: SchedulePlan, anchorDate?: string): SchedulePlan['sessions'][number] | null {
  const sorted = plan.sessions.slice().sort((left, right) => left.date.localeCompare(right.date));
  if (sorted.length === 0) return null;
  const anchor = anchorDate ?? new Date().toISOString().slice(0, 10);
  return sorted.find((session) => session.date >= anchor) ?? sorted[sorted.length - 1] ?? null;
}

function buildNextSessionSummary(
  plan: SchedulePlan,
  options: BuildEmailTemplateScheduleVariablesOptions,
): NextSessionSummary {
  const locale = normalizeLocale(options.locale);
  const next = pickNextSession(plan, options.anchorDate);
  if (!next) {
    return {
      dateText: '',
      timeText: '',
      dateTimeText: '',
      notes: '',
    };
  }

  const dateText = formatDateLabel(next.date, {
    locale,
    granularity: options.granularity === 'month-day' || options.granularity === 'month-day-time' ? 'month-day' : 'date',
    includeWeekday: options.includeWeekday ?? true,
    timeZone: options.config?.timezone ?? options.timeZone,
  }, options.config?.timeRange);
  const timeText = formatTimeRangeLabel(resolveSessionTimeRange(next, options.config), locale);

  return {
    dateText,
    timeText,
    dateTimeText: `${dateText} ${timeText}`.trim(),
    notes: next.date >= (options.anchorDate ?? new Date().toISOString().slice(0, 10)) ? next.notes ?? '' : '',
  };
}

function formatDateLabel(dateIso: string, options: ScheduleDateDisplayOptions = {}, timeRange?: SessionTimeRange): string {
  const locale = normalizeLocale(options.locale);
  const granularity = options.granularity ?? 'date';
  const includeWeekday = options.includeWeekday ?? false;
  const timeZone = normalizeTimeZone(options.timeZone) ?? 'UTC';
  const date = parseDate(dateIso, timeZone);

  const formatOptions: Intl.DateTimeFormatOptions = {
    timeZone,
    month: '2-digit',
    day: '2-digit',
  };

  if (includeWeekday) {
    formatOptions.weekday = 'short';
  }

  if (granularity === 'date' || granularity === 'date-time') {
    formatOptions.year = 'numeric';
  }

  const dateText = new Intl.DateTimeFormat(locale, formatOptions).format(date);

  if (granularity === 'date-time' || granularity === 'month-day-time') {
    const timeText = timeRange?.join('-') ?? '';
    return timeText ? `${dateText} ${timeText}` : dateText;
  }

  return dateText;
}

function pickSessions(plan: SchedulePlan, options: ScheduleRowBuildOptions = {}): SchedulePlan['sessions'] {
  const mode = options.mode ?? 'semester';
  const sorted = plan.sessions.slice().sort((left, right) => left.date.localeCompare(right.date));

  if (mode === 'semester') {
    return sorted;
  }

  if (sorted.length === 0) {
    return sorted;
  }

  const anchorDate = options.anchorDate ?? new Date().toISOString().slice(0, 10);

  if (mode === 'once') {
    if (typeof options.onceIndex === 'number' && options.onceIndex >= 0) {
      const target = sorted[options.onceIndex];
      return target ? [target] : [];
    }

    const next = sorted.find((session) => session.date >= anchorDate);
    return next ? [next] : [sorted[sorted.length - 1]];
  }

  const unit = options.windowUnit ?? 'month';
  const count = Math.max(1, options.windowCount ?? 1);
  const start = parseDate(anchorDate);
  const end = new Date(start);

  if (unit === 'week') {
    end.setDate(end.getDate() + 7 * count);
  } else if (unit === 'month') {
    end.setMonth(end.getMonth() + count);
  } else {
    end.setMonth(end.getMonth() + 3 * count);
  }

  return sorted.filter((session) => {
    const date = parseDate(session.date);
    return date >= start && date < end;
  });
}

type PersonNameResolver = (id: string) => string;

function createPersonNameResolver(personMap: Map<string, Person>, displayName: (person: Person) => string): PersonNameResolver {
  return function resolveName(id: string): string {
    const person = personMap.get(id);
    return person ? displayName(person) : fallbackEntityId(id);
  };
}

export function buildScheduleRows(
  plan: SchedulePlan,
  personMap: Map<string, Person>,
  displayName: (person: Person) => string,
  options: ScheduleRowBuildOptions = {},
): ScheduleRow[] {
  const rows: ScheduleRow[] = [];
  const resolveName = createPersonNameResolver(personMap, displayName);
  for (const session of pickSessions(plan, options)) {
    const times = session.timeRange ?? options.config?.timeRange;
    const dateLabel = formatDateLabel(session.date, options.dateDisplay, times);
    for (const presentation of session.presentations) {
      rows.push({
        dateIso: session.date,
        dateLabel,
        presenter: resolveName(presentation.presenterId),
        questioners: presentation.questionerIds.map(resolveName),
      });
    }
  }
  return rows;
}

function renderHtmlRow(row: ScheduleRow): string {
  return `<tr>\n  <td>${escapeHtml(row.dateLabel)}</td>\n  <td>${escapeHtml(row.presenter)}</td>\n  <td>${escapeHtml(row.questioners.join(', '))}</td>\n</tr>`;
}

function renderMarkdownRow(row: ScheduleRow): string {
  return `| ${escapeMarkdown(row.dateLabel)} | ${escapeMarkdown(row.presenter)} | ${escapeMarkdown(row.questioners.join(', '))} |`;
}

function renderBulletRow(row: ScheduleRow): string {
  return `- ${escapeMarkdown(row.dateLabel)}\n  - presenter: ${escapeMarkdown(row.presenter)}\n  - questioners: ${escapeMarkdown(row.questioners.join(', '))}`;
}

function renderPlainTextRow(row: ScheduleRow): string {
  return `${row.dateLabel}\t${row.presenter}\t${row.questioners.join(', ')}`;
}

export function buildScheduleTableHtml(rows: ScheduleRow[], labels: ScheduleTableLabels = DEFAULT_TABLE_LABELS): string {
  const body = rows.map(renderHtmlRow).join('\n');
  return `<table>\n<thead>\n<tr>\n  <th>${escapeHtml(labels.date)}</th>\n  <th>${escapeHtml(labels.presenter)}</th>\n  <th>${escapeHtml(labels.questioners)}</th>\n</tr>\n</thead>\n<tbody>\n${body}\n</tbody>\n</table>`;
}

export function buildScheduleTableMarkdown(rows: ScheduleRow[], labels: ScheduleTableLabels = DEFAULT_TABLE_LABELS): string {
  const header = `| ${escapeMarkdown(labels.date)} | ${escapeMarkdown(labels.presenter)} | ${escapeMarkdown(labels.questioners)} |`;
  return [header, '| --- | --- | --- |'].concat(rows.map(renderMarkdownRow)).join('\n');
}

export function buildScheduleBulletListMarkdown(rows: ScheduleRow[]): string {
  return rows.length ? rows.map(renderBulletRow).join('\n') : '- (no sessions)';
}

export function buildSchedulePlainText(rows: ScheduleRow[]): string {
  return ['Date\tPresenter\tQuestioners'].concat(rows.map(renderPlainTextRow)).join('\n');
}

export function buildScheduleCsvText(rows: ScheduleRow[]): string {
  const lines = ['date,presenter,questioners'];
  for (const row of rows) {
    lines.push([
      csvCell(row.dateLabel),
      csvCell(row.presenter),
      csvCell(row.questioners.join('; ')),
    ].join(','));
  }
  return lines.join('\n');
}

/** Convert a schedule-local date and time to a UTC instant. */
function icsInstant(dateStr: string, timeStr: string, timeZone: string): number {
  const localAsUtc = Date.parse(`${dateStr}T${timeStr}:00Z`);
  let offset = getTimeZoneOffsetMinutes(timeZone, new Date(localAsUtc)) ?? 0;
  let instant = localAsUtc - offset * 60_000;
  offset = getTimeZoneOffsetMinutes(timeZone, new Date(instant)) ?? offset;
  instant = localAsUtc - offset * 60_000;
  return instant;
}

function icsDateTime(instant: number): string {
  return `${new Date(instant).toISOString().slice(0, 19).replaceAll('-', '').replaceAll(':', '')}Z`;
}

function escapeIcsText(text: string): string {
  return text
    .replaceAll('\\', '\\\\')
    .replaceAll('\n', '\\n')
    .replaceAll(',', '\\,')
    .replaceAll(';', '\\;');
}

interface IcsPresentation {
  presenterId: string;
  presenterName: string;
  questionerNames: string[];
}

function buildIcsPresentations(session: Session, resolveName: PersonNameResolver): IcsPresentation[] {
  const presentations: IcsPresentation[] = [];
  for (const presentation of session.presentations) {
    presentations.push({
      presenterId: presentation.presenterId,
      presenterName: resolveName(presentation.presenterId),
      questionerNames: presentation.questionerIds.map(resolveName),
    });
  }
  return presentations;
}

function getPresenterName(presentation: IcsPresentation): string {
  return presentation.presenterName;
}

function uniqueQuestionerNames(presentations: IcsPresentation[]): string[] {
  const names = new Set<string>();
  for (const presentation of presentations) {
    for (const name of presentation.questionerNames) names.add(name);
  }
  return Array.from(names);
}

function renderIcsDescription(template: string | undefined, context: Record<string, unknown>, fallback: string, notes?: string): string {
  if (!template?.trim()) return notes ? [fallback, notes].filter(Boolean).join('\n') : fallback;
  const rendered = renderTemplate(template, context, { strict: true });
  if (rendered.errors.length) throw new Error(`Invalid ICS content template: ${rendered.errors[0]!.message}`);
  return rendered.output;
}

export function buildScheduleIcs(
  plan: SchedulePlan,
  personMap: Map<string, Person>,
  displayName: (person: Person) => string,
  config: ScheduleConfig | undefined,
  labels: { presenter: string; questioners: string; meeting?: string } = { presenter: 'Presenter', questioners: 'Questioners' },
  options: { timeZone?: string; mode?: ScheduleIcsMode; contentTemplate?: string; templateContext?: Record<string, unknown> } = {},
): string {
  const timeZone = normalizeTimeZone(config?.timezone) ?? normalizeTimeZone(options.timeZone) ?? getEnvironmentTimeZone();
  const dtStamp = new Date(plan.createdAt).toISOString().slice(0, 19).replaceAll('-', '').replaceAll(':', '') + 'Z';

  const events: string[] = [];
  const resolveName = createPersonNameResolver(personMap, displayName);
  for (const session of plan.sessions) {
    const [startTime, endTime] = resolveSessionTimeRange(session, config);
    const presentations = buildIcsPresentations(session, resolveName);
    const presenterNames = presentations.map(getPresenterName);
    const questionerNames = uniqueQuestionerNames(presentations);
    const endDate = endTime <= startTime
      ? new Date(Date.parse(`${session.date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10)
      : session.date;
    const meetingStart = icsInstant(session.date, startTime, timeZone);
    const meetingEnd = icsInstant(endDate, endTime, timeZone);
    const durationMinutes = Math.max(1, Math.round((meetingEnd - meetingStart) / 60_000));
    const mode = options.mode === 'meeting' ? 'meeting' : 'presenters';
    const eventCount = mode === 'meeting' ? 1 : presentations.length;
    for (let index = 0; index < eventCount; index++) {
      const pres = mode === 'meeting' ? undefined : presentations[index];
      // When a meeting is shorter than the presenter count, one-minute events must overlap.
      const startMinute = mode === 'meeting' ? 0 : Math.min(Math.floor(durationMinutes * index / eventCount), durationMinutes - 1);
      const endMinute = mode === 'meeting' ? durationMinutes : Math.max(startMinute + 1, Math.floor(durationMinutes * (index + 1) / eventCount));
      const dtStart = icsDateTime(meetingStart + startMinute * 60_000);
      const dtEnd = icsDateTime(meetingStart + endMinute * 60_000);
      const uid = mode === 'meeting'
        ? `labby-${plan.id}-meeting-${session.date}@labby`
        : `labby-${plan.id}-${pres!.presenterId}-${session.date}@labby`;
      const summary = pres ? `${labels.presenter}: ${pres.presenterName}` : (labels.meeting ?? 'Group meeting');
      const defaultDescription = pres
        ? (pres.questionerNames.length > 0 ? `${labels.questioners}: ${pres.questionerNames.join(', ')}` : '')
        : `${labels.presenter}: ${presenterNames.join(', ')}`;
      const templateContext = Object.assign({}, options.templateContext, {
        sessionDate: session.date,
        sessionNotes: session.notes ?? '',
        sessionStartTime: startTime,
        sessionEndTime: endTime,
        eventStart: new Date(meetingStart + startMinute * 60_000).toISOString(),
        eventEnd: new Date(meetingStart + endMinute * 60_000).toISOString(),
        timeZone,
        presenter: pres?.presenterName ?? '',
        presenters: presenterNames,
        questioners: pres?.questionerNames ?? questionerNames,
      });
      const description = renderIcsDescription(options.contentTemplate, templateContext, defaultDescription, session.notes);

      events.push([
        'BEGIN:VEVENT',
        `UID:${escapeIcsText(uid)}`,
        `DTSTAMP:${dtStamp}`,
        `DTSTART:${dtStart}`,
        `DTEND:${dtEnd}`,
        `SUMMARY:${escapeIcsText(summary)}`,
        description ? `DESCRIPTION:${escapeIcsText(description)}` : '',
        'END:VEVENT',
      ].filter(Boolean).join('\r\n'));
    }
  }

  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Labby//Labby Scheduler//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-TIMEZONE:${timeZone}`,
  ].concat(events, 'END:VCALENDAR').filter(Boolean).join('\r\n') + '\r\n';
}

export function buildScheduleTemplateBlocks(
  plan: SchedulePlan,
  personMap: Map<string, Person>,
  displayName: (person: Person) => string,
  options: ScheduleRowBuildOptions = {},
  labels: ScheduleTableLabels = DEFAULT_TABLE_LABELS,
): ScheduleTemplateBlocks {
  const rows = buildScheduleRows(plan, personMap, displayName, options);
  return {
    rows,
    tableHtml: buildScheduleTableHtml(rows, labels),
    tableMarkdown: buildScheduleTableMarkdown(rows, labels),
    listMarkdown: buildScheduleBulletListMarkdown(rows),
    plainText: buildSchedulePlainText(rows),
    csv: buildScheduleCsvText(rows),
  };
}

function emptyVariables(): Record<string, unknown> {
  return {
    scheduleSemesterTableHtml: EMPTY_BLOCKS.tableHtml,
    scheduleSemesterTableMarkdown: EMPTY_BLOCKS.tableMarkdown,
    scheduleSemesterBulletedListMarkdown: EMPTY_BLOCKS.listMarkdown,
    scheduleWeekTableHtml: EMPTY_BLOCKS.tableHtml,
    scheduleWeekTableMarkdown: EMPTY_BLOCKS.tableMarkdown,
    scheduleWeekBulletedListMarkdown: EMPTY_BLOCKS.listMarkdown,
    scheduleMonthTableHtml: EMPTY_BLOCKS.tableHtml,
    scheduleMonthTableMarkdown: EMPTY_BLOCKS.tableMarkdown,
    scheduleMonthBulletedListMarkdown: EMPTY_BLOCKS.listMarkdown,
    scheduleQuarterTableHtml: EMPTY_BLOCKS.tableHtml,
    scheduleQuarterTableMarkdown: EMPTY_BLOCKS.tableMarkdown,
    scheduleQuarterBulletedListMarkdown: EMPTY_BLOCKS.listMarkdown,
    scheduleOnceTableHtml: EMPTY_BLOCKS.tableHtml,
    scheduleOnceTableMarkdown: EMPTY_BLOCKS.tableMarkdown,
    scheduleOnceBulletedListMarkdown: EMPTY_BLOCKS.listMarkdown,
    scheduleNextSessionNotes: '',
    nextSessionNotes: () => '',
    scheduleNextSessionDateText: '',
    scheduleNextSessionTimeText: '',
    scheduleNextSessionDateTimeText: '',
    nextSessionDateText: () => '',
    nextSessionTimeText: () => '',
    nextSessionDateTimeText: () => '',
    scheduleRowsJson: '[]',
  };
}

function buildPersonMap(persons: Person[]): Map<string, Person> {
  const result = new Map<string, Person>();
  for (const person of persons) result.set(person.id, person);
  return result;
}

function createRowBuildOptions(options: BuildEmailTemplateScheduleVariablesOptions, mode: ScheduleExportMode, windowUnit?: ScheduleWindowUnit): ScheduleRowBuildOptions {
  return {
    config: options.config,
    anchorDate: options.anchorDate,
    mode,
    windowUnit,
    windowCount: 1,
    dateDisplay: {
      locale: normalizeLocale(options.locale),
      granularity: options.granularity,
      includeWeekday: options.includeWeekday,
      timeZone: options.config?.timezone ?? options.timeZone,
    },
  };
}

export function buildEmailTemplateScheduleVariables(
  options: BuildEmailTemplateScheduleVariablesOptions,
): Record<string, unknown> {
  const plan = options.plan;
  if (!plan) return emptyVariables();

  const locale = normalizeLocale(options.locale);
  const personMap = options.personMap ?? buildPersonMap(options.persons ?? []);
  const displayName = options.displayName ?? ((person: Person) => defaultDisplayName(person, locale));
  const labels: ScheduleTableLabels = {
    date: options.labels?.date ?? DEFAULT_TABLE_LABELS.date,
    presenter: options.labels?.presenter ?? DEFAULT_TABLE_LABELS.presenter,
    questioners: options.labels?.questioners ?? DEFAULT_TABLE_LABELS.questioners,
  };

  const buildBlocks = (mode: ScheduleExportMode, windowUnit?: ScheduleWindowUnit): ScheduleTemplateBlocks => {
    const rowOptions = createRowBuildOptions(options, mode, windowUnit);
    return buildScheduleTemplateBlocks(plan, personMap, displayName, rowOptions, labels);
  };

  const semester = buildBlocks('semester');
  const week = buildBlocks('window', 'week');
  const month = buildBlocks('window', 'month');
  const quarter = buildBlocks('window', 'quarter');
  const once = buildBlocks('once');

  const nextSession = buildNextSessionSummary(plan, options);
  const getNextSessionDateText = () => nextSession.dateText;
  const getNextSessionTimeText = () => nextSession.timeText;
  const getNextSessionDateTimeText = () => nextSession.dateTimeText;

  return {
    scheduleSemesterTableHtml: semester.tableHtml,
    scheduleSemesterTableMarkdown: semester.tableMarkdown,
    scheduleSemesterBulletedListMarkdown: semester.listMarkdown,
    scheduleWeekTableHtml: week.tableHtml,
    scheduleWeekTableMarkdown: week.tableMarkdown,
    scheduleWeekBulletedListMarkdown: week.listMarkdown,
    scheduleMonthTableHtml: month.tableHtml,
    scheduleMonthTableMarkdown: month.tableMarkdown,
    scheduleMonthBulletedListMarkdown: month.listMarkdown,
    scheduleQuarterTableHtml: quarter.tableHtml,
    scheduleQuarterTableMarkdown: quarter.tableMarkdown,
    scheduleQuarterBulletedListMarkdown: quarter.listMarkdown,
    scheduleOnceTableHtml: once.tableHtml,
    scheduleOnceTableMarkdown: once.tableMarkdown,
    scheduleOnceBulletedListMarkdown: once.listMarkdown,
    scheduleNextSessionNotes: nextSession.notes,
    nextSessionNotes: () => nextSession.notes,
    scheduleNextSessionDateText: getNextSessionDateText(),
    scheduleNextSessionTimeText: getNextSessionTimeText(),
    scheduleNextSessionDateTimeText: getNextSessionDateTimeText(),
    nextSessionDateText: getNextSessionDateText,
    nextSessionTimeText: getNextSessionTimeText,
    nextSessionDateTimeText: getNextSessionDateTimeText,
    scheduleRowsJson: JSON.stringify(semester.rows),
  };
}

export const EMAIL_TEMPLATE_VARIABLE_DOCS: EmailTemplateVariableDoc[] = [
  { name: 'scheduleNextSessionNotes', type: 'string', descriptions: {
    en: 'Optional note for the next meeting; empty when unset.', 'zh-CN': '下一次组会的单次备注（未设置时为空）。', 'ja-JP': '次回ミーティングのメモ（未設定時は空文字列）。',
  } },
  { name: 'nextSessionNotes', type: '() => string', descriptions: {
    en: 'Next meeting note. Use {{ nextSessionNotes() }}.', 'zh-CN': '求值获得下一次组会的当次备注：{{ nextSessionNotes() }}。', 'ja-JP': '次回のメモ。使用例: {{ nextSessionNotes() }}。',
  } },
  {
    name: 'recipient',
    type: 'string',
    descriptions: {
      en: 'Recipient email address.',
      'zh-CN': '收件人邮箱地址。',
      'ja-JP': '受信者メールアドレス。',
    },
  },
  {
    name: 'configId',
    type: 'string',
    descriptions: {
      en: 'Schedule config identifier.',
      'zh-CN': '排班配置标识。',
      'ja-JP': 'スケジュール設定の識別子。',
    },
  },
  {
    name: 'taskId',
    type: 'string',
    descriptions: {
      en: 'Email task identifier (server run).',
      'zh-CN': '邮件任务 ID（服务端执行时）。',
      'ja-JP': 'メールタスク ID（サーバー実行時）。',
    },
  },
  {
    name: 'now',
    type: 'string',
    descriptions: {
      en: 'Current timestamp (ISO).',
      'zh-CN': '当前时间戳（ISO）。',
      'ja-JP': '現在時刻（ISO）。',
    },
  },
  {
    name: 'sessionCount',
    type: 'number',
    descriptions: {
      en: 'Number of sessions in current schedule.',
      'zh-CN': '当前排班中的组会总数。',
      'ja-JP': '現在のスケジュール内の回数。',
    },
  },
  {
    name: 'summary',
    type: 'string',
    descriptions: {
      en: 'Summary sentence for this notification.',
      'zh-CN': '本次通知的摘要文本。',
      'ja-JP': '通知用のサマリ文章。',
    },
  },
  {
    name: 'latestCreatedAt',
    type: 'number|null',
    descriptions: {
      en: 'Latest schedule creation timestamp when available.',
      'zh-CN': '最近一次排班创建时间戳（若存在）。',
      'ja-JP': '最新スケジュール作成時刻（存在する場合）。',
    },
  },
  {
    name: 'language',
    type: 'string',
    descriptions: {
      en: 'Template language code for injected text.',
      'zh-CN': '模板注入文本使用的语言代码。',
      'ja-JP': '注入テキストに使う言語コード。',
    },
  },
  {
    name: 'scheduleIcsUrl',
    type: 'string|undefined',
    descriptions: {
      en: 'Public ICS URL for this task when enabled on server and task metadata.',
      'zh-CN': '当服务端和任务开关都启用时可用的公开 ICS 链接。',
      'ja-JP': 'サーバー設定とタスク設定が有効な場合に使える公開 ICS URL。',
    },
  },
  {
    name: 'scheduleSemesterTableHtml',
    type: 'string(html)',
    descriptions: {
      en: 'HTML table for full semester schedule.',
      'zh-CN': '整个学期的 HTML 表格。',
      'ja-JP': '学期全体の HTML テーブル。',
    },
  },
  {
    name: 'scheduleSemesterTableMarkdown',
    type: 'string(markdown)',
    descriptions: {
      en: 'Markdown table for full semester schedule.',
      'zh-CN': '整个学期的 Markdown 表格。',
      'ja-JP': '学期全体の Markdown テーブル。',
    },
  },
  {
    name: 'scheduleSemesterBulletedListMarkdown',
    type: 'string(markdown)',
    descriptions: {
      en: 'Markdown bulleted list for full semester schedule.',
      'zh-CN': '整个学期的 Markdown 项目符号列表。',
      'ja-JP': '学期全体の Markdown 箇条書き。',
    },
  },
  {
    name: 'scheduleWeekTableMarkdown',
    type: 'string(markdown)',
    descriptions: {
      en: 'Markdown table for one-week window schedule.',
      'zh-CN': '一周窗口的 Markdown 表格。',
      'ja-JP': '1週間ウィンドウの Markdown テーブル。',
    },
  },
  {
    name: 'scheduleMonthTableMarkdown',
    type: 'string(markdown)',
    descriptions: {
      en: 'Markdown table for one-month window schedule.',
      'zh-CN': '一个月窗口的 Markdown 表格。',
      'ja-JP': '1か月ウィンドウの Markdown テーブル。',
    },
  },
  {
    name: 'scheduleQuarterTableMarkdown',
    type: 'string(markdown)',
    descriptions: {
      en: 'Markdown table for one-quarter window schedule.',
      'zh-CN': '一个季度窗口的 Markdown 表格。',
      'ja-JP': '1四半期ウィンドウの Markdown テーブル。',
    },
  },
  {
    name: 'scheduleOnceTableMarkdown',
    type: 'string(markdown)',
    descriptions: {
      en: 'Markdown table for a single next schedule occurrence.',
      'zh-CN': '单次排班（下一次）的 Markdown 表格。',
      'ja-JP': '単発（次回1回分）の Markdown テーブル。',
    },
  },
  {
    name: 'scheduleRowsJson',
    type: 'string(json)',
    descriptions: {
      en: 'JSON array of rendered schedule rows.',
      'zh-CN': '已渲染排班行的 JSON 数组。',
      'ja-JP': 'レンダリング済み行の JSON 配列。',
    },
  },
  {
    name: 'scheduleNextSessionDateText',
    type: 'string',
    descriptions: {
      en: 'Human-friendly date for the next scheduled session.',
      'zh-CN': '下一次组会的人类友好日期文本。',
      'ja-JP': '次回セッションの日付（人間向け表示）。',
    },
  },
  {
    name: 'scheduleNextSessionTimeText',
    type: 'string',
    descriptions: {
      en: 'Human-friendly time range for the next scheduled session.',
      'zh-CN': '下一次组会的人类友好时间范围文本。',
      'ja-JP': '次回セッションの時間帯（人間向け表示）。',
    },
  },
  {
    name: 'scheduleNextSessionDateTimeText',
    type: 'string',
    descriptions: {
      en: 'Combined human-friendly date and time for the next session.',
      'zh-CN': '下一次组会的人类友好日期+时间文本。',
      'ja-JP': '次回セッションの日時（人間向け表示）。',
    },
  },
  {
    name: 'nextSessionDateText',
    type: '() => string',
    descriptions: {
      en: 'Function form of next session date text. Use as {{ nextSessionDateText() }}.',
      'zh-CN': '函数形式的下一次组会日期。用法：{{ nextSessionDateText() }}。',
      'ja-JP': '次回セッション日付の関数形式。使用例: {{ nextSessionDateText() }}。',
    },
  },
  {
    name: 'nextSessionTimeText',
    type: '() => string',
    descriptions: {
      en: 'Function form of next session time text. Use as {{ nextSessionTimeText() }}.',
      'zh-CN': '函数形式的下一次组会时间。用法：{{ nextSessionTimeText() }}。',
      'ja-JP': '次回セッション時間の関数形式。使用例: {{ nextSessionTimeText() }}。',
    },
  },
  {
    name: 'nextSessionDateTimeText',
    type: '() => string',
    descriptions: {
      en: 'Function form of next session date+time text. Use as {{ nextSessionDateTimeText() }}.',
      'zh-CN': '函数形式的下一次组会日期+时间。用法：{{ nextSessionDateTimeText() }}。',
      'ja-JP': '次回セッション日時の関数形式。使用例: {{ nextSessionDateTimeText() }}。',
    },
  },
];
