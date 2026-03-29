/** Supported locale codes. */
export type Locale = 'zh' | 'en' | 'ja';

/** All UI string keys. */
export interface UIStrings {
  appTitle: string;
  navPersons: string;
  navKeywords: string;
  navSchedule: string;
  navGraph: string;
  navSettings: string;
  addPerson: string;
  addKeyword: string;
  generateSchedule: string;
  incrementalReschedule: string;
  exportHtml: string;
  exportCsv: string;
  exportBackup: string;
  importBackup: string;
  settingsTitle: string;
  languageLabel: string;
  configTitle: string;
  configDays: string;
  configTime: string;
  configPresenters: string;
  configQuestioners: string;
  configRadius: string;
  configStart: string;
  configEnd: string;
  save: string;
  cancel: string;
  delete: string;
  edit: string;
  name: string;
  keywords: string;
  sessionDate: string;
  presenter: string;
  questioners: string;
  tripletQuestion: string;
  tripletYes: string;
  tripletNo: string;
  attractSelected: string;
  repelSelected: string;
  computing: string;
  noSchedule: string;
  historyTitle: string;
  changeDate: string;
  confirmDelete: string;
}

const zh: UIStrings = {
  appTitle: 'Labby 排班系统',
  navPersons: '人员',
  navKeywords: '关键词',
  navSchedule: '排班表',
  navGraph: '关键词图谱',
  navSettings: '设置',
  addPerson: '添加人员',
  addKeyword: '添加关键词',
  generateSchedule: '生成新排班',
  incrementalReschedule: '增量重排',
  exportHtml: '导出 HTML',
  exportCsv: '导出 CSV',
  exportBackup: '备份数据库',
  importBackup: '导入备份',
  settingsTitle: '设置',
  languageLabel: '语言',
  configTitle: '排班规则',
  configDays: '星期',
  configTime: '时间段',
  configPresenters: '每次发表人数',
  configQuestioners: '每人提问人数',
  configRadius: '目标相似度',
  configStart: '开始日期',
  configEnd: '结束日期',
  save: '保存',
  cancel: '取消',
  delete: '删除',
  edit: '编辑',
  name: '名称',
  keywords: '关键词',
  sessionDate: '日期',
  presenter: '发表人',
  questioners: '提问人',
  tripletQuestion: '相比于"%s"，"%s" 是否与 "%s" 更接近？',
  tripletYes: '是',
  tripletNo: '否',
  attractSelected: '拉近关系',
  repelSelected: '疏远关系',
  computing: '计算中…',
  noSchedule: '尚未生成排班',
  historyTitle: '历史版本',
  changeDate: '变动日期',
  confirmDelete: '确认删除？',
};

const en: UIStrings = {
  appTitle: 'Labby Scheduler',
  navPersons: 'Persons',
  navKeywords: 'Keywords',
  navSchedule: 'Schedule',
  navGraph: 'Keyword Graph',
  navSettings: 'Settings',
  addPerson: 'Add Person',
  addKeyword: 'Add Keyword',
  generateSchedule: 'Generate Schedule',
  incrementalReschedule: 'Incremental Reschedule',
  exportHtml: 'Export HTML',
  exportCsv: 'Export CSV',
  exportBackup: 'Backup Database',
  importBackup: 'Import Backup',
  settingsTitle: 'Settings',
  languageLabel: 'Language',
  configTitle: 'Schedule Config',
  configDays: 'Days of Week',
  configTime: 'Time Range',
  configPresenters: 'Presenters / Session',
  configQuestioners: 'Questioners / Presenter',
  configRadius: 'Target Similarity',
  configStart: 'Start Date',
  configEnd: 'End Date',
  save: 'Save',
  cancel: 'Cancel',
  delete: 'Delete',
  edit: 'Edit',
  name: 'Name',
  keywords: 'Keywords',
  sessionDate: 'Date',
  presenter: 'Presenter',
  questioners: 'Questioners',
  tripletQuestion: 'Is "%s" more similar to "%s" than to "%s"?',
  tripletYes: 'Yes',
  tripletNo: 'No',
  attractSelected: 'Pull Closer',
  repelSelected: 'Push Apart',
  computing: 'Computing…',
  noSchedule: 'No schedule generated yet',
  historyTitle: 'History',
  changeDate: 'Change Date',
  confirmDelete: 'Confirm delete?',
};

const ja: UIStrings = {
  appTitle: 'Labby スケジューラ',
  navPersons: '参加者',
  navKeywords: 'キーワード',
  navSchedule: 'スケジュール',
  navGraph: 'キーワードグラフ',
  navSettings: '設定',
  addPerson: '参加者を追加',
  addKeyword: 'キーワードを追加',
  generateSchedule: 'スケジュール生成',
  incrementalReschedule: '差分再スケジュール',
  exportHtml: 'HTML エクスポート',
  exportCsv: 'CSV エクスポート',
  exportBackup: 'DBバックアップ',
  importBackup: 'バックアップ読込',
  settingsTitle: '設定',
  languageLabel: '言語',
  configTitle: '設定ルール',
  configDays: '曜日',
  configTime: '時間帯',
  configPresenters: '発表者数/回',
  configQuestioners: '質問者数/発表',
  configRadius: '目標類似度',
  configStart: '開始日',
  configEnd: '終了日',
  save: '保存',
  cancel: 'キャンセル',
  delete: '削除',
  edit: '編集',
  name: '名前',
  keywords: 'キーワード',
  sessionDate: '日付',
  presenter: '発表者',
  questioners: '質問者',
  tripletQuestion: '"%s" は "%s" よりも "%s" に近いですか？',
  tripletYes: 'はい',
  tripletNo: 'いいえ',
  attractSelected: '近づける',
  repelSelected: '遠ざける',
  computing: '計算中…',
  noSchedule: 'スケジュールがまだありません',
  historyTitle: '履歴',
  changeDate: '変更日',
  confirmDelete: '削除しますか？',
};

export const translations: Record<Locale, UIStrings> = { zh, en, ja };

/** Format a string with positional %s placeholders. */
export function format(template: string, ...args: string[]): string {
  let i = 0;
  return template.replace(/%s/g, () => args[i++] ?? '');
}
