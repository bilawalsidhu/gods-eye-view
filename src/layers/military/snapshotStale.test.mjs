import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { createMilitarySnapshotRenderer } from './snapshotRenderer.js';

// A poll that repeats a contact's last position with new speed or course
// must not move it past where the stale rules allow, and never adds a
// report to the tracked trail.

const ICAO = '00a005';
const SEC = 1000;

/** Any property is a no-op function unless given. */
function stub(overrides = {}) {
  return new Proxy(overrides, {
    get: (target, key) => (key in target ? target[key] : () => undefined),
  });
}

function harness({ ground = () => null }) {
  const appended = [];
  const history = [];
  const flightState = {
    _trackedIcao: ICAO,
    _trackedEntity: null,
    _positionHistory: new Map([[ICAO, history]]),
    _billboards: new Map([[ICAO, { position: new Cesium.Cartesian3() }]]),
    _billboardCollection: stub(),
    _cullPositions: new Map(),
    _displayCourse: new Map(),
    _groundSnap: stub(),
    _displayFloorState: new Map(),
    _models: new Map(),
    _viewer: null,
    _cockpitContactMode: false,
    records: { data: new Map() },
  };
  let meta = null;
  let fixEpochMs = 0;
  const records = stub({
    receive: () => {
      flightState.records.data.set(ICAO, meta);
      return { prevMeta: meta, meta, groundFlipped: false, fixEpochMs };
    },
    absence: () => 'retain',
  });
  const apply = createMilitarySnapshotRenderer({
    flightState,
    records,
    militaryRegistry: stub(),
    groundFloor: stub({ cachedGroundFloor: ground }),
    meshFloor: stub(),
    rendering: stub({
      _modelOwnsVisual: () => false,
      _fleetBillboardColor: () => Cesium.Color.WHITE,
    }),
    tracking: stub({
      _militaryLayerSuppresses: () => false,
      _appendTrailFix: (position, epochMs) =>
        appended.push({ position, epochMs }),
    }),
    motion: stub(),
    enrichment: stub(),
    queries: stub({ _likelyLanded: () => false }),
  });
  return {
    history,
    appended,
    poll(nextMeta, epochMs) {
      meta = nextMeta;
      fixEpochMs = epochMs;
      apply({ records: [{ id: ICAO }], complete: true }, null);
    },
  };
}

const lightAircraft = (velocity, track) => ({
  rawLat: 38.1436,
  rawLon: -122.5561,
  renderAltitudeM: 10,
  altitudeFt: 130,
  speedMps: velocity,
  track,
  onGround: false,
  wasAirborne: true,
  klass: 'light',
});

test('military: a low contact whose position repeats while its speed changes is not moved and adds nothing to the trail', (t) => {
  const t0 = Date.UTC(2026, 10, 9, 20, 0);
  t.mock.timers.enable({ apis: ['Date'], now: t0 });
  const h = harness({ ground: () => -30 });
  h.poll(lightAircraft(36.4, 63), t0);
  const first = h.history[0].position;
  for (const [i, velocity] of [30, 22, 14, 9].entries()) {
    t.mock.timers.tick(10 * SEC);
    h.poll(lightAircraft(velocity, 63 + i * 20), t0);
  }
  assert.equal(h.history.length, 1, 'a synthetic fix moved a holding contact');
  assert.equal(h.history[0].position, first);
  assert.equal(h.appended.length, 1, 'only the real report joins the trail');
});

test('military: a cruising contact whose position repeats coasts no further than the stale cap, and the synthetic fix is not a report', (t) => {
  const t0 = Date.UTC(2026, 10, 9, 20, 0);
  t.mock.timers.enable({ apis: ['Date'], now: t0 });
  const h = harness({});
  const cruise = (velocity, track) => ({
    rawLat: 36,
    rawLon: -115,
    renderAltitudeM: 9_000,
    altitudeFt: 29_500,
    speedMps: velocity,
    track,
    onGround: false,
    wasAirborne: true,
    klass: 'jet',
  });
  h.poll(cruise(220, 90), t0);
  const report = h.history[0].position;
  t.mock.timers.tick(300 * SEC);
  h.poll(cruise(200, 100), t0);
  assert.equal(h.history.length, 2);
  const moved = Cesium.Cartesian3.distance(report, h.history[1].position);
  assert.ok(
    moved <= 220 * 300 + 1,
    `the synthetic fix coasted ${moved.toFixed(0)} m`,
  );
  assert.equal(h.appended.length, 1, 'the synthetic fix joined the trail');
});

test('military: a report drawn at an invented height says so on its history fix', (t) => {
  const t0 = Date.UTC(2026, 10, 9, 20, 0);
  t.mock.timers.enable({ apis: ['Date'], now: t0 });
  const h = harness({});
  h.poll({ ...lightAircraft(60, 90), renderAltitudeInvented: true }, t0);
  h.poll({ ...lightAircraft(60, 90), rawLon: -122.55 }, t0 + 10 * SEC);
  assert.equal(h.history[0].inventedHeight, true);
  assert.equal(h.history[1].inventedHeight, false);
});

test('military: with the ground unknown, a low barometric altitude alone does not hold a contact', (t) => {
  const t0 = Date.UTC(2026, 10, 9, 20, 0);
  t.mock.timers.enable({ apis: ['Date'], now: t0 });
  const h = harness({});
  h.poll(lightAircraft(36.4, 63), t0);
  t.mock.timers.tick(10 * SEC);
  h.poll(lightAircraft(30, 80), t0);
  assert.equal(h.history.length, 2);
  assert.equal(h.history[0].staleHolds, false);
  assert.equal(h.appended.length, 1);
});
