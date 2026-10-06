import { expect, test } from 'vitest';
import type { Person, ScheduleConfig, SchedulePlan } from '../src/types.js';
import { buildScheduleIcs, buildEmailTemplateScheduleVariables, buildScheduleRows } from '../src/template/index.js';

const persons: Person[] = ['Alice', 'Bob', 'Carol'].map((name) => ({
  id: name.toLowerCase(), name, metadata: {}, keywordIds: [],
}));
const personMap = new Map(persons.map((person) => [person.id, person]));
const plan: SchedulePlan = {
  id: 'plan', configId: 'config', createdAt: Date.UTC(2026, 0, 1),
  sessions: [{
    date: '2026-01-05',
    presentations: persons.map((person) => ({ presenterId: person.id, questionerIds: [] })),
  }],
};
const config: ScheduleConfig = {
  id: 'config', daysOfWeek: [1], timeRange: ['09:00', '10:01'], timezone: 'Asia/Tokyo',
  presentersPerSession: 3, questionersPerPresenter: 0, targetSimilarityRadius: 0.5,
  startDate: '2026-01-01', endDate: '2026-01-31', metadata: {},
};

test('ICS presenter events partition meeting minutes without gaps or overlap', () => {
  const ics = buildScheduleIcs(plan, personMap, (person) => person.name, config);
  const times = [...ics.matchAll(/DTSTART:(\d{8}T\d{6}Z)\r\nDTEND:(\d{8}T\d{6}Z)/g)]
    .map((match) => [match[1], match[2]]);
  expect(times).toEqual([
    ['20260105T000000Z', '20260105T002000Z'],
    ['20260105T002000Z', '20260105T004000Z'],
    ['20260105T004000Z', '20260105T010100Z'],
  ]);
});

test('both ICS modes render content from the same event context', () => {
  for (const mode of ['presenters', 'meeting'] as const) {
    const ics = buildScheduleIcs(plan, personMap, (person) => person.name, config, undefined, {
      mode,
      contentTemplate: '{{ sessionDate }} {{ presenters[0] }} {{ eventStart }} {{ zoomUrl }}',
      templateContext: { zoomUrl: 'https://zoom.example/room' },
    });
    expect(ics).toContain('DESCRIPTION:2026-01-05 Alice 2026-01-05T00:00:00.000Z https://zoom.example/room');
    expect(ics.match(/BEGIN:VEVENT/g)).toHaveLength(mode === 'meeting' ? 1 : 3);
  }
});


test('one-occurrence overrides affect mail time text, export rows and both ICS modes', () => {
  const customized: SchedulePlan = { ...plan, sessions: [
    { ...plan.sessions[0]!, notes: 'Bring slides, please; thank you\nRoom B', timeRange: ['14:30', '15:30'] },
    { ...plan.sessions[0]!, date: '2026-01-12' },
  ] };
  const variables = buildEmailTemplateScheduleVariables({ plan: customized, config, persons, anchorDate: '2026-01-04' });
  expect(variables.scheduleNextSessionTimeText).toBe('14:30 - 15:30');
  expect(variables.scheduleNextSessionNotes).toBe(customized.sessions[0]!.notes);
  expect((variables.nextSessionNotes as () => string)()).toBe(customized.sessions[0]!.notes);
  const rows = buildScheduleRows(customized, personMap, person => person.name, { config, dateDisplay: { granularity: 'date-time' } });
  expect(rows[0]!.dateLabel).toContain('14:30-15:30');
  expect(rows[3]!.dateLabel).toContain('09:00-10:01');
  for (const mode of ['meeting', 'presenters'] as const) {
    const ics = buildScheduleIcs(customized, personMap, person => person.name, config, undefined, { mode });
    expect(ics).toContain('DTSTART:20260105T053000Z');
    expect(ics).toContain('DTEND:20260105T063000Z');
    expect(ics).toContain('DTSTART:20260112T000000Z');
    expect(ics).toContain('Bring slides\\, please\\; thank you\\nRoom B');
    const templated = buildScheduleIcs(customized, personMap, person => person.name, config, undefined, {
      mode, contentTemplate: '{{ sessionStartTime }} {{ sessionEndTime }} {{ sessionNotes }}',
    });
    expect(templated).toContain('DESCRIPTION:14:30 15:30 Bring slides');
    expect(templated).toContain('DESCRIPTION:09:00 10:01 ');
  }
  const later = buildEmailTemplateScheduleVariables({ plan: customized, config, anchorDate: '2026-01-06' });
  expect(later.scheduleNextSessionNotes).toBe('');
  expect(later.scheduleNextSessionTimeText).toBe('09:00 - 10:01');
  expect(buildEmailTemplateScheduleVariables({ plan: { ...plan, sessions: [customized.sessions[0]!] }, anchorDate: '2026-01-06' }).scheduleNextSessionNotes).toBe('');
  expect((buildEmailTemplateScheduleVariables({}).nextSessionNotes as () => string)()).toBe('');
});

test('an overnight override ends on the following day', () => {
  const customized: SchedulePlan = { ...plan, sessions: [{ ...plan.sessions[0]!, timeRange: ['23:30', '00:30'] }] };
  const ics = buildScheduleIcs(customized, personMap, person => person.name, config, undefined, { mode: 'meeting' });
  expect(ics).toContain('DTSTART:20260105T143000Z');
  expect(ics).toContain('DTEND:20260105T153000Z');
});
