import { resolveSessionTimeRange, type SessionTimeRange } from '../schedule/session.js';
import { pickSessions, resolveScheduleTimeZone, scheduleLocalInstant, type ScheduleSelectionOptions, type ScheduleSelectionUnit } from '../schedule/selection.js';
import type { Person, ScheduleConfig, SchedulePlan, Session } from '../types.js';
import { getEnvironmentTimeZone, getTimeZoneOffsetMinutes, normalizeTimeZone } from '../timezone.js';
import { renderTemplate } from './renderer.js';
import { escapeHtml, registerHtmlFunction } from './html-functions.js';

export interface ScheduleTableLabels {
  date: string;
  presenter: string;
  questioners: string;
}

export type ScheduleDateGranularity = 'date' | 'date-time' | 'month-day' | 'month-day-time';
export type ScheduleIcsMode = 'presenters' | 'meeting';

export interface ScheduleDateDisplayOptions {
  locale?: string;
  granularity?: ScheduleDateGranularity;
  includeWeekday?: boolean;
  timeZone?: string;
}

export interface ScheduleRowBuildOptions extends ScheduleSelectionOptions {
  dateDisplay?: ScheduleDateDisplayOptions;
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
  anchorTime?: number;
  labels?: Partial<ScheduleTableLabels>;
  displayName?: (person: Person) => string;
  /** Resolved schedule timezone; the email dispatch timezone does not format meetings. */
  timeZone?: string;
}

interface NextSessionSummary {
  date: string;
  time: string;
  dateTime: string;
  notes: string;
}

const DEFAULT_TABLE_LABELS: ScheduleTableLabels = {
  date: 'Date',
  presenter: 'Presenter',
  questioners: 'Questioners',
};

function fallbackEntityId(id?: string): string {
  return `ID:${id ?? '<empty>'}`;
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

function buildNextSessionSummary(
  plan: SchedulePlan,
  options: BuildEmailTemplateScheduleVariablesOptions,
): NextSessionSummary {
  const locale = normalizeLocale(options.locale);
  const next = pickSessions(plan, { ...options, unit: 'session', amount: 1 })[0];
  if (!next) {
    return {
      date: '',
      time: '',
      dateTime: '',
      notes: '',
    };
  }

  const dateText = formatDateLabel(next.date, {
    locale,
    granularity: options.granularity === 'month-day' || options.granularity === 'month-day-time' ? 'month-day' : 'date',
    includeWeekday: options.includeWeekday ?? true,
    timeZone: resolveScheduleTimeZone(options),
  }, options.config?.timeRange);
  const timeText = formatTimeRangeLabel(resolveSessionTimeRange(next, options.config), locale);

  return {
    date: dateText,
    time: timeText,
    dateTime: `${dateText} ${timeText}`.trim(),
    notes: next.notes ?? '',
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
    const meetingStart = scheduleLocalInstant(session.date, startTime, timeZone);
    const meetingEnd = scheduleLocalInstant(endDate, endTime, timeZone);
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

function buildPersonMap(persons: Person[]): Map<string, Person> {
  const result = new Map<string, Person>();
  for (const person of persons) result.set(person.id, person);
  return result;
}

export interface EmailTemplateScheduleVariables extends Record<string, unknown> {
  schedule: {
    tableHtml: (unit?: ScheduleSelectionUnit, amount?: number) => string;
    tableMarkdown: (unit?: ScheduleSelectionUnit, amount?: number) => string;
    bulletedListMarkdown: (unit?: ScheduleSelectionUnit, amount?: number) => string;
    json: (unit?: ScheduleSelectionUnit, amount?: number) => string;
  };
  nextSession: NextSessionSummary;
}

export function buildEmailTemplateScheduleVariables(
  options: BuildEmailTemplateScheduleVariablesOptions,
): EmailTemplateScheduleVariables {
  // One timestamp per context keeps all formats and nextSession in agreement.
  const anchorTime = options.anchorTime ?? Date.now();
  const plan = options.plan ?? { id: '', configId: '', createdAt: anchorTime, sessions: [] };
  const locale = normalizeLocale(options.locale);
  const personMap = options.personMap ?? buildPersonMap(options.persons ?? []);
  const displayName = options.displayName ?? ((person: Person) => defaultDisplayName(person, locale));
  const labels: ScheduleTableLabels = {
    date: options.labels?.date ?? DEFAULT_TABLE_LABELS.date,
    presenter: options.labels?.presenter ?? DEFAULT_TABLE_LABELS.presenter,
    questioners: options.labels?.questioners ?? DEFAULT_TABLE_LABELS.questioners,
  };
  const buildRows = (unit: ScheduleSelectionUnit = 'semester', amount = 1): ScheduleRow[] => buildScheduleRows(
    plan, personMap, displayName, {
      unit, amount, anchorTime, config: options.config, timeZone: options.timeZone,
      dateDisplay: { locale, granularity: options.granularity, includeWeekday: options.includeWeekday,
        timeZone: resolveScheduleTimeZone(options) },
    },
  );
  return {
    schedule: {
      tableHtml: registerHtmlFunction((unit: ScheduleSelectionUnit = 'semester', amount = 1) => buildScheduleTableHtml(buildRows(unit, amount), labels)),
      tableMarkdown: (unit = 'semester', amount = 1) => buildScheduleTableMarkdown(buildRows(unit, amount), labels),
      bulletedListMarkdown: (unit = 'semester', amount = 1) => buildScheduleBulletListMarkdown(buildRows(unit, amount)),
      json: (unit = 'semester', amount = 1) => JSON.stringify(buildRows(unit, amount)),
    },
    nextSession: buildNextSessionSummary(plan, { ...options, anchorTime }),
  };
}

export const EMAIL_TEMPLATE_VARIABLE_DOCS: EmailTemplateVariableDoc[] = [
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
  { name: 'schedule', type: 'object', descriptions: {
    en: 'Schedule exports. semester(s) includes the whole plan; session(s), week(s), month(s), quarter(s) select upcoming meeting starts. All functions default to ("semester", 1); amount is a positive integer.',
    'zh-CN': '排班导出。semester(s) 包含整个排班；session(s)、week(s)、month(s)、quarter(s) 按开始时间选择接下来的组会。所有函数默认参数为 ("semester", 1)，amount 为正整数。',
    'ja-JP': 'スケジュール出力。semester(s) は全予定、session(s)、week(s)、month(s)、quarter(s) は今後の開始時刻を選択。既定引数は ("semester", 1)、amount は正の整数。',
  } },
  ...[
    ['tableHtml', 'HTML', 'HTML', 'HTML'],
    ['tableMarkdown', 'Markdown table', 'Markdown 表格', 'Markdown テーブル'],
    ['bulletedListMarkdown', 'Markdown bulleted list', 'Markdown 项目符号列表', 'Markdown 箇条書き'],
    ['json', 'JSON row array', 'JSON 排班行数组', 'JSON 行配列'],
  ].map(([name, en, zh, ja]) => ({ name: `schedule.${name}`, type: '(unit = "semester", amount = 1) => string', descriptions: {
    en: `${en}. Example: {{ schedule.${name}("sessions", 2) }}.`,
    'zh-CN': `${zh}。示例：{{ schedule.${name}("sessions", 2) }}。`,
    'ja-JP': `${ja}。例: {{ schedule.${name}("sessions", 2) }}。`,
  } })),
  { name: 'nextSession', type: 'object', descriptions: {
    en: 'Next meeting whose start has not passed in the schedule timezone; all fields are empty when none remains.',
    'zh-CN': '按排班时区筛选尚未开始的下一次组会；没有未来组会时，所有字段为空。',
    'ja-JP': 'スケジュールのタイムゾーンで開始時刻を過ぎていない次回。残りの予定がない場合は全項目が空文字列。',
  } },
  { name: 'nextSession.date', type: 'string', descriptions: {
    en: 'Formatted meeting date.', 'zh-CN': '格式化后的组会日期。', 'ja-JP': '整形済み日付。',
  } },
  { name: 'nextSession.time', type: 'string', descriptions: {
    en: 'Meeting time range (24-hour clock).', 'zh-CN': '组会时间范围（24 小时制）。', 'ja-JP': '時間帯（24時間制）。',
  } },
  { name: 'nextSession.dateTime', type: 'string', descriptions: {
    en: 'Formatted meeting date and time range.', 'zh-CN': '格式化后的组会日期及时间范围。', 'ja-JP': '整形済み日時。',
  } },
  { name: 'nextSession.notes', type: 'string', descriptions: {
    en: 'Meeting note; empty when unset.', 'zh-CN': '当次组会备注，未设置时为空。', 'ja-JP': '次回のメモ（未設定時は空文字列）。',
  } },
];
