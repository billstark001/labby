import { describe, expect, test } from 'vitest';
import { buildEmailTemplateScheduleVariables, pickSessions, renderTemplate, sessionStartInstant, type ScheduleConfig, type SchedulePlan, type ScheduleUnit } from '../src/index.js';

const config: ScheduleConfig = {
  id: 'config', daysOfWeek: [1], timeRange: ['09:00', '10:00'], timezone: 'Asia/Tokyo',
  startDate: '2026-01-01', endDate: '2026-06-30', presentersPerSession: 1,
  questionersPerPresenter: 0, targetSimilarityRadius: 0.5, metadata: {},
};
const plan: SchedulePlan = {
  id: 'plan', configId: 'config', createdAt: 0,
  sessions: ['2026-01-12', '2026-01-05', '2026-01-19', '2026-02-05', '2026-04-05'].map(date => ({
    date, presentations: [{ presenterId: date, questionerIds: [] }], notes: date,
  })),
};
const anchorTime = Date.parse('2026-01-05T00:00:00Z');
const selected = (options: Parameters<typeof pickSessions>[1]) => pickSessions(plan, { config, anchorTime, ...options }).map(session => session.date);

describe('schedule selection', () => {
  test('next session follows its actual start, including an occurrence override', () => {
    const modified = { ...plan, sessions: plan.sessions.map(session => session.date === '2026-01-05'
      ? { ...session, timeRange: ['14:30', '16:00'] as [string, string] } : session) };
    const before = buildEmailTemplateScheduleVariables({ plan: modified, config, anchorTime: Date.parse('2026-01-05T05:29:59Z') });
    expect(before.nextSession.notes).toBe('2026-01-05');
    const after = buildEmailTemplateScheduleVariables({ plan: modified, config, anchorTime: Date.parse('2026-01-05T05:30:01Z') });
    expect(after.nextSession.notes).toBe('2026-01-12');
    expect(JSON.parse(after.schedule.json('session'))[0].dateIso).toBe('2026-01-12');
    expect(after.schedule.tableHtml('session')).toContain('2026-01-12');
    expect(after.schedule.tableMarkdown('session')).toContain('2026-01-12');
    expect(after.schedule.bulletedListMarkdown('session')).toContain('2026-01-12');
  });

  test('session counts and rolling windows use inclusive starts and exclusive ends', () => {
    expect(selected({ unit: 'sessions', amount: 2 })).toEqual(['2026-01-05', '2026-01-12']);
    expect(selected({ unit: 'week' })).toEqual(['2026-01-05']);
    expect(selected({ unit: 'weeks', amount: 2 })).toEqual(['2026-01-05', '2026-01-12']);
    expect(selected({ unit: 'months' })).toEqual(['2026-01-05', '2026-01-12', '2026-01-19']);
    expect(selected({ unit: 'quarters' })).toHaveLength(4);
    expect(selected({ unit: 'session', anchorTime: anchorTime + 1 })).toEqual(['2026-01-12']);
    expect(selected({ unit: 'semesters', anchorTime: Date.parse('2027-01-01T00:00:00Z') })).toHaveLength(5);
  });

  test.each<ScheduleUnit>(['semester', 'session', 'week', 'month', 'quarter'])('%s has its plural form', unit => {
    expect(selected({ unit: `${unit}s`, amount: 2 })).toEqual(selected({ unit, amount: 2 }));
  });

  test('no future session returns empty nextSession fields and no upcoming rows', () => {
    const variables = buildEmailTemplateScheduleVariables({ plan, config, anchorTime: Date.parse('2027-01-01T00:00:00Z') });
    expect(Object.keys(variables)).toEqual(['schedule', 'nextSession']);
    expect(Object.keys(variables.schedule)).toEqual(['tableHtml', 'tableMarkdown', 'bulletedListMarkdown', 'json']);
    expect(variables.nextSession).toEqual({ date: '', time: '', dateTime: '', notes: '' });
    expect(variables.schedule.json('sessions', 2)).toBe('[]');
    expect(buildEmailTemplateScheduleVariables({}).nextSession).toEqual(variables.nextSession);
  });

  test('month windows clamp end-of-month dates', () => {
    const monthPlan = { ...plan, sessions: ['2026-02-27', '2026-02-28', '2026-03-01'].map(date => ({ date, presentations: [] })) };
    expect(pickSessions(monthPlan, { config, unit: 'month', anchorTime: Date.parse('2026-01-31T00:00:00Z') }).map(session => session.date)).toEqual(['2026-02-27']);
  });

  test('timezone fallback and DST use the same instant for session starts and calendar windows', () => {
    const dstConfig = { ...config, timezone: 'America/New_York' };
    expect(sessionStartInstant({ date: '2026-03-08', presentations: [] }, { config: dstConfig })).toBe(Date.parse('2026-03-08T13:00:00Z'));
    expect(sessionStartInstant({ date: '2026-01-05', presentations: [] }, { config: { ...config, timezone: undefined }, timeZone: 'Asia/Tokyo' })).toBe(anchorTime);
    const dstPlan = { ...plan, sessions: ['2026-03-07', '2026-03-08', '2026-03-14'].map(date => ({ date, presentations: [] })) };
    expect(pickSessions(dstPlan, { config: dstConfig, unit: 'week', anchorTime: Date.parse('2026-03-07T14:00:00Z') }).map(session => session.date)).toEqual(['2026-03-07', '2026-03-08']);
  });

  test('invalid selections report template errors instead of silently choosing another mode', () => {
    const context = buildEmailTemplateScheduleVariables({ plan, config, anchorTime });
    for (const expr of ['schedule.json("day")', 'schedule.json("session", 0)', 'schedule.json("session", 1.5)', 'schedule.json("session", NaN)']) {
      expect(renderTemplate(`{{ ${expr} }}`, context).errors).toHaveLength(1);
    }
  });

  test('HTML tables render as markup while ordinary values and names remain escaped', () => {
    const variables = buildEmailTemplateScheduleVariables({ plan, config, anchorTime, displayName: person => person.name,
      persons: [{ id: '2026-01-05', name: '<script>alert(1)</script>', keywordIds: [], metadata: {} }] });
    const rendered = renderTemplate('<div>{{ schedule.tableHtml("session") }}</div><p>{{ note }}</p>', { ...variables, note: '<b>note</b>' }, { format: 'html' });
    expect(rendered.errors).toEqual([]);
    expect(rendered.output).toContain('<table>');
    expect(renderTemplate('{{ schedule.tableHtml("session").length }}', variables, { format: 'html' }).output)
      .toBe(String(variables.schedule.tableHtml('session').length));
    expect(rendered.output).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(rendered.output).toContain('<p>&lt;b&gt;note&lt;/b&gt;</p>');
  });
});
