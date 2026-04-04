export {
  parseTemplate,
  type TemplateSegment,
  type TemplateParseResult,
  type TemplateExpressionSegment,
  type TemplateTextSegment,
} from './parser.js';

export {
  renderTemplate,
  type RenderTemplateOptions,
} from './renderer.js';

export {
  DEFAULT_TEMPLATE_PRESETS,
  type DefaultTemplatePreset,
} from './defaults.js';
