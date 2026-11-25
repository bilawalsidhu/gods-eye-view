import test from 'node:test';
import assert from 'node:assert/strict';
import { capWindow, decodeCursor, encodeCursor } from './windowCap.js';
import { openHistoryStore } from './store.js';

const rows = (n) =>
  Array.from({ length: n }, (_, i) => ({ layer: 'air', id: `c${i}`, ts: i }));

test('cursor round trips and rejects anything we did not issue', () => {
  const row = { layer: 'sea', id: 'x:1', ts: 1234 };
  assert.deepEqual(decodeCursor(encodeCursor(row)), row);
  for (const bad of ['', 'nope', 'W10', 42, null, 'x'.repeat(600)])
    assert.equal(decodeCursor(bad), null);
  const wrong = Buffer.from(JSON.stringify(['air', 5, 'z'])).toString(
    'base64url',
  );
  assert.equal(decodeCursor(wrong), null);
});

test('paging walks every row once, in order, with no repeats', () => {
  const store = openHistoryStore(':memory:');
  const all = [];
  for (const layer of ['air', 'sea'])
    for (const id of ['a', 'b', 'c'])
      for (const ts of [10, 20, 30])
        all.push({ layer, id, ts, lat: 1, lon: 1, alt: null, heading: null, speed: null });
  store.insertMany(all);
  const seen = [];
  let after = null;
  for (let guard = 0; guard < 20; guard++) {
    const page = capWindow(
      store.window({ from: 0, to: 99, after, limit: 5 + 1 }),
      5,
    );
    seen.push(...page.points);
    if (!page.nextCursor) break;
    after = decodeCursor(page.nextCursor);
  }
  assert.equal(seen.length, 18);
  const keys = seen.map((p) => `${p.layer}/${p.id}/${p.ts}`);
  assert.equal(new Set(keys).size, 18);
  assert.deepEqual(keys, [...keys].sort());
});

test('under the limit is complete', () => {
  const r = capWindow(rows(3), 5);
  assert.equal(r.points.length, 3);
  assert.equal(r.truncated, false);
});

test('exactly the limit is complete, not cut', () => {
  const r = capWindow(rows(5), 5);
  assert.equal(r.points.length, 5);
  assert.equal(r.truncated, false);
});

test('one row over the limit is cut and trimmed to the limit', () => {
  const r = capWindow(rows(6), 5);
  assert.equal(r.points.length, 5);
  assert.equal(r.truncated, true);
  assert.equal(r.points.at(-1).id, 'c4');
  assert.deepEqual(decodeCursor(r.nextCursor), {
    layer: 'air',
    id: 'c4',
    ts: 4,
  });
});
