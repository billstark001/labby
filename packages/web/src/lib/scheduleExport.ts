import Papa from 'papaparse';
import type { SchedulePlan, Person, ScheduleConfig } from '@labby/core';

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
  headerLabels = { date: 'Date', presenter: 'Presenter', questioners: 'Questioners' },
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
  <th>${escapeHtml(headerLabels.date)}</th>
  <th>${escapeHtml(headerLabels.presenter)}</th>
  <th>${escapeHtml(headerLabels.questioners)}</th>
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

export function buildScheduleCsvText(
  plan: SchedulePlan,
  personMap: Map<string, Person>,
  displayName: (person: Person) => string,
): string {
  const rows = buildScheduleRows(plan, personMap, displayName).map(row => ({
    date: row.date,
    presenter: row.presenter,
    questioners: row.questioners.join('; '),
  }));
  return Papa.unparse(rows);
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
  const csv = buildScheduleCsvText(plan, personMap, displayName);
  triggerDownload(new Blob([csv], { type: 'text/csv' }), 'schedule.csv');
}

/** Pad a number to at least 2 digits. */
function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** Format a date + time as iCalendar DATE-TIME (UTC). */
function icsDateTime(dateStr: string, timeStr: string): string {
  // dateStr: "YYYY-MM-DD", timeStr: "HH:MM"
  const [year, month, day] = dateStr.split('-').map(Number);
  const [hour, minute] = timeStr.split(':').map(Number);
  return `${year}${pad2(month)}${pad2(day)}T${pad2(hour)}${pad2(minute)}00`;
}

/** Generate an iCalendar (.ics) file for the schedule. */
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
      const presenterName = presenter
        ? displayName(presenter)
        : fallbackEntityId(pres.presenterId);
      const questionerNames = pres.questionerIds.map(qid => {
        const q = personMap.get(qid);
        return q ? displayName(q) : fallbackEntityId(qid);
      });

      const dtStart = icsDateTime(session.date, startTime);
      const dtEnd = icsDateTime(session.date, endTime);
      const uid = `labby-${plan.id}-${pres.presenterId}-${session.date}@labby`;
      const summary = `${labels.presenter}: ${presenterName}`;
      const description = questionerNames.length > 0
        ? `${labels.questioners}: ${questionerNames.join(', ')}`
        : '';

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

export function downloadScheduleIcs(
  plan: SchedulePlan,
  personMap: Map<string, Person>,
  displayName: (person: Person) => string,
  config: ScheduleConfig | undefined,
  labels?: { presenter: string; questioners: string },
) {
  const ics = buildScheduleIcs(plan, personMap, displayName, config, labels);
  triggerDownload(new Blob([ics], { type: 'text/calendar' }), 'schedule.ics');
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

export async function copyScheduleHtml(
  plan: SchedulePlan,
  personMap: Map<string, Person>,
  displayName: (person: Person) => string,
) {
  // Write the HTML source as plain text so it pastes as readable HTML markup
  const html = buildScheduleHtml(plan, personMap, displayName);
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
  const csv = buildScheduleCsvText(plan, personMap, displayName);
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(csv);
    return;
  }
  throw new Error('Clipboard API not available');
}
