export interface DefaultTemplatePreset {
  id: string;
  name: string;
  format: 'markdown' | 'html';
  content: string;
}

export const DEFAULT_TEMPLATE_PRESETS: DefaultTemplatePreset[] = [
  {
    id: 'mail-markdown-basic',
    name: 'Basic Markdown Mail',
    format: 'markdown',
    content: [
      '# Weekly Schedule Update',
      '',
      'Hi {{ recipient }},',
      '',
      '- Config: {{ configId }}',
      '- Time: {{ now }}',
      '- Sessions: {{ sessionCount }}',
      '',
      '{{ summary }}',
    ].join('\n'),
  },
  {
    id: 'mail-html-modern',
    name: 'Modern HTML Mail',
    format: 'html',
    content: [
      '<section style="font-family:Segoe UI,Arial,sans-serif;padding:20px;background:#f5f8ff;">',
      '  <article style="max-width:680px;margin:0 auto;background:#fff;border-radius:12px;padding:24px;border:1px solid #dbe5ff;">',
      '    <h2 style="margin:0 0 12px 0;color:#1a2f6b;">Labby Weekly Update</h2>',
      '    <p style="margin:0 0 8px 0;color:#334155;">Hi {{ recipient }},</p>',
      '    <p style="margin:0 0 8px 0;color:#334155;">Config: <strong>{{ configId }}</strong></p>',
      '    <p style="margin:0 0 8px 0;color:#334155;">Generated at: {{ now }}</p>',
      '    <p style="margin:0 0 8px 0;color:#334155;">Sessions: {{ sessionCount }}</p>',
      '    <p style="margin:12px 0 0 0;color:#0f172a;">{{ summary }}</p>',
      '  </article>',
      '</section>',
    ].join('\n'),
  },
  {
    id: 'manual-next-email',
    name: 'Manual Next Email Copy',
    format: 'markdown',
    content: [
      'To: {{ recipient }}',
      'Subject: [Labby] Next Schedule Reminder {{ configId }}',
      '',
      'Hi, this is your next reminder.',
      '',
      '{{ summary }}',
      '',
      'Sent at {{ now }}',
    ].join('\n'),
  },
];
