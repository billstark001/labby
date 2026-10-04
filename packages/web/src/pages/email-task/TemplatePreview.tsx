import type { TemplateRenderError } from '@labby/core';
import * as s from '@/styles/components.css';

export function TemplateErrors({ errors }: { errors: TemplateRenderError[] }) {
  if (errors.length === 0) return null;
  return <div class={s.textDanger}>
    {errors.map((error) => (
      <div key={`${error.start}-${error.end}-${error.message}`}>{error.kind}: {error.message}</div>
    ))}
  </div>;
}

export function EmailPreviewContent({ html }: { html: string }) {
  return <div class={s.card}>
    <div dangerouslySetInnerHTML={{ __html: html }} />
  </div>;
}
