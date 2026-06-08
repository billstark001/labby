export {
  parseTemplate,
  compileTemplate,
  type CompiledTemplate,
  type CompiledTemplateRenderOptions,
  type CompileTemplateOptions,
  type TemplateSegment,
  type TemplateParseResult,
  type TemplateParseOptions,
  type TemplateExpressionSegment,
  type TemplateTextSegment,
  type TemplateRenderError,
  type TemplateRenderResult,
} from 'pure-expr/template';

export {
  renderTemplate,
  renderTemplateToHtml,
  type RenderTemplateOptions,
  type RenderTemplateHtmlResult,
} from './renderer.js';

export {
  DEFAULT_TEMPLATE_PRESETS,
  type DefaultTemplatePreset,
} from './defaults.js';

export {
  EMAIL_TEMPLATE_VARIABLE_DOCS,
  buildEmailTemplateScheduleVariables,
  buildScheduleRows,
  buildScheduleTableHtml,
  buildScheduleTableMarkdown,
  buildScheduleBulletListMarkdown,
  buildSchedulePlainText,
  buildScheduleCsvText,
  buildScheduleIcs,
  buildScheduleTemplateBlocks,
  type EmailTemplateVariableDoc,
  type BuildEmailTemplateScheduleVariablesOptions,
  type ScheduleTemplateBlocks,
  type ScheduleRow,
  type ScheduleDateDisplayOptions,
  type ScheduleDateGranularity,
  type ScheduleRowBuildOptions,
  type ScheduleTableLabels,
  type ScheduleExportMode,
  type ScheduleWindowUnit,
} from './schedule-render.js';
