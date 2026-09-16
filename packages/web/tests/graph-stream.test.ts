import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSimilarityGraphEdges, type GraphRecord, type GraphPage } from '@labby/core';
import { GraphModel, GraphStream } from '../src/lib/graph-stream.js';

const record = (id: string, offset = 0): GraphRecord => ({
  id,
  keyword: { id, name: id },
  vector: {
    keywordId: id,
    embedding: Array.from({ length: 8 }, (_, i) => Math.sin(Number(id) * 7 + i + offset) / 4),
    geometry: { hyperbolicDimensions: 4, euclideanDimensions: 4 },
    x: 0,
    y: 0,
    updatedAt: 1,
  },
});
const page = (
  items: GraphRecord[],
  nextCursor: string | null,
  checkpoint: string | null,
): GraphPage => ({ items, nextCursor, checkpoint, reset: false });
const normalize = (edges: ReturnType<typeof buildSimilarityGraphEdges>) =>
  [...edges].sort((a, b) =>
    JSON.stringify([a.sourceId, a.targetId]).localeCompare(
      JSON.stringify([b.sourceId, b.targetId]),
    ),
  );

test('incremental neighbors match a full rebuild after inserts, moves and deletions', () => {
  const model = new GraphModel();
  model.apply(Array.from({ length: 30 }, (_, i) => record(String(i))));
  for (const changes of [
    [record('5', 7)],
    [record('30')],
    [{ id: '9', keyword: null, vector: null }],
    [record('2', 2), record('21', 3)],
  ]) {
    model.apply(changes);
    const actual = normalize(model.edges);
    const expected = normalize(buildSimilarityGraphEdges(model.vectors));
    assert.deepEqual(
      actual.map((e) => [e.sourceId, e.targetId]),
      expected.map((e) => [e.sourceId, e.targetId]),
    );
    actual.forEach((edge, index) =>
      assert.ok(Math.abs(edge.weight - expected[index]!.weight) < 1e-12),
    );
  }
});

test('stream publishes each page and catches up changes before completing bootstrap', async () => {
  const requests: unknown[] = [];
  const counts: number[] = [];
  const responses = [
    page([record('0')], 'page2', null),
    page([record('1')], null, 'checkpoint1'),
    page([{ id: '0', keyword: null, vector: null }], null, 'checkpoint2'),
    page([record('2')], null, 'checkpoint3'),
  ];
  const stream = new GraphStream(
    {
      list: async (query) => {
        requests.push(query);
        return responses.shift()!;
      },
    },
    (model) => counts.push(model.records.size),
    async () => {},
  );
  await stream.refresh();
  assert.ok(counts.includes(1));
  assert.ok(counts.includes(2));
  assert.deepEqual([...stream.model.records.keys()], ['1']);
  await stream.refresh();
  assert.equal((requests.at(-1) as { since: string }).since, 'checkpoint2');
  assert.deepEqual([...stream.model.records.keys()], ['1', '2']);
});

test('failed bootstrap is restarted cleanly and failed deltas retain their checkpoint', async () => {
  let call = 0;
  const requests: Array<{ since?: string; cursor?: string } | undefined> = [];
  const stream = new GraphStream(
    {
      list: async (query) => {
        requests.push(query);
        call++;
        if (call === 1) return page([record('0')], 'next', null);
        if (call === 2 || call === 7) throw new Error('offline');
        if (call === 3) return page([record('1')], null, 'base');
        if (call === 4) return page([], null, 'ready');
        if (call === 5) return page([record('2')], 'delta-next', null);
        if (call === 6) return page([record('3')], 'delta-later', null);
        return page([{ id: '2', keyword: null, vector: null }], null, 'done');
      },
    },
    () => {},
    async () => {},
  );
  await assert.rejects(stream.refresh(), /offline/);
  await stream.refresh();
  assert.deepEqual([...stream.model.records.keys()], ['1']);
  await assert.rejects(stream.refresh(), /offline/);
  await stream.refresh();
  assert.equal(requests.at(-1)!.since, 'ready');
  assert.equal(stream.model.records.has('2'), false);
});

test('bad transport records and incompatible vectors cannot poison the last valid graph', () => {
  const model = new GraphModel();
  model.apply([record('0'),record('1')]);
  const version = model.version;
  const previous = [...model.records.values()];
  const edges = model.edges;
  const malformed = {id:'2', keyword:JSON.stringify({id:'2'}), vector:null} as unknown as GraphRecord;
  assert.throws(()=>model.apply([record('3'), malformed]), /Malformed graph/);
  const incompatible = record('2');
  incompatible.vector!.geometry = {hyperbolicDimensions:5,euclideanDimensions:3};
  assert.throws(()=>model.apply([record('3'), incompatible]), /different product geometries/);
  assert.deepEqual([...model.records.values()],previous);
  assert.deepEqual(model.edges,edges);
  assert.equal(model.version,version);
  model.apply(previous);
  assert.equal(model.version,version, 'replayed pages must not restart animations');
});

test('repeated malformed responses expose errors without publishing corrupt records, then recover', async () => {
  let broken = true;
  const stream = new GraphStream({list:async()=>page(broken
    ? [{id:'0',keyword:'text payload',vector:null} as unknown as GraphRecord]
    : [record('0')], null, 'checkpoint')}, model => {
      for(const item of model.records.values()) assert.equal(typeof item.keyword, 'object');
    }, async()=>{});
  for(let i=0;i<30;i++) await assert.rejects(stream.refresh(), /Malformed graph/);
  broken=false;
  await stream.refresh();
  assert.equal(stream.model.records.size,1);
});
