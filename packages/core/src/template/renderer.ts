import { JSEvalError, JSLexError, JSParseError, evaluate } from '../expr/index.js';
import { marked } from 'marked';
import type {
  TemplateFormat,
  TemplateRenderError,
  TemplateRenderResult,
} from '../types.js';
import { parseTemplate } from './parser.js';

export interface RenderTemplateOptions {
  format?: TemplateFormat;
  /** When true, stop on first evaluation error. */
  strict?: boolean;
}

export interface RenderTemplateHtmlResult extends TemplateRenderResult {
  html: string;
}

const MARKDOWN_EMAIL_CSS = [
  '.labby-md-mail{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,"Noto Sans",sans-serif;line-height:1.65;color:#0f172a;background:#ffffff;margin:0;padding:0;}',
  '.labby-md-mail h1,.labby-md-mail h2,.labby-md-mail h3,.labby-md-mail h4{margin:0 0 12px;color:#0b1324;line-height:1.3;}',
  '.labby-md-mail h1{font-size:24px;}.labby-md-mail h2{font-size:20px;}.labby-md-mail h3{font-size:17px;}.labby-md-mail h4{font-size:15px;}',
  '.labby-md-mail p{margin:0 0 12px;}',
  '.labby-md-mail a{color:#1668dc;text-decoration:underline;}',
  '.labby-md-mail ul,.labby-md-mail ol{margin:0 0 12px;padding-left:22px;}',
  '.labby-md-mail li{margin:0 0 6px;}',
  '.labby-md-mail blockquote{margin:0 0 12px;padding:10px 12px;border-left:3px solid #bfdbfe;background:#f8fbff;color:#334155;}',
  '.labby-md-mail code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace;font-size:12px;background:#f1f5f9;border:1px solid #e2e8f0;border-radius:4px;padding:1px 5px;}',
  '.labby-md-mail pre{margin:0 0 12px;padding:10px 12px;background:#0f172a;color:#e2e8f0;border-radius:8px;overflow:auto;}',
  '.labby-md-mail pre code{background:transparent;border:0;color:inherit;padding:0;}',
  '.labby-md-mail hr{border:0;border-top:1px solid #e2e8f0;margin:16px 0;}',
  '.labby-md-mail table{width:100%;border-collapse:collapse;margin:12px 0;}',
  '.labby-md-mail th,.labby-md-mail td{border:1px solid #dbe3ee;padding:8px 10px;text-align:left;vertical-align:top;font-size:13px;}',
  '.labby-md-mail th{background:#f8fafc;color:#0f172a;font-weight:600;}',
  '.labby-md-mail tbody tr:nth-child(even){background:#fcfdff;}',
].join('');

function wrapMarkdownHtml(html: string): string {
  return `<style>${MARKDOWN_EMAIL_CSS}</style><div class="labby-md-mail">${html}</div>`;
}

function classifyError(error: unknown): TemplateRenderError['kind'] {
  if (error instanceof JSLexError) return 'lex';
  if (error instanceof JSParseError) return 'parse';
  if (error instanceof JSEvalError) return 'eval';
  return 'template';
}

function toStringValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  return String(value);
}

function escapeHtml(raw: string): string {
  return raw
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function renderTemplate(
  source: string,
  context: Record<string, unknown>,
  options: RenderTemplateOptions = {},
): TemplateRenderResult {
  const parsed = parseTemplate(source);
  const errors = [...parsed.errors];
  const out: string[] = [];
  const isHtml = options.format === 'html';

  for (const segment of parsed.segments) {
    if (segment.type === 'text') {
      out.push(segment.value);
      continue;
    }

    try {
      const value = evaluate(segment.expr, context);
      const text = toStringValue(value);
      out.push(isHtml ? escapeHtml(text) : text);
    } catch (error) {
      errors.push({
        expression: segment.expr,
        message: error instanceof Error ? error.message : 'unknown template error',
        start: segment.start,
        end: segment.end,
        kind: classifyError(error),
      });
      if (options.strict) {
        break;
      }
    }
  }

  return {
    output: out.join(''),
    errors,
  };
}

export function renderTemplateToHtml(
  source: string,
  context: Record<string, unknown>,
  options: RenderTemplateOptions = {},
): RenderTemplateHtmlResult {
  const rendered = renderTemplate(source, context, options);
  if (options.format === 'html') {
    return {
      ...rendered,
      html: rendered.output,
    };
  }

  const markdownHtml = marked.parse(rendered.output, { async: false });

  return {
    ...rendered,
    html: wrapMarkdownHtml(markdownHtml),
  };
}
