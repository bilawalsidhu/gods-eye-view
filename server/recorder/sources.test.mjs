import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openHistoryStore } from './store.js';
import { withSource } from './sources.js';

const pt = (o) => ({
  id: 'a',
  layer: 'air',
  lat: 1,
  lon: 1,
  alt: null,
  heading: null,
  speed: null,
  ts: 1000,
  ...o,
});

test('each layer gets its feed name, and an explicit source is kept', () => {
  assert.equal(withSource(pt()).source, 'opensky');
  assert.equal(withSource(pt({ layer: 'mil' })).source, 'adsb.lol');
  assert.equal(withSource(pt({ layer: 'sat' })).source, 'celestrak');
  assert.equal(withSource(pt({ source: 'mine' })).source, 'mine');
  assert.equal(withSource(pt({ layer: 'other' })).source, undefined);
});

test('the source is stored and read back', () => {
  const store = openHistoryStore(':memory:');
  store.insertMany([withSource(pt()), pt({ id: 'b' })]);
  const rows = store.window({ from: 0, to: 1e10 });
  assert.equal(rows.find((r) => r.id === 'a').source, 'opensky');
  assert.equal(rows.find((r) => r.id === 'b').source, null);
});

test('a file from before the column gains it, old rows stay empty', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'gev-src-'));
  const file = path.join(dir, 'h.sqlite');
  try {
    const raw = new DatabaseSync(file);
    raw.exec(`CREATE TABLE positions(
      ts INTEGER NOT NULL, id TEXT NOT NULL, layer TEXT NOT NULL,
      lat REAL NOT NULL, lon REAL NOT NULL, alt REAL, heading REAL, speed REAL);
      INSERT INTO positions VALUES (1000, 'old', 'air', 1, 1, NULL, NULL, NULL)`);
    raw.close();
    const store = openHistoryStore(file);
    store.insertMany([withSource(pt({ id: 'new' }))]);
    const rows = store.window({ from: 0, to: 1e10 });
    assert.equal(rows.find((r) => r.id === 'old').source, null);
    assert.equal(rows.find((r) => r.id === 'new').source, 'opensky');
    store.close?.();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
