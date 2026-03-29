import Papa from 'papaparse';
import type { SchedulePlan, Person } from '@labby/core';

function fallbackEntityId(id?: string): string {
  return `ID:${id ?? '<empty>'}`;
}

function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function buildScheduleRows(
  plan: SchedulePlan,
  personMap: Map<string, Person>,
  displayName: (person: Person) => string,
) {
  return plan.sessions.flatMap(session =>
    session.presentations.map(presentation => {
      const presenter = personMap.get(presentation.presenterId);
      const questioners = presentation.questionerIds.map(questionerId => {
        const person = personMap.get(questionerId);
        return person ? displayName(person) : fallbackEntityId(questionerId);
      });

      return {
        date: session.date,
        presenter: presenter ? displayName(presenter) : fallbackEntityId(presentation.presenterId),
        questioners,
      };
    }),
  );
}

export function buildScheduleHtml(
  plan: SchedulePlan,
  personMap: Map<string, Person>,
  displayName: (person: Person) => string,
) {
  const rows = buildScheduleRows(plan, personMap, displayName)
    .map(
      row => `<tr>
  <td>${escapeHtml(row.date)}</td>
  <td>${escapeHtml(row.presenter)}</td>
  <td>${escapeHtml(row.questioners.join(', '))}</td>
</tr>`,
    )
    .join('\n');

  return `<table>
<thead>
<tr>
  <th>Date</th>
  <th>Presenter</th>
  <th>Questioners</th>
</tr>
</thead>
<tbody>
${rows}
</tbody>
</table>`;
}

export function buildSchedulePlainText(
  plan: SchedulePlan,
  personMap: Map<string, Person>,
  displayName: (person: Person) => string,
) {
  const lines = buildScheduleRows(plan, personMap, displayName).map(
    row => `${row.date}\t${row.presenter}\t${row.questioners.join(', ')}`,
  );
  return ['Date\tPresenter\tQuestioners', ...lines].join('\n');
}

export function downloadScheduleHtml(
  plan: SchedulePlan,
  personMap: Map<string, Person>,
  displayName: (person: Person) => string,
) {
  const html = buildScheduleHtml(plan, personMap, displayName);
  triggerDownload(new Blob([html], { type: 'text/html' }), 'schedule.html');
}

export function downloadScheduleCsv(
  plan: SchedulePlan,
  personMap: Map<string, Person>,
  displayName: (person: Person) => string,
) {
  const rows = buildScheduleRows(plan, personMap, displayName).map(row => ({
    date: row.date,
    presenter: row.presenter,
    questioners: row.questioners.join('; '),
  }));
  const csv = Papa.unparse(rows);
  triggerDownload(new Blob([csv], { type: 'text/csv' }), 'schedule.csv');
}

export async function copyScheduleTable(
  plan: SchedulePlan,
  personMap: Map<string, Person>,
  displayName: (person: Person) => string,
) {
  const html = buildScheduleHtml(plan, personMap, displayName);
  const text = buildSchedulePlainText(plan, personMap, displayName);

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
