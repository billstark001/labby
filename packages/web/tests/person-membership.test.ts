import assert from 'node:assert/strict';
import test from 'node:test';
import type { Person } from '@labby/core';
import { changedMemberships } from '../src/lib/person-membership';

test('reverse membership edits update only changed people and preserve other relationships', () => {
  const people: Person[] = [
    { id: 'a', name: 'A', names: { en: 'A' }, metadata: {}, keywordIds: ['other'], tagIds: ['target', 'other'] },
    { id: 'b', name: 'B', names: { en: 'B' }, metadata: {}, keywordIds: ['other'], tagIds: ['other'] },
    { id: 'c', name: 'C', names: { en: 'C' }, metadata: {}, keywordIds: ['target', 'other'] },
  ];
  assert.deepEqual(changedMemberships(people, 'tagIds', 'target', ['b'], 42).map(person =>
    ({ id: person.id, tagIds: person.tagIds, keywordIds: person.keywordIds, modifiedAt: person.modifiedAt })), [
    { id: 'a', tagIds: ['other'], keywordIds: ['other'], modifiedAt: 42 },
    { id: 'b', tagIds: ['other', 'target'], keywordIds: ['other'], modifiedAt: 42 },
  ]);
  assert.deepEqual(changedMemberships(people, 'keywordIds', 'target', ['b', 'c'], 42).map(person =>
    ({ id: person.id, keywordIds: person.keywordIds, tagIds: person.tagIds })), [
    { id: 'b', keywordIds: ['other', 'target'], tagIds: ['other'] },
  ]);
});
