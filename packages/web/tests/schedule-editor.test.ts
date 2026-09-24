import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { SchedulePlan } from '@labby/core';
import {
  addQuestioner,
  createScheduleDraft,
  deleteSession,
  moveBoundary,
  movePresentationTo,
  moveQuestioner,
  nextConfiguredDateAfter,
  postponeSessionSuffix,
  recordSessionDateChange,
  reorderPresentations,
  rescheduleSession,
  shiftSessionSuffix,
  suggestedInsertDate,
  swapAdjacentSessions,
} from '../src/pages/schedule/schedule-editor.js';

function plan(): SchedulePlan {
  return {
    id: 'plan',
    configId: 'config',
    createdAt: 1,
    sessions: [
      { date: '2026-04-01', presentations: ['p1', 'p2', 'p3'].map(presenterId => ({ presenterId, questionerIds: [] })) },
      { date: '2026-04-08', presentations: ['p4', 'p5', 'p6'].map(presenterId => ({ presenterId, questionerIds: [] })) },
      { date: '2026-04-15', presentations: ['p7', 'p8', 'p9'].map(presenterId => ({ presenterId, questionerIds: [] })) },
    ],
  };
}

function presenters(draft: ReturnType<typeof createScheduleDraft>): string[][] {
  return draft.sessions.map(session => session.presentations.map(row => row.presenter.kind === 'fixed' ? row.presenter.personId : 'auto'));
}

describe('schedule tape editor', () => {
  test('presentation drag reorders the tape without changing session sizes', () => {
    const draft = createScheduleDraft(plan());
    const source = draft.sessions[0]!.presentations[1]!.id;
    const target = draft.sessions[1]!.presentations[1]!.id;
    const result = reorderPresentations(draft, source, target, 'after');

    assert.deepEqual(result.sessions.map(session => session.presentations.length), [3, 3, 3]);
    assert.deepEqual(presenters(result), [['p1', 'p3', 'p4'], ['p5', 'p2', 'p6'], ['p7', 'p8', 'p9']]);
    assert.deepEqual(presenters(draft)[0], ['p1', 'p2', 'p3']);
  });

  test('a discarded-before presentation can return through an exact session slot', () => {
    const draft = createScheduleDraft(plan());
    const discarded = draft.sessions[0]!.presentations.shift()!;
    draft.discardedBefore.push(discarded);
    const displaced = draft.sessions[0]!.presentations[0]!;
    const moved = movePresentationTo(draft, discarded.id, 0, 0);
    assert.equal(moved.sessions[0]!.presentations[0]!.id, discarded.id);
    assert.equal(moved.discardedBefore[0]!.id, displaced.id);
    assert.equal(moved.sessions[0]!.presentations.length, draft.sessions[0]!.presentations.length);
  });

  test('moving one date boundary transfers a row between adjacent sessions', () => {
    const draft = createScheduleDraft(plan());
    const result = moveBoundary(draft, 1, 'up');
    assert.deepEqual(presenters(result).slice(0, 2), [['p1', 'p2'], ['p3', 'p4', 'p5', 'p6']]);
  });

  test('suffix shift preserves affected group sizes and exposes overflow for deletion', () => {
    const draft = createScheduleDraft(plan());
    const result = shiftSessionSuffix(draft, 1, 'up', 2);
    assert.deepEqual(presenters(result), [['p1', 'p2'], ['p3', 'p4', 'p5'], ['p6', 'p7', 'p8']]);
    assert.equal(result.discardedAfter[0]!.presenter.kind, 'fixed');
    assert.equal(result.discardedAfter[0]!.presenter.kind === 'fixed' && result.discardedAfter[0]!.presenter.personId, 'p9');
  });

  test('deleting a session keeps its rows visible in the trailing deletion zone', () => {
    const draft = createScheduleDraft(plan());
    const result = deleteSession(draft, draft.sessions[1]!.id);
    assert.deepEqual(result.sessions.map(session => session.date), ['2026-04-01', '2026-04-15']);
    assert.equal(result.discardedAfter.length, 3);
  });

  test('rescheduling, adjacent exchange and postponement preserve presentation counts', () => {
    const draft = createScheduleDraft(plan());
    assert.equal(suggestedInsertDate(draft, 1, 'before'), '2026-04-07');
    const moved = recordSessionDateChange(rescheduleSession(draft, draft.sessions[1]!.id, '2026-04-09'),
      '2026-04-08', '2026-04-09');
    assert.deepEqual(moved.sessions.map(session => session.date), ['2026-04-01', '2026-04-09', '2026-04-15']);
    assert.deepEqual(moved.sessionMutations?.map(item => `${item.action}:${item.date}`),
      ['delete:2026-04-08', 'insert:2026-04-09']);
    assert.deepEqual(presenters(swapAdjacentSessions(draft, 0, 1))[0], ['p4', 'p5', 'p6']);
    const postponed = recordSessionDateChange(postponeSessionSuffix(draft, 1, nextConfiguredDateAfter('2026-04-15', [3])),
      '2026-04-08', '2026-04-22');
    assert.deepEqual(postponed.sessions.map(session => session.date), ['2026-04-01', '2026-04-15', '2026-04-22']);
    assert.deepEqual(presenters(postponed), presenters(draft));
    assert.deepEqual(postponed.sessions.map(session => session.presentations.length), [3, 3, 3]);
  });

  test('each Auto questioner is an independent movable slot', () => {
    const draft = createScheduleDraft(plan());
    const source = draft.sessions[0]!.presentations[0]!;
    const target = draft.sessions[1]!.presentations[0]!;
    const withAuto = addQuestioner(draft, source.id, null);
    const slot = withAuto.sessions[0]!.presentations[0]!.questioners[0]!;
    const result = moveQuestioner(withAuto, source.id, slot.id, target.id, 0);
    assert.equal(result.sessions[0]!.presentations[0]!.questioners.length, 0);
    assert.equal(result.sessions[1]!.presentations[0]!.questioners[0]!.kind, 'auto');
  });
});
