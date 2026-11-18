import test from 'node:test';
import assert from 'node:assert/strict';
import { createMilitarySnapshotRenderer } from './snapshotRenderer.js';
import { createMotion } from './motion.js';
import { createIngestion, createMilitaryFeed } from './ingestion.js';
import { MilitaryFlightRecords } from './records.js';
import { createClockFollow } from './clockFollow.js';

// Back at live from another time, the first live snapshot stands in for
// every military contact: those it has keep their icon, and only those it
// lacks go (src/time/snapshotTimeline.js).

function harness() {
  const iconIds = new Set();
  const calls = [];
  const flightState = {
    _viewer: null,
    _icons: {
      has: (id) => iconIds.has(id),
      ids: () => [...iconIds],
      get count() {
        return iconIds.size;
      },
    },
    _positionHistory: new Map(),
    _groundSnap: { forget() {} },
    _models: new Map(),
    _trackedModel: null,
    _trackedIcao: null,
    records: { data: new Map() },
  };
  const parts = {
    rendering: {
      _modelOwnsVisual: () => false,
      _syncModelToClass() {},
      _groundSampleExclusions: () => ({ sets: [] }),
    },
    icons: {
      _addIcon: (id) => {
        calls.push(['add', id]);
        iconIds.add(id);
      },
      _applyIconPresentation() {},
      _planIcon: (id, options) => calls.push(['plan', id, options]),
      _forgetContact: (id) => {
        calls.push(['forget', id]);
        iconIds.delete(id);
      },
    },
  };
  const services = {
    camera: { trackedModelScaleForPixelCap: () => 1 },
    focus: {},
    groundFloor: { cachedGroundFloor: () => null, GROUND_FLOOR_LIFT_M: 0.5 },
    meshFloor: { sampleMeshFloorCells() {} },
  };
  parts.motion = createMotion({ flightState, services, parts, layer: {} });
  const records = new MilitaryFlightRecords({
    geoidHeight: () => 0,
    cachedGroundFloor: () => null,
    floorAltitudeM: (altitude) => altitude,
    now: () => Date.now(),
  });
  flightState.records = records;
  flightState.now = () => Date.now();
  flightState._displayCourse = new Map();
  flightState._groundSnap.clear = () => {};
  const apply = createMilitarySnapshotRenderer({
    flightState,
    records,
    groundFloor: { warmGroundFloor() {}, cachedGroundFloor: () => null },
    militaryRegistry: { registerMilitaryIcaos() {} },
    rendering: parts.rendering,
    tracking: {},
    motion: parts.motion,
    icons: parts.icons,
    queries: { _likelyLanded: () => false },
  });
  const clockFollow = createClockFollow({
    flightState,
    services: { placement: null },
    parts: { tracking: { _clearTrail() {} } },
  });
  // `ids`: an id, or [id, fix age ms].
  const snapshot = (ids, fields) => ({
    observedAtMs: Date.now(),
    records: ids.map((entry, k) => {
      const [id, ageMs = 5_000] = [entry].flat();
      return {
        id,
        reference: id,
        longitude: -97 + k,
        latitude: 30,
        baroAltitudeM: 3_000,
        onGround: false,
        speedMps: 200,
        courseDeg: 90,
        positionTimeMs: Date.now() - ageMs,
      };
    }),
    complete: true,
    ...fields,
  });
  return {
    calls,
    iconIds,
    apply(ids, options, fields) {
      calls.length = 0;
      return apply(snapshot(ids, fields), null, options);
    },
    // Back at live, as the layer applies its first live snapshot.
    handOver(ids, fields) {
      calls.length = 0;
      const live = snapshot(ids, fields);
      clockFollow.handOverMotion(clockFollow.absentAtHandover(live));
      return apply(live, null, { handover: true });
    },
  };
}

test('the first live military snapshot keeps the icons of contacts it has and drops only those it lacks', () => {
  const h = harness();
  h.apply(['ae0001', 'ae0002']);
  h.handOver(['ae0001', 'ae0003']);
  assert.deepEqual([...h.iconIds].sort(), ['ae0001', 'ae0003']);
  assert.equal(
    h.calls.some(
      ([kind, id]) => id === 'ae0001' && (kind === 'add' || kind === 'forget'),
    ),
    false,
  );
  assert.deepEqual(
    h.calls.find(([kind, id]) => kind === 'plan' && id === 'ae0001'),
    ['plan', 'ae0001', { handover: true }],
  );
  // A plain poll keeps a missing contact as its absence rules say.
  h.apply(['ae0001']);
  assert.deepEqual([...h.iconIds].sort(), ['ae0001', 'ae0003']);
});

test('back at live, only the first live military snapshot applied takes over; a failed poll says so', async () => {
  const applied = [];
  let fail = false;
  const feed = createMilitaryFeed({
    async getSnapshot() {
      if (fail) throw new Error('down');
      return { records: [], observedAtMs: Date.now(), freshness: 'current' };
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
  });
  assert.equal(await methods.resumeLive(null), true);
  await methods.update(null);
  assert.deepEqual(applied, [{ handover: true }, undefined]);
  fail = true;
  const warn = console.warn;
  console.warn = () => {};
  try {
    assert.equal(await methods.resumeLive(null), false);
  } finally {
    console.warn = warn;
  }
});

test('back at live, a partial military snapshot keeps only contacts whose newest fix is recent', () => {
  const h = harness();
  h.apply([
    ['ae0001', 3 * 3_600_000],
    ['ae0002', 60_000],
  ]);
  h.handOver(['ae0003'], { complete: false });
  assert.deepEqual([...h.iconIds].sort(), ['ae0002', 'ae0003']);
});
