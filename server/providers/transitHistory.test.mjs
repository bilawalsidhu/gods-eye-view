import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createTransitHistory,
  validTransitIdentifier,
} from './transitHistory.js';
const feed = { id: 'mbta', historyRetention: true, defaultMode: 'bus' };
const row = (t, id = 'bus', extra = {}) => ({
  id,
  timestamp: t / 1000,
  lat: 42,
  lon: -71,
  tripId: 'trip',
  routeId: '1',
  timestampSource: 'vehicle',
  ...extra,
});
const storage = () => ({ bytes: 0, keys: 0, stores: new Set() });
function history(t, options = {}) {
  const h = createTransitHistory({
    sweep: false,
    storage: storage(),
    ...options,
  });
  t.after(() => h.clear());
  return h;
}
test('TTL ages reports and reads do not extend it; duplicate/conflicting times never append', (t) => {
  const h = history(t);
  h.ingest(feed, [row(100000)], 100000);
  h.ingest(feed, [row(100000), row(100000, 'bus', { lat: 43 })], 500000);
  assert.equal(h.get('mbta', 'bus', 500000).fixes.length, 1);
  assert.equal(h.get('mbta', 'bus', 999999).fixes.length, 1);
  assert.equal(h.get('mbta', 'bus', 1000000).fixes.length, 0);
  assert.equal(h.diagnostics().allocatedBytes, 0);
});
test('128-fix ring and bounded epoch contexts preserve breaks, never scene heights', (t) => {
  const h = history(t);
  for (let i = 0; i < 200; i++)
    h.ingest(
      feed,
      [
        row(i * 1000, 'bus', {
          tripId: i < 100 ? 'first' : 'second',
          heightM: 999,
        }),
      ],
      i * 1000,
    );
  const result = h.get('mbta', 'bus', 199000);
  assert.equal(result.fixes.length, 128);
  assert.equal(result.truncated, true);
  assert.equal(result.epochs.length, 2);
  assert.ok(result.fixes.find((f) => f[0] === 100000)[3] & 16);
  assert.ok(result.fixes.every((f) => f.length === 5));
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < 32768);
  for (let i = 200; i < 220; i++)
    h.ingest(feed, [row(i * 1000, 'bus', { tripId: `trip-${i}` })], i * 1000);
  const churn = h.get('mbta', 'bus', 219000);
  assert.ok(churn.epochs.length <= 8);
  assert.ok(churn.fixes.every((f) => churn.epochs.some((e) => e.id === f[4])));
});
test('allocated key, metadata and chunk bytes obey feed/process ceilings across stores', (t) => {
  const shared = storage(),
    limits = { feedBytes: 16000, processBytes: 24000, keys: 4 };
  const a = history(t, { storage: shared, limits }),
    b = history(t, { storage: shared, limits });
  for (let i = 0; i < 60; i++) {
    a.ingest(feed, [row(i * 1000, `a${i}`)], i * 1000);
    b.ingest(
      { ...feed, id: i % 2 ? 'mbta' : 'other' },
      [row(i * 1000, `b${i}`)],
      i * 1000,
    );
    assert.ok(shared.bytes <= limits.processBytes);
    assert.ok(shared.keys <= limits.keys);
    assert.ok(
      [...shared.feedBytes.values()].every(
        (bytes) => bytes <= limits.feedBytes,
      ),
    );
    assert.equal(
      a.diagnostics().allocatedBytes + b.diagnostics().allocatedBytes,
      shared.bytes,
    );
  }
  a.clear();
  b.clear();
  assert.equal(shared.bytes, 0);
  assert.equal(shared.keys, 0);
});
test('accelerated two-hour ingestion plateaus and expires idle keys', (t) => {
  const h = history(t, { limits: { feedBytes: 128000, processBytes: 128000 } });
  const samples = [];
  for (let now = 0; now <= 7200000; now += 15000) {
    h.ingest(
      feed,
      Array.from({ length: 12 }, (_, i) => row(now, `v${i}`)),
      now,
    );
    if (now >= 900000) samples.push(h.diagnostics().allocatedBytes);
  }
  assert.ok(Math.max(...samples) <= 128000);
  assert.equal(Math.max(...samples), Math.min(...samples));
  h.prune(8100001);
  assert.equal(h.diagnostics().keys, 0);
});
test('retention is opt-in and entire decoded identifiers are bounded', (t) => {
  const h = history(t);
  h.ingest({ ...feed, historyRetention: false }, [row(1000)], 1000);
  assert.equal(h.diagnostics().keys, 0);
  for (const id of [
    '',
    '.',
    '..',
    'abc/def',
    'abc\\def',
    'abc\0def',
    'é'.repeat(129),
    '\ud800',
  ]) {
    assert.equal(validTransitIdentifier(id), false);
    h.ingest(feed, [row(1000, id)], 1000);
  }
  assert.equal(h.diagnostics().keys, 0);
  assert.equal(validTransitIdentifier('🚋 vehicle 1'), true);
});
test('unref sweep is owned and clear closes the cache', (t) => {
  const h = history(t, { sweep: true });
  assert.equal(h.diagnostics().sweepActive, true);
  h.clear();
  h.ingest(feed, [row(1000)], 1000);
  assert.equal(h.diagnostics().sweepActive, false);
  assert.equal(h.diagnostics().keys, 0);
});

test('three identical-order 15000-vehicle snapshots retain paths within a bounded ingestion time', (t) => {
  const h = history(t);
  const times = [];
  for (let poll = 0; poll < 3; poll++) {
    const now = 100000 + poll * 15000;
    const rows = Array.from({ length: 15000 }, (_, i) =>
      row(now, `vehicle-${i}`),
    );
    const start = performance.now();
    h.ingest(feed, rows, now);
    times.push(performance.now() - start);
  }
  assert.equal(h.diagnostics().keys, 15000);
  for (let i = 0; i < 15000; i++) {
    const result = h.get('mbta', `vehicle-${i}`, 130000);
    assert.equal(result.fixes.length, 3);
    assert.equal(result.truncated, false);
  }
  assert.ok(h.diagnostics().allocatedBytes < 16 * 1024 * 1024);
  t.diagnostic(
    `15000-vehicle ingestion ms: ${times.map((n) => n.toFixed(1)).join('/')}`,
  );
  // A ceiling that says "not quadratic", not a benchmark: 15,000 rows in
  // well under two seconds on a loaded laptop or a slow CI runner. The
  // per-run figure above is the diagnostic to read.
  assert.ok(Math.max(...times) < 2000, `ingestion ms: ${times}`);
});

test('snapshot capacity pressure preserves members not yet visited and discloses recreated history', (t) => {
  const h = history(t, { limits: { keys: 2 } });
  h.ingest(feed, [row(1000, 'a'), row(1000, 'b')], 1000);
  // Newcomers precede the retained members in every snapshot.
  for (const now of [2000, 3000])
    h.ingest(feed, [row(now, 'c'), row(now, 'a'), row(now, 'b')], now);
  assert.equal(h.get('mbta', 'a', 3000).fixes.length, 3);
  assert.equal(h.get('mbta', 'b', 3000).fixes.length, 3);
  assert.equal(h.get('mbta', 'c', 3000).truncated, true);
  h.ingest(feed, [row(4000, 'c')], 4000);
  h.ingest(feed, [row(5000, 'a')], 5000);
  const recreated = h.get('mbta', 'a', 5000);
  assert.equal(recreated.fixes.length, 1);
  assert.equal(recreated.truncated, true);
});
