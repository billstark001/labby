import assert from 'node:assert/strict';
import test from 'node:test';
import { rankingGroups, moveRanking } from '../src/lib/ranking-editor';

test('unknown candidates are omitted instead of being treated as last place', () => {
  assert.deepEqual(rankingGroups(['a', 'b', 'c', 'd'], { a: 2, b: 0, d: 1 }), [['d'], ['a']]);
  assert.deepEqual(rankingGroups(['a', 'b'], {}), []);
  assert.deepEqual(rankingGroups([], {}), []);
});

test('equal ranks form ties and rank gaps do not insert empty groups', () => {
  assert.deepEqual(rankingGroups(['a', 'b', 'c', 'd', 'e'], { a: 5, b: 1, c: 5, d: 3, e: 1 }), [['b', 'e'], ['d'], ['a', 'c']]);
});

test('invalid ranks are rejected and unrelated state is ignored', () => {
  for (const rank of [-1, 0.5, 3, NaN, Infinity]) {
    assert.throws(() => rankingGroups(['a', 'b'], { a: rank }), /Invalid rank/);
  }
  assert.deepEqual(rankingGroups(['a'], { a: 1, unrelated: -1 }), [['a']]);
});

test('dragging ranks only the compared unknown pair and preserves other unknowns', () => {
  assert.deepEqual(moveRanking(['a','b','c'],{},'b','a','before'),{b:1,a:2});
});
test('dragging around a tie preserves other ties and supports keyboard moves', () => {
  const moved=moveRanking(['a','b','c','d'],{a:1,b:1,c:2,d:0},'c','a','before');
  assert.deepEqual(rankingGroups(['a','b','c','d'],moved),[['c'],['a','b']]);
  assert.deepEqual(rankingGroups(['a','b','c','d'],moveRanking(['a','b','c','d'],moved,'a','c','after')),[['c'],['a'],['b']]);
  assert.deepEqual(moveRanking(['a'],{a:1},'a','a','before'),{a:1});
});
