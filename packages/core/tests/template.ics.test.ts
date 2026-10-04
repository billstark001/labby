import { expect, test } from 'vitest';
import type { Person, ScheduleConfig, SchedulePlan } from '../src/types.js';
import { buildScheduleIcs } from '../src/template/index.js';

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
