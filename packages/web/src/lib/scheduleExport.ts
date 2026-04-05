import type { SchedulePlan, Person, ScheduleConfig } from '@labby/core';
import {
  buildScheduleCsvText as buildScheduleCsvTextCore,
  buildScheduleIcs as buildScheduleIcsCore,
  buildSchedulePlainText as buildSchedulePlainTextCore,
  buildScheduleRows as buildScheduleRowsCore,
  buildScheduleTableHtml as buildScheduleTableHtmlCore,
} from '@labby/core';

function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export { buildScheduleRows } from '@labby/core';

export function buildScheduleHtml(
  plan: SchedulePlan,
  personMap: Map<string, Person>,
  displayName: (person: Person) => string,
  headerLabels = { date: 'Date', presenter: 'Presenter', questioners: 'Questioners' },
) {
  const rows = buildScheduleRowsCore(plan, personMap, displayName);
  return buildScheduleTableHtmlCore(rows, headerLabels);
}

export function buildSchedulePlainText(
  plan: SchedulePlan,
  personMap: Map<string, Person>,
  displayName: (person: Person) => string,
) {
  return buildSchedulePlainTextCore(buildScheduleRowsCore(plan, personMap, displayName));
}

export function buildScheduleCsvText(
  plan: SchedulePlan,
  personMap: Map<string, Person>,
  displayName: (person: Person) => string,
): string {
  return buildScheduleCsvTextCore(buildScheduleRowsCore(plan, personMap, displayName));
}

export function downloadScheduleHtml(
  plan: SchedulePlan,
  personMap: Map<string, Person>,
  displayName: (person: Person) => string,
  headerLabels?: { date: string; presenter: string; questioners: string },
) {
  const html = buildScheduleHtml(plan, personMap, displayName, headerLabels);
  triggerDownload(new Blob([html], { type: 'text/html' }), 'schedule.html');
}

export function downloadScheduleCsv(
  plan: SchedulePlan,
  personMap: Map<string, Person>,
  displayName: (person: Person) => string,
) {
  const csv = buildScheduleCsvTextCore(buildScheduleRowsCore(plan, personMap, displayName));
  triggerDownload(new Blob([csv], { type: 'text/csv' }), 'schedule.csv');
}

export function downloadScheduleIcs(
  plan: SchedulePlan,
  personMap: Map<string, Person>,
  displayName: (person: Person) => string,
  config: ScheduleConfig | undefined,
  labels?: { presenter: string; questioners: string },
) {
  const ics = buildScheduleIcsCore(plan, personMap, displayName, config, labels);
  triggerDownload(new Blob([ics], { type: 'text/calendar' }), 'schedule.ics');
}

export async function copyScheduleTable(
  plan: SchedulePlan,
  personMap: Map<string, Person>,
  displayName: (person: Person) => string,
) {
  const rows = buildScheduleRowsCore(plan, personMap, displayName);
  const html = buildScheduleTableHtmlCore(rows);
  const text = buildSchedulePlainTextCore(rows);

  if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
    const item = new ClipboardItem({
      'text/html': new Blob([html], { type: 'text/html' }),
      'text/plain': new Blob([text], { type: 'text/plain' }),
    });
    await navigator.clipboard.write([item]);
    return;
  }

  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  throw new Error('Clipboard API not available');
}

export async function copyScheduleHtml(
  plan: SchedulePlan,
  personMap: Map<string, Person>,
  displayName: (person: Person) => string,
) {
  // Write the HTML source as plain text so it pastes as readable HTML markup
  const html = buildScheduleTableHtmlCore(buildScheduleRowsCore(plan, personMap, displayName));
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(html);
    return;
  }
  throw new Error('Clipboard API not available');
}

export async function copyScheduleCsv(
  plan: SchedulePlan,
  personMap: Map<string, Person>,
  displayName: (person: Person) => string,
) {
  const csv = buildScheduleCsvTextCore(buildScheduleRowsCore(plan, personMap, displayName));
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(csv);
    return;
  }
  throw new Error('Clipboard API not available');
}
