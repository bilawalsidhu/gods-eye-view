import test from 'node:test';
import assert from 'node:assert/strict';
import { FlightRecords } from './records.js';
import { createIngestion } from './ingestion.js';
import { createClockFollow } from './clockFollow.js';
import { displayDelayMs, followsClock, RENDER_DELAY_SEC } from './policy.js';

// Flights follow the world clock only while their source declares a timeline
// (src/time/snapshotTimeline.js); these cover the layer's side of it.

const T = 1_800_000_000_000;
const following = { timeline: { active: () => true } };
const live = { timeline: { active: () => false } };

function records(now = () => T) {
  return new FlightRecords({
    geoidHeight: () => 0,
    cachedGroundFloor: () => null,
    floorAltitudeM: (altitude) => altitude,
    now,
  });
}
const view = () => ({
  viewerLatDeg: null,
  viewerLonDeg: null,
  trackedId: null,
  floorWarmPoints: [],
});
const observation = (fields = {}) => ({
  id: 'abc123',
  reference: 'abc123',
  longitude: -77,
  latitude: 39,
  callsign: 'TEST1',
  baroAltitudeM: 1000,
  onGround: false,
  speedMps: 120,
  courseDeg: 90,
  positionTimeMs: T - 5_000,
  ...fields,
});

test('contacts are drawn behind the live edge, and at the time following the clock', () => {
  assert.equal(displayDelayMs({ timeline: null }), RENDER_DELAY_SEC * 1000);
  assert.equal(displayDelayMs({}), RENDER_DELAY_SEC * 1000);
  assert.equal(displayDelayMs(live), RENDER_DELAY_SEC * 1000);
  assert.equal(displayDelayMs(following), 0);
  assert.equal(followsClock({}), false);
  assert.equal(followsClock(following), true);
});

test('civil records judge absence and receipt at the layer clock', () => {
  let now = T;
  const store = records(() => now);
  const { meta } = store.receive(observation({ positionTimeMs: null }), view());
  assert.equal(meta.observedReceiptMs, T);
  assert.equal(meta.newestFixMs, T, 'an undated fix is the clock time');
  assert.equal(
    store.absence('abc123', { complete: true, tracked: true }),
    'stale',
  );
  assert.equal(
    store.absence('abc123', {
      complete: true,
      tracked: true,
      nowMs: T + 11 * 60_000,
    }),
    'remove',
    'a given time judges retention',
  );
  store.receive(observation(), view());
  now = T + 11 * 60_000;
  assert.equal(
    store.absence('abc123', { complete: true, tracked: true }),
    'remove',
    'the clock judges retention when no time is given',
  );
});

test('a records reset forgets where airframes were and keeps what they are', () => {
  const store = records();
  const first = store.receive(observation(), view());
  first.meta.typeCode = 'B738';
  first.meta.registration = 'N123';
  first.meta.photo = { src: 'photo.jpg' };
  store.absence('abc123', { complete: true });
  store.beginSnapshot(T);
  store.reset();
  assert.equal(store.data.size, 0);
  assert.equal(store.missingPolls.size, 0);
  assert.equal(store.lastSnapshotMs, null);
  const again = store.receive(
    observation({ positionTimeMs: T - 600_000, callsign: 'OTHER' }),
    view(),
  );
  assert.equal(again.prevMeta, undefined, 'no motion carries across');
  assert.equal(again.groundFlipped, false);
  assert.equal(again.meta.typeCode, 'B738');
  assert.equal(again.meta.registration, 'N123');
  assert.equal(again.meta.photo.src, 'photo.jpg');
  assert.equal(again.meta.newestFixMs, T - 600_000, 'an earlier fix applies');
  store.forget('abc123');
  assert.equal(store.airframes.size, 0);
});

function ingestion(source, { follows = false } = {}) {
  const feed = {
    _source: source,
    _activeUpdateControllers: new Set(),
    _trackingRefreshEpoch: 0,
    _lastSource: 'Fixture',
    _retryAt: 0,
  };
  const applied = [];
  const state = { follows };
  const { methods } = createIngestion({
    feed,
    getQuery: () => ({ latitude: 39 }),
    applySnapshot: (snapshot, _viewer, options) => {
      applied.push({ snapshot, options });
      return { count: 1, ids: new Set() };
    },
    setSourceLabel: () => {},
    applyPendingTrackingRestore: () => {},
    followsClock: () => state.follows,
  });
  return { feed, applied, state, methods };
}

test('civil polls carry no time; a snapshot at a time carries it and replaces', async () => {
  const queries = [];
  const probe = ingestion({
    async getSnapshot(query) {
      queries.push(query);
      return { records: [], observedAtMs: T - 60_000, freshness: 'current' };
    },
  });
  await probe.methods.update(null);
  assert.deepEqual(queries[0], { latitude: 39 });
  assert.equal(probe.applied[0].options, undefined);
  assert.equal(await probe.methods.loadAt(T - 60_000, { replace: true }), true);
  assert.deepEqual(queries[1], { latitude: 39, atMs: T - 60_000 });
  assert.deepEqual(probe.applied[1].options, { replace: true });
  assert.equal(probe.feed._lastUpdate, T - 60_000);
});

test('following the clock, civil polls stop and a poll already out is dropped', async () => {
  let release;
  const probe = ingestion({
    getSnapshot: () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  });
  const out = probe.methods.update(null);
  probe.state.follows = true;
  release({ records: [], observedAtMs: T, freshness: 'current' });
  await out;
  assert.equal(probe.applied.length, 0);
  await probe.methods.update(null);
  assert.equal(probe.applied.length, 0, 'no poll while following');
});

test('a failed snapshot at a time reports it without holding the live backoff', async () => {
  const probe = ingestion({
    async getSnapshot() {
      throw Object.assign(new Error('nope'), { retryAfterMs: 60_000 });
    },
  });
  assert.equal(await probe.methods.loadAt(T), false);
  assert.equal(probe.feed._retryAt, 0);
  assert.equal(probe.feed._lastError, 'Live data unavailable');
});

test('a jump forgets how contacts moved; clearing drops every contact', () => {
  const calls = [];
  const flightState = {
    records: records(),
    _positionHistory: new Map([['abc123', []]]),
    _displayCourse: new Map([['abc123', 90]]),
    _groundSnap: { clear: () => calls.push('ground') },
    _displayFloorState: new Map([['abc123', {}]]),
    _drReconcileValid: true,
    _cachedDRFrame: 7,
    _billboards: new Map([['abc123', { id: 'abc123' }]]),
    _billboardCollection: { remove: () => calls.push('remove') },
    _cullPositions: new Map([['abc123', null]]),
    _detectionObjects: new Map([['abc123', {}]]),
    _trackedIcao: 'abc123',
    feed: { _count: 1, _lastUpdate: T },
  };
  const parts = {
    tracking: {
      _clearTrail: () => calls.push('trail'),
      _clearTracking: (_skip, { evicted }) => {
        calls.push(`untrack:${evicted}`);
        flightState._trackedIcao = null;
      },
    },
    rendering: { _releaseModel: (id) => calls.push(`model:${id}`) },
  };
  const follow = createClockFollow({ flightState, parts });
  flightState.records.receive(observation(), view());
  follow.resetMotion();
  assert.equal(flightState.records.data.size, 0);
  assert.equal(flightState._positionHistory.size, 0);
  assert.equal(flightState._displayCourse.size, 0);
  assert.equal(flightState._displayFloorState.size, 0);
  assert.equal(flightState._drReconcileValid, false);
  assert.equal(flightState._billboards.size, 1, 'contacts stay until replaced');
  follow.clear();
  assert.equal(flightState._billboards.size, 0);
  assert.equal(flightState._detectionObjects.size, 0);
  assert.equal(flightState.feed._count, 0);
  assert.equal(flightState.feed._lastUpdate, null);
  assert.ok(calls.includes('untrack:true'));
  assert.ok(calls.includes('model:abc123'));
});

test('a snapshot at a time the source drops for a newer one sets no error', async () => {
  const probe = ingestion({
    async getSnapshot() {
      throw new DOMException('Superseded', 'AbortError');
    },
  });
  await assert.rejects(probe.methods.loadAt(T), { name: 'AbortError' });
  assert.equal(probe.feed._lastError, undefined);
  assert.equal(probe.feed._backoff, undefined);
  assert.equal(probe.feed._retryAt, 0);
});
