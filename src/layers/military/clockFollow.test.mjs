import test from 'node:test';
import assert from 'node:assert/strict';
import { MilitaryFlightRecords } from './records.js';
import { createIngestion, createMilitaryFeed } from './ingestion.js';
import { displayDelayMs, RENDER_DELAY_SEC } from './policy.js';

// Military aircraft follow the world clock only while their source declares
// a timeline (src/time/snapshotTimeline.js); these cover the layer's side.

const T = 1_800_000_000_000;

test('military contacts are drawn behind the live edge, and at the time following the clock', () => {
  assert.equal(displayDelayMs({ timeline: null }), RENDER_DELAY_SEC * 1000);
  assert.equal(displayDelayMs({ timeline: { active: () => false } }), 15_000);
  assert.equal(displayDelayMs({ timeline: { active: () => true } }), 0);
});

test('military records judge absence at the layer clock and reset at a jump', () => {
  let now = T;
  const store = new MilitaryFlightRecords({
    geoidHeight: () => 0,
    cachedGroundFloor: () => null,
    floorAltitudeM: (altitude) => altitude,
    now: () => now,
  });
  const { meta } = store.receive(
    {
      id: 'ae0001',
      reference: 'ae0001',
      latitude: 39,
      longitude: -77,
      baroAltitudeM: 3000,
      onGround: false,
      positionTimeMs: T - 1_000,
    },
    { observedAtMs: T, floorWarmPoints: [] },
  );
  assert.equal(meta.observedReceiptMs, T);
  assert.equal(
    store.absence('ae0001', { complete: true, tracked: true }),
    'stale',
  );
  now = T + 11 * 60_000;
  assert.equal(
    store.absence('ae0001', { complete: true, tracked: true }),
    'remove',
  );
  store.receive(
    { id: 'ae0001', latitude: 39, longitude: -77, positionTimeMs: T },
    { observedAtMs: T, floorWarmPoints: [] },
  );
  store.absence('ae0001', { complete: true });
  store.reset();
  assert.equal(store.data.size, 0);
  assert.equal(store.missingPolls.size, 0);
  assert.equal(store.lastSnapshotMs, null);
});

test('military polls carry no time; a snapshot at a time carries it, and polls stop following', async () => {
  const queries = [];
  const applied = [];
  let follows = false;
  const feed = createMilitaryFeed({
    async getSnapshot(query) {
      queries.push(query);
      return { records: [], observedAtMs: T, freshness: 'current' };
    },
  });
  const { methods } = createIngestion({
    feed,
    applySnapshot: (_snapshot, _viewer, options) => {
      applied.push(options);
      return { count: 0, ids: new Set() };
    },
    setSourceLabel: () => {},
    applyPendingTrackingRestore: () => {},
    followsClock: () => follows,
  });
  await methods.update(null);
  assert.deepEqual(queries, [{}]);
  assert.deepEqual(applied, [undefined]);
  follows = true;
  await methods.update(null);
  assert.equal(queries.length, 1, 'no poll while following');
  assert.equal(await methods.loadAt(T, { replace: true }), true);
  assert.deepEqual(queries[1], { atMs: T });
  assert.deepEqual(applied[1], { replace: true });
});
