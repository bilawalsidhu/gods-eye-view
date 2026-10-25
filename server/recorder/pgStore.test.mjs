import test from 'node:test';
import assert from 'node:assert/strict';
import { createPgStore } from './pgStore.js';
import { createRecorder } from './recorder.js';

const pt = (o) => ({
  id: 'a',
  layer: 'air',
  lat: 10,
  lon: 10,
  alt: 100,
  heading: 90,
  speed: 100,
  ts: 1000,
  ...o,
});

test('a missing pg package gives an install hint on first use', async () => {
  const store = createPgStore('postgres://x', {
    loadPg: () => Promise.reject(new Error('Cannot find package')),
  });
  await assert.rejects(store.range(), /npm install pg/);
  await store.close();
});

test('falls back to plain latitude and longitude when PostGIS is missing', async () => {
  const seen = [];
  const pool = {
    async query(sql, params) {
      seen.push(sql);
      if (/CREATE EXTENSION/.test(sql)) throw new Error('no postgis');
      return { rows: [], rowCount: 0 };
    },
    end: async () => {},
  };
  const store = createPgStore('postgres://x', {
    loadPg: async () => ({
      default: {
        Pool: function () {
          return pool;
        },
        types: { getTypeParser: () => String },
      },
    }),
  });
  await store.window({
    from: 0,
    to: 10,
    bbox: { west: 0, south: 1, east: 2, north: 3 },
    layers: ['air'],
  });
  const sql = seen.at(-1);
  assert.match(sql, /lat BETWEEN \$3 AND \$4 AND lon BETWEEN \$5 AND \$6/);
  assert.match(sql, /layer = ANY\(\$7::text\[\]\)/);
  assert.ok(!seen.some((s) => /ADD COLUMN IF NOT EXISTS geom/.test(s)));
  await store.close();
});

// Runs only against a real server: GEV_TEST_PG_URL=postgres://user:pass@host/db
const url = process.env.GEV_TEST_PG_URL;
test('postgres store matches the SQLite store', { skip: !url }, async () => {
  const pg = (await import('pg')).default;
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  await admin.query(
    'DROP TABLE IF EXISTS positions, fences, fence_events, pins, contacts CASCADE',
  );
  await admin.end();

  const store = createPgStore(url);
  const rec = createRecorder({
    store,
    retentionDays: 0,
    intervalSec: 1,
    now: () => 1000 * 1000,
  });
  rec.ingestMany([
    pt({ id: 'a', ts: 100, name: 'UAL123' }),
    pt({ id: 'a', ts: 200, lat: 11 }),
    pt({ id: 'a', ts: 900, lat: 12 }),
    pt({ id: 'm', layer: 'mil', ts: 150, lat: 50, lon: 50, alt: null }),
  ]);
  await rec.flush();

  const range = await store.range();
  assert.deepEqual({ ...range }, { from_ts: 100, to_ts: 900, count: 4 });
  assert.equal((await store.track('a', 0, 500)).length, 2);
  assert.deepEqual(
    (await store.findContacts('ual1')).map((c) => c.id),
    ['a'],
  );
  assert.deepEqual(await store.findContacts('100%'), []);
  assert.deepEqual(
    (
      await store.window({
        from: 0,
        to: 999,
        bbox: { west: 0, south: 0, east: 20, north: 20 },
        layers: ['air'],
      })
    ).map((p) => p.ts),
    [100, 200, 900],
  );
  const at = await store.at({ time: 250, lookback: 200 });
  assert.equal(at.find((p) => p.id === 'a').ts, 200);
  assert.equal(
    (
      await store.at({
        time: 250,
        lookback: 200,
        bbox: { west: 40, south: 40, east: 60, north: 60 },
      })
    ).length,
    1,
  );

  const id = await rec.addFence({
    name: 'Box',
    west: 0,
    south: 0,
    east: 10,
    north: 20,
    layers: ['air'],
  });
  rec.ingestMany([
    pt({ id: 'z', ts: 1001, lat: 5, lon: 5 }),
    pt({ id: 'z', ts: 1100, lat: 50, lon: 50 }),
  ]);
  await rec.flush();
  const events = await store.events({ fenceId: id });
  assert.deepEqual(events.map((e) => e.kind).reverse(), ['enter', 'exit']);
  assert.equal(events[0].fence, 'Box');
  assert.equal(await rec.removeFence(id), 1);

  await store.addPin('a', 1);
  assert.deepEqual(
    (await store.listPins()).map((p) => p.id),
    ['a'],
  );
  await store.purgeBefore(5000);
  assert.deepEqual(
    [...new Set((await store.window({ from: 0, to: 9999 })).map((p) => p.id))],
    ['a'],
  );
  assert.ok((await store.usedBytes()) > 0);
  assert.equal(await store.removePin('a'), 1);
  assert.ok((await store.dropOldest(0.5)) >= 1);
  await rec.close();
});
