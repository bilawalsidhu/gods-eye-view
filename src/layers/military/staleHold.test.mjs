import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { createMotion } from './motion.js';
import { createFlightState } from './state.js';
import { createTracking } from './tracking.js';
import { TRAIL_CONTINUITY_MAX_SPEED_KT } from '../../data/trailContinuity.js';
import { RENDER_DELAY_SEC } from './policy.js';

const SEC = 1000;

function motionFixture({ info, fixes, nowMs, ground = () => null }) {
  const flightState = {
    records: { data: new Map([['00a003', info]]) },
    _positionHistory: new Map([['00a003', fixes]]),
    _scratchArc: {},
    _scratchOffset: new Cesium.Cartesian3(),
    _scratchEnu: new Cesium.Matrix4(),
    _scratchRenderTime: new Cesium.JulianDate(),
    now: () => nowMs,
  };
  const motion = createMotion({
    flightState,
    services: {
      groundFloor: { cachedGroundFloor: ground },
      camera: {},
      focus: {},
    },
    parts: {},
  });
  return motion;
}

function fix(timeMs, lat, lon, heightM, velocity, track) {
  return {
    time: Cesium.JulianDate.fromDate(new Date(timeMs)),
    epochMs: timeMs,
    position: Cesium.Cartesian3.fromDegrees(lon, lat, heightM),
    velocity,
    track,
  };
}

test('a military contact stale after a low approach holds at its last report', () => {
  const t0 = Date.UTC(2026, 10, 9, 20, 0);
  const ground = 1_590; // An airbase, ellipsoidal.
  const fixes = [
    fix(t0, 35.03, -106.58, ground + 300, 75, 260),
    fix(t0 + 10 * SEC, 35.03, -106.588, ground + 40, 70, 260),
  ];
  const info = {
    altitudeFt: 5_350,
    renderAltitudeM: ground + 40,
    rawLat: 35.03,
    rawLon: -106.588,
    speedMps: 70,
    track: 260,
    onGround: false,
  };
  for (const afterSec of [10, 60, 200]) {
    const motion = motionFixture({
      info,
      fixes,
      nowMs: t0 + 10 * SEC + RENDER_DELAY_SEC * SEC + afterSec * SEC,
      ground: () => ground,
    });
    const drawn = motion._deadReckon('00a003', new Cesium.Cartesian3());
    assert.ok(Cesium.Cartesian3.distance(drawn, fixes[1].position) < 0.01);
  }
});

test('a cruising military contact still heard after its last position coasts past 90 s, for up to 5 minutes, then stops', () => {
  const t0 = Date.UTC(2026, 10, 9, 20, 0);
  const fixes = [
    fix(t0, 36, -115, 9_000, 220, 90),
    fix(t0 + 10 * SEC, 36, -114.975, 9_000, 220, 90),
  ];
  const info = {
    altitudeFt: 29_500,
    renderAltitudeM: 9_000,
    rawLat: 36,
    rawLon: -114.975,
    speedMps: 220,
    track: 90,
    onGround: false,
    lastContactEpochMs: t0 + 10 * SEC + 300 * SEC,
  };
  const at = (afterSec) =>
    motionFixture({
      info,
      fixes,
      nowMs: t0 + 10 * SEC + RENDER_DELAY_SEC * SEC + afterSec * SEC,
    })._deadReckon('00a003', new Cesium.Cartesian3());
  const d = (p) => Cesium.Cartesian3.distance(p, fixes[1].position);
  const near = (got, want) => Math.abs(got - want) < want * 0.005 + 50;
  assert.ok(near(d(at(45)), 220 * 45));
  assert.ok(near(d(at(250)), 220 * 250), 'still moving at 250 s');
  assert.ok(near(d(at(400)), 220 * 300), 'stopped at 300 s');
});

test('a bad military speed coasts no faster than the 1,500 kt continuity limit', () => {
  const t0 = Date.UTC(2026, 10, 9, 20, 0);
  const fixes = [
    fix(t0, 36, -115, 9_000, 2_000, 90),
    fix(t0 + 10 * SEC, 36, -114.975, 9_000, 2_000, 90),
  ];
  const info = {
    altitudeFt: 29_500,
    renderAltitudeM: 9_000,
    rawLat: 36,
    rawLon: -114.975,
    speedMps: 2_000,
    track: 90,
    onGround: false,
  };
  const drawn = motionFixture({
    info,
    fixes,
    nowMs: t0 + 10 * SEC + RENDER_DELAY_SEC * SEC + 300 * SEC,
  })._deadReckon('00a003', new Cesium.Cartesian3());
  const limitMps = (TRAIL_CONTINUITY_MAX_SPEED_KT * 1852) / 3600;
  const d = Cesium.Cartesian3.distance(drawn, fixes[1].position);
  assert.ok(Math.abs(d - limitMps * 300) < 1_500, `${d.toFixed(0)} m`);
});

test('a holding military contact draws no head and its trail ends at the last report', () => {
  const t0 = Date.UTC(2026, 10, 9, 20, 0);
  const fixes = [0, 1, 2].map((i) =>
    fix(t0 + i * 10 * SEC, 35.03, -106.57 - i * 0.008, 1_700, 70, 260),
  );
  const svc = {
    ...Object.fromEntries(
      [
        'picking',
        'sprites',
        'aircraftPresentation',
        'camera',
        'militaryRegistry',
        'labels',
        'meshFloor',
        'focus',
        'readout',
        'context',
        'render',
        'recession',
      ].map((name) => [name, {}]),
    ),
    groundSnap: { createGroundSnap: () => ({ clear() {} }) },
    geoid: { ensureGeoidReady: async () => {}, geoidHeight: () => 0 },
    groundFloor: {
      resolveGroundFloorCellsBounded: async () => {},
      cachedGroundFloor: () => null,
      floorAltitudeM: (alt) => alt,
    },
  };
  const calls = [];
  svc.trails = {
    createTrail: () => ({
      setSegments: (segments) => calls.push(segments.flat()),
      setPositions: (positions) => calls.push(positions.slice()),
      setVisible() {},
      clear() {},
      destroy() {},
    }),
  };
  const flightState = createFlightState({ services: svc, source: {} });
  const added = [];
  flightState._viewer = {
    isDestroyed: () => false,
    entities: {
      add: (definition) => (added.push(definition), definition),
      remove() {},
    },
  };
  flightState._trackedIcao = '00a003';
  flightState.now = () => t0 + 20 * SEC + RENDER_DELAY_SEC * SEC + 120 * SEC;
  flightState._positionHistory.set('00a003', fixes);
  const last = Cesium.Cartesian3.clone(fixes[2].position);
  const tracking = createTracking({
    flightState,
    services: svc,
    parts: {
      motion: {
        _isTrackWarmingUp: () => false,
        _trackedTrailCached: () => last,
        _trackedDisplayPosition: () => last,
        _trackedModelCenterWorld: () => null,
        _trackedModelEnvelopeM: () => null,
      },
    },
    layer: {},
  });
  tracking._startTrail('00a003');
  assert.equal(calls.at(-1).length, 3);
  const head = added.find((d) =>
    String(d.id).startsWith('gev-trail:mil-head-'),
  );
  assert.deepEqual(head.polyline.positions.getValue(), []);
});
