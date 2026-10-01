import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { createStore } from '../../server/providers/store/store.js';
import { pgDriver, toPgPlaceholders } from '../../server/providers/store/drivers.js';
import { createRuleEngine } from '../sources/alertRules.js';

const T0 = Date.UTC(2026, 8, 30, 12);
const air = (id, t, lat, lon, extra = {}) => ({ domain: 'air', id, t, lat, lon, alt: 1000, speed: 200, course: 90, label: 'PG1', squawk: '1200', onGround: false, ...extra });

test('placeholder rewrite skips quoted strings', () => {
  assert.equal(toPgPlaceholders("SELECT ? , '?' , ?"), "SELECT $1 , '?' , $2");
});

test('the same store runs on Postgres (PGlite)', async () => {
  const db = new PGlite();
  const store = createStore(pgDriver(db));
  await store.init();
  await store.init(); // idempotent
  assert.equal(store.dialect, 'postgres');

  await store.insertFixes([
    { ...air('abc123', T0, 38, -121), pinned: false },
    { ...air('abc123', T0 + 60000, 38, -120.9), pinned: false },
    { ...air('fff000', T0 + 30000, 10, 10, { label: 'FAR' }), pinned: true },
    { domain: 'sea', id: '366999999', t: T0, lat: 37.8, lon: -122.4, label: 'TUG', meta: { imo: '1' } },
  ]);
  const track = await store.track({ domain: 'air', id: 'abc123', from: T0, to: T0 + 60000 });
  assert.deepEqual(track.map((f) => f.t), [T0, T0 + 60000]);
  assert.equal(typeof track[0].t, 'number', 'BIGINT comes back as a number');

  const box = { minLat: 30, minLon: -130, maxLat: 40, maxLon: -110 };
  const snap = await store.snapshot({ at: T0 + 60000, windowMs: 120000, bbox: box, domain: 'air' });
  assert.deepEqual(snap.map((f) => [f.id, f.lon, f.label]), [['abc123', -120.9, 'PG1']]);
  assert.equal((await store.range({ from: T0, to: T0 + 60000 })).length, 4);
  assert.equal((await store.searchAssets({ q: 'tug' }))[0].meta.imo, '1');

  await store.putRecord('rule', 'u1', 'r1', { name: 'x' });
  await store.putRecord('rule', 'u1', 'r1', { name: 'y' });
  assert.equal((await store.listRecords('rule', 'u1'))[0].name, 'y');
  await store.insertAlert({ id: crypto.randomUUID(), owner: 'u1', t: T0, kind: 'squawk', severity: 'critical', title: 't', detail: { a: 1 } });
  const [alert] = await store.listAlerts({ owner: 'u1' });
  assert.deepEqual(alert.detail, { a: 1 });
  assert.equal(await store.ackAlert('u1', alert.id), 1);

  await store.insertCamSamples([{ camera: 'c', t: T0, ok: true }, { camera: 'c', t: T0 + 1, ok: false }]);
  assert.equal((await store.camUptime({ from: 0, to: T0 + 10 }))[0].uptime, 0.5);
  assert.equal((await store.camSeries({ camera: 'c', from: 0, to: T0 + 10 })).length, 1);

  const base = T0 - (T0 % 120000);
  await store.insertFixes([0, 30000, 60000, 120000].map((d) => ({ ...air('ds0001', base + d, 1, 1 + d / 1e6), pinned: true })));
  const out = await store.prune({
    now: base + 8 * 86_400_000,
    unpinnedMs: 48 * 3_600_000,
    pinnedMs: 30 * 86_400_000,
    downsampleAfterMs: 7 * 86_400_000,
    downsampleBucketMs: 120000,
    camMs: 86_400_000,
    alertsMs: 86_400_000,
  });
  assert.equal(out.downsampled, 2);
  assert.ok(out.unpinned >= 3);
  const stats = await store.stats();
  assert.equal(typeof stats.fixes, 'number');

  // transaction rollback leaves nothing behind
  await assert.rejects(store.insertFixes([{ ...air('bad001', T0, 1, 1) }, { domain: 'air', id: null, t: T0, lat: 1, lon: 1 }]));
  assert.equal((await store.track({ domain: 'air', id: 'bad001', from: 0, to: T0 + 1 })).length, 0);
  await db.close();
});

test('rule engine throughput stays reasonable', () => {
  const fences = Array.from({ length: 20 }, (_, i) => ({ id: `f${i}`, name: `F${i}`, shape: { type: 'circle', center: [i, i], radiusM: 20000 } }));
  const rules = fences.map((f) => ({ id: `r${f.id}`, name: 'r', kind: 'fence-enter', scope: {}, params: { fenceId: f.id } }));
  const e = createRuleEngine({ fences, rules });
  const start = performance.now();
  for (let i = 0; i < 20000; i++) e.evaluate(air(`a${(i % 5000).toString(16).padStart(5, '0')}`, T0 + i, (i % 90) - 45, (i % 360) - 180));
  const ms = performance.now() - start;
  assert.ok(ms < 1500, `20k observations x 20 fence rules took ${ms.toFixed(0)} ms`);
});
