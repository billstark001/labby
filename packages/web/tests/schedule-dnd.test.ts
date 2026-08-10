import assert from 'node:assert/strict';
import test from 'node:test';

import { performScheduleDrop, type ScheduleDndActions } from '../src/pages/schedule/schedule-dnd';

function recorder() {
  const calls: unknown[][] = [];
  const actions: ScheduleDndActions = {
    movePresentation: (...args) => calls.push(['presentation', ...args]),
    movePresentationTo: (...args) => calls.push(['presentation-position', ...args]),
    moveQuestioner: (...args) => calls.push(['questioner', ...args]),
    moveBoundary: (...args) => calls.push(['boundary', ...args]),
  };
  return { actions, calls };
}

const targetRect = { top: 100, left: 20, width: 80, height: 40 };

test('presentation drops resolve before and after from the target midpoint', () => {
  const { actions, calls } = recorder();
  const source = { kind: 'presentation' as const, presentationId: 'source' };
  const target = { kind: 'presentation' as const, presentationId: 'target' };
  performScheduleDrop(source, target, { position: { x: 40, y: 110 }, targetRect }, actions);
  performScheduleDrop(source, target, { position: { x: 40, y: 130 }, targetRect }, actions);
  assert.deepEqual(calls, [
    ['presentation', 'source', 'target', 'before'],
    ['presentation', 'source', 'target', 'after'],
  ]);
});

test('questioner drops resolve insertion before or after a token', () => {
  const { actions, calls } = recorder();
  const source = { kind: 'questioner' as const, presentationId: 'source', slotId: 'slot' };
  const target = { kind: 'questioner' as const, presentationId: 'target', targetIndex: 2, placement: 'around' as const };
  performScheduleDrop(source, target, { position: { x: 30, y: 110 }, targetRect }, actions);
  performScheduleDrop(source, target, { position: { x: 90, y: 110 }, targetRect }, actions);
  assert.deepEqual(calls, [
    ['questioner', 'source', 'slot', 'target', 2],
    ['questioner', 'source', 'slot', 'target', 3],
  ]);
});

test('boundary drops use the exact insertion rail', () => {
  const { actions, calls } = recorder();
  performScheduleDrop(
    { kind: 'boundary', sessionIndex: 3 },
    { kind: 'boundary', sessionIndex: 1, presentationIndex: 2 },
    { position: null, targetRect: null },
    actions,
  );
  assert.deepEqual(calls, [['boundary', 3, 1, 2]]);
});

test('presentation insertion rails cross the discarded-before boundary', () => {
  const { actions, calls } = recorder();
  performScheduleDrop(
    { kind: 'presentation', presentationId: 'discarded' },
    { kind: 'presentation-position', sessionIndex: 0, presentationIndex: 0 },
    { position: null, targetRect: null },
    actions,
  );
  assert.deepEqual(calls, [['presentation-position', 'discarded', 0, 0]]);
});

test('incompatible and self drops do nothing', () => {
  const { actions, calls } = recorder();
  performScheduleDrop(
    { kind: 'presentation', presentationId: 'same' },
    { kind: 'presentation', presentationId: 'same' },
    { position: null, targetRect: null },
    actions,
  );
  performScheduleDrop(
    { kind: 'boundary', sessionIndex: 0 },
    { kind: 'presentation', presentationId: 'target' },
    { position: null, targetRect: null },
    actions,
  );
  assert.deepEqual(calls, []);
});
