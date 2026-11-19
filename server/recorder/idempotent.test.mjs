import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openHistoryStore } from './store.js';

const pt = (o) => ({
  id: 'a',
  layer: 'air',
  lat: 10,
  lon: 10,
  alt: null,
  heading: 90,
  speed: 100,
  ts: 1000,
  ...o,
});
const all = (store) => store.window({ from: 0, to: 1e10 });

test('writing the same point twice stores it once', () => {
  const store = openHistoryStore(':memory:');
  store.insertMany([pt(), pt({ ts: 1060 })]);
  store.insertMany([pt(), pt({ ts: 1060 }), pt({ ts: 1120 })]);
  assert.equal(all(store).length, 3);
});

test('same time on another layer or contact is a different point', () => {
  const store = openHistoryStore(':memory:');
  store.insertMany([pt(), pt({ layer: 'sea' }), pt({ id: 'b' })]);
  assert.equal(all(store).length, 3);
});

test('a file with repeats is cleaned once, keeping the first written', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'gev-dup-'));
  const file = path.join(dir, 'h.sqlite');
  try {
    const raw = new DatabaseSync(file);
    raw.exec(`CREATE TABLE positions(
      ts INTEGER NOT NULL, id TEXT NOT NULL, layer TEXT NOT NULL,
      lat REAL NOT NULL, lon REAL NOT NULL, alt REAL, heading REAL, speed REAL)`);
    const ins = raw.prepare(
      'INSERT INTO positions VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL)',
    );
    ins.run(1000, 'a', 'air', 1, 1);
    ins.run(1000, 'a', 'air', 2, 2); // repeat, written later
    ins.run(1060, 'a', 'air', 3, 3);
    raw.close();
    const store = openHistoryStore(file);
    const rows = all(store);
    assert.equal(rows.length, 2);
    assert.equal(rows.find((r) => r.ts === 1000).lat, 1);
    store.insertMany([pt({ lat: 9 })]); // still ignored after cleaning
    assert.equal(all(store).length, 2);
    store.close?.();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
