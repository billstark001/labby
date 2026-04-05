import type { Person, ScheduleConfig, SchedulePlan } from '../types.js';

export interface ScheduleTableLabels {
  date: string;
  presenter: string;
  questioners: string;
}

export type ScheduleExportMode = 'semester' | 'window' | 'once';
export type ScheduleWindowUnit = 'week' | 'month' | 'quarter';
export type ScheduleDateGranularity = 'date' | 'date-time' | 'month-day' | 'month-day-time';

export interface ScheduleDateDisplayOptions {
  locale?: string;
  granularity?: ScheduleDateGranularity;
  includeWeekday?: boolean;
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

function parseDate(dateStr: string): Date {
  return new Date(`${dateStr}T00:00:00`);
}

function formatDateLabel(dateIso: string, options: ScheduleDateDisplayOptions = {}, config?: ScheduleConfig): string {
  const locale = normalizeLocale(options.locale);
  const granularity = options.granularity ?? 'date';
  const includeWeekday = options.includeWeekday ?? false;
  const date = parseDate(dateIso);

  const formatOptions: Intl.DateTimeFormatOptions = {
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
    const timeText = config?.timeRange?.join('-') ?? '';
    return timeText ? `${dateText} ${timeText}` : dateText;
  }

  return dateText;
}

function pickSessions(plan: SchedulePlan, options: ScheduleRowBuildOptions = {}): SchedulePlan['sessions'] {
  const mode = options.mode ?? 'semester';
  const sorted = [...plan.sessions].sort((left, right) => left.date.localeCompare(right.date));

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

export function buildScheduleRows(
  plan: SchedulePlan,
  personMap: Map<string, Person>,
  displayName: (person: Person) => string,
  options: ScheduleRowBuildOptions = {},
): ScheduleRow[] {
  const sessions = pickSessions(plan, options);
  return sessions.flatMap((session) =>
    session.presentations.map((presentation) => {
      const presenter = personMap.get(presentation.presenterId);
      const questioners = presentation.questionerIds.map((questionerId) => {
        const person = personMap.get(questionerId);
        return person ? displayName(person) : fallbackEntityId(questionerId);
      });

      return {
        dateIso: session.date,
        dateLabel: formatDateLabel(session.date, options.dateDisplay, options.config),
        presenter: presenter ? displayName(presenter) : fallbackEntityId(presentation.presenterId),
        questioners,
      };
    }),
  );
}

export function buildScheduleTableHtml(rows: ScheduleRow[], labels: ScheduleTableLabels = DEFAULT_TABLE_LABELS): string {
  const body = rows
    .map((row) => `<tr>\n  <td>${escapeHtml(row.dateLabel)}</td>\n  <td>${escapeHtml(row.presenter)}</td>\n  <td>${escapeHtml(row.questioners.join(', '))}</td>\n</tr>`)
    .join('\n');

  return `<table>\n<thead>\n<tr>\n  <th>${escapeHtml(labels.date)}</th>\n  <th>${escapeHtml(labels.presenter)}</th>\n  <th>${escapeHtml(labels.questioners)}</th>\n</tr>\n</thead>\n<tbody>\n${body}\n</tbody>\n</table>`;
}

export function buildScheduleTableMarkdown(rows: ScheduleRow[], labels: ScheduleTableLabels = DEFAULT_TABLE_LABELS): string {
  const header = `| ${escapeMarkdown(labels.date)} | ${escapeMarkdown(labels.presenter)} | ${escapeMarkdown(labels.questioners)} |`;
  const sep = '| --- | --- | --- |';
  const body = rows.map((row) => `| ${escapeMarkdown(row.dateLabel)} | ${escapeMarkdown(row.presenter)} | ${escapeMarkdown(row.questioners.join(', '))} |`);
  return [header, sep, ...body].join('\n');
}

export function buildScheduleBulletListMarkdown(rows: ScheduleRow[]): string {
  if (rows.length === 0) return '- (no sessions)';
  return rows
    .map((row) => `- ${escapeMarkdown(row.dateLabel)}\n  - presenter: ${escapeMarkdown(row.presenter)}\n  - questioners: ${escapeMarkdown(row.questioners.join(', '))}`)
    .join('\n');
}

export function buildSchedulePlainText(rows: ScheduleRow[]): string {
  const lines = rows.map((row) => `${row.dateLabel}\t${row.presenter}\t${row.questioners.join(', ')}`);
  return ['Date\tPresenter\tQuestioners', ...lines].join('\n');
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

/** Pad a number to at least 2 digits. */
function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** Format a date + time as iCalendar DATE-TIME. */
function icsDateTime(dateStr: string, timeStr: string): string {
  const [year, month, day] = dateStr.split('-').map(Number);
  const [hour, minute] = timeStr.split(':').map(Number);
  return `${year}${pad2(month)}${pad2(day)}T${pad2(hour)}${pad2(minute)}00`;
}

export function buildScheduleIcs(
  plan: SchedulePlan,
  personMap: Map<string, Person>,
  displayName: (person: Person) => string,
  config: ScheduleConfig | undefined,
  labels = { presenter: 'Presenter', questioners: 'Questioners' },
): string {
  const startTime = config?.timeRange[0] ?? '09:00';
  const endTime = config?.timeRange[1] ?? '10:00';

  const events: string[] = [];
  for (const session of plan.sessions) {
    for (const pres of session.presentations) {
      const presenter = personMap.get(pres.presenterId);
      const presenterName = presenter ? displayName(presenter) : fallbackEntityId(pres.presenterId);
      const questionerNames = pres.questionerIds.map((qid) => {
        const q = personMap.get(qid);
        return q ? displayName(q) : fallbackEntityId(qid);
      });

      const dtStart = icsDateTime(session.date, startTime);
      const dtEnd = icsDateTime(session.date, endTime);
      const uid = `labby-${plan.id}-${pres.presenterId}-${session.date}@labby`;
      const summary = `${labels.presenter}: ${presenterName}`;
      const description = questionerNames.length > 0 ? `${labels.questioners}: ${questionerNames.join(', ')}` : '';

      events.push([
        'BEGIN:VEVENT',
        `UID:${uid}`,
        `DTSTART:${dtStart}`,
        `DTEND:${dtEnd}`,
        `SUMMARY:${summary}`,
        description ? `DESCRIPTION:${description}` : '',
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
    ...events,
    'END:VCALENDAR',
  ].join('\r\n');
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
    scheduleRowsJson: '[]',
  };
}

export function buildEmailTemplateScheduleVariables(
  options: BuildEmailTemplateScheduleVariablesOptions,
): Record<string, unknown> {
  const plan = options.plan;
  if (!plan) return emptyVariables();

  const locale = normalizeLocale(options.locale);
  const personMap = options.personMap ?? new Map((options.persons ?? []).map((person) => [person.id, person]));
  const displayName = options.displayName ?? ((person: Person) => defaultDisplayName(person, locale));
  const labels: ScheduleTableLabels = {
    ...DEFAULT_TABLE_LABELS,
    ...(options.labels ?? {}),
  };

  const common = {
    config: options.config,
    anchorDate: options.anchorDate,
    dateDisplay: {
      locale,
      granularity: options.granularity,
      includeWeekday: options.includeWeekday,
    } satisfies ScheduleDateDisplayOptions,
  };

  const semester = buildScheduleTemplateBlocks(plan, personMap, displayName, {
    ...common,
    mode: 'semester',
  }, labels);

  const week = buildScheduleTemplateBlocks(plan, personMap, displayName, {
    ...common,
    mode: 'window',
    windowUnit: 'week',
    windowCount: 1,
  }, labels);

  const month = buildScheduleTemplateBlocks(plan, personMap, displayName, {
    ...common,
    mode: 'window',
    windowUnit: 'month',
    windowCount: 1,
  }, labels);

  const quarter = buildScheduleTemplateBlocks(plan, personMap, displayName, {
    ...common,
    mode: 'window',
    windowUnit: 'quarter',
    windowCount: 1,
  }, labels);

  const once = buildScheduleTemplateBlocks(plan, personMap, displayName, {
    ...common,
    mode: 'once',
  }, labels);

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
    scheduleRowsJson: JSON.stringify(semester.rows),
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
];
