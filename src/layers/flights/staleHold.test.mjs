import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { createMotion } from './motion.js';
import { createFlightState } from './state.js';
import { createTracking } from './tracking.js';
import {
  staleCoastSeconds,
  staleHoldsAtLastReport,
} from '../../data/motionModel.js';
import { TRAIL_CONTINUITY_MAX_SPEED_KT } from '../../data/trailContinuity.js';
import { RENDER_DELAY_SEC } from './policy.js';

const SEC = 1000;
// Ellipsoidal ground at a sea-level airfield (geoid about -32 m).
const FIELD_GROUND_M = -30;

/** A motion module over one contact's history, with a fixed clock. */
function motionFixture({ info, fixes, nowMs, ground = () => null }) {
  const flightState = {
    records: { data: new Map([['00a001', info]]) },
    _positionHistory: new Map([['00a001', fixes]]),
    _focusEvidenceIds: new Set(),
    _scratchArc: {},
    _scratchOffset: new Cesium.Cartesian3(),
    _scratchRenderTime: new Cesium.JulianDate(),
    _scratchCoastCarto: new Cesium.Cartographic(),
    now: () => nowMs,
  };
  const motion = createMotion({
    flightState,
    services: {
      groundFloor: {
        cachedGroundFloor: ground,
        floorAltitudeM: (alt, g) =>
          Number.isFinite(g) ? Math.max(alt, g + 1.5) : alt,
      },
      camera: {},
      focus: {},
    },
    parts: {},
  });
  return { flightState, motion };
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

const height = (position) => Cesium.Cartographic.fromCartesian(position).height;

test('a stale contact holds at its last report when it reported on the ground or low', () => {
  assert.equal(staleHoldsAtLastReport({ onGround: true }), true);
  // A light aircraft on final: -30 m barometric, its render height 1.5 m above the known ground.
  assert.equal(
    staleHoldsAtLastReport({
      onGround: false,
      heightM: FIELD_GROUND_M + 1.5,
      groundM: FIELD_GROUND_M,
    }),
    true,
  );
  // Ground unknown: a low barometric altitude alone does not hold it; it
  // coasts under the cap.
  assert.equal(
    staleHoldsAtLastReport({ onGround: false, heightM: 120 }),
    false,
  );
  // A high airfield: 1,600 m barometric but 60 m above its ground.
  assert.equal(
    staleHoldsAtLastReport({
      onGround: false,
      heightM: 1_660,
      groundM: 1_600,
    }),
    true,
  );
  assert.equal(
    staleHoldsAtLastReport({
      onGround: false,
      heightM: 10_000,
      groundM: 20,
    }),
    false,
  );
});

test('a stale contact coasts up to its source limit at any speed, and a holding one not at all', () => {
  const coast = (over) =>
    staleCoastSeconds({
      elapsedSec: 400,
      coastLimitSec: 300,
      speedMps: 230,
      holds: false,
      ...over,
    });
  assert.equal(coast(), 300);
  assert.equal(coast({ elapsedSec: 200 }), 200);
  assert.equal(coast({ coastLimitSec: 60 }), 60);
  assert.equal(coast({ speedMps: 1_000 }), 300);
  assert.equal(coast({ holds: true }), 0);
  assert.equal(coast({ elapsedSec: -5 }), 0);
});

test('a light aircraft on short final goes stale after a low, slow, descending report, the icon holds at that report, not below the ground', () => {
  const t0 = Date.UTC(2026, 10, 9, 20, 0);
  const fixes = [
    fix(t0, 38.1279, -122.5425, 122, 40, 340),
    fix(t0 + 30 * SEC, 38.133, -122.5494, 38, 37, 10),
    fix(t0 + 60 * SEC, 38.1436, -122.5561, FIELD_GROUND_M + 1.5, 36.4, 63),
  ];
  const info = {
    altitude: -30,
    renderAltitudeM: FIELD_GROUND_M + 1.5,
    rawLat: 38.1436,
    rawLon: -122.5561,
    velocity: 36.4,
    true_track: 63,
    onGround: false,
    wasAirborne: true,
    lastContactEpochMs: t0 + 60 * SEC,
  };
  for (const afterSec of [5, 45, 90, 240]) {
    const nowMs = t0 + 60 * SEC + RENDER_DELAY_SEC * SEC + afterSec * SEC;
    const { motion } = motionFixture({
      info,
      fixes,
      nowMs,
      ground: () => FIELD_GROUND_M,
    });
    const drawn = motion._deadReckon('00a001', new Cesium.Cartesian3());
    assert.ok(
      Cesium.Cartesian3.distance(drawn, fixes[2].position) < 0.01,
      `${afterSec} s after the report the icon is at the report`,
    );
    assert.ok(height(drawn) >= FIELD_GROUND_M);
  }
});

function cruiser(lastContactAfterSec) {
  const t0 = Date.UTC(2026, 10, 9, 20, 0);
  const fixes = [
    fix(t0, 40, -100, 10_000, 230, 90),
    fix(t0 + 15 * SEC, 40, -99.96, 10_000, 230, 90),
  ];
  const info = {
    altitude: 10_000,
    renderAltitudeM: 10_000,
    rawLat: 40,
    rawLon: -99.96,
    velocity: 230,
    true_track: 90,
    onGround: false,
    wasAirborne: true,
    lastContactEpochMs: t0 + 15 * SEC + lastContactAfterSec * SEC,
  };
  const at = (afterSec) => {
    const nowMs = t0 + 15 * SEC + RENDER_DELAY_SEC * SEC + afterSec * SEC;
    const { motion } = motionFixture({ info, fixes, nowMs });
    return motion._deadReckon('00a001', new Cesium.Cartesian3());
  };
  const d = (p) => Cesium.Cartesian3.distance(p, fixes[1].position);
  return { at, d };
}

test('a cruising contact still heard after its last position coasts past 90 s, for up to 5 minutes, then stops', () => {
  // Contact kept arriving for four minutes after the last position.
  const { at, d } = cruiser(240);
  const near = (got, want) => Math.abs(got - want) < want * 0.005 + 50;
  assert.ok(near(d(at(90)), 230 * 90));
  assert.ok(near(d(at(200)), 230 * 200), 'still moving at 200 s');
  assert.ok(near(d(at(300)), 230 * 300));
  assert.ok(near(d(at(400)), 230 * 300), 'stopped at 300 s');
  assert.ok(Cesium.Cartesian3.distance(at(400), at(600)) < 0.01);
});

test('a cruising contact that stops reporting coasts five minutes, then stops', () => {
  const { at, d } = cruiser(0);
  assert.ok(Math.abs(d(at(60)) - 230 * 60) < 120);
  assert.ok(Math.abs(d(at(300)) - 230 * 300) < 600);
  assert.ok(Cesium.Cartesian3.distance(at(301), at(420)) < 0.01);
});

test('a bad reported speed coasts no faster than the 1,500 kt continuity limit', () => {
  const t0 = Date.UTC(2026, 10, 9, 20, 0);
  // 2,000 m/s (about 3,900 kt): a corrupt velocity, not a real aircraft.
  const fixes = [
    fix(t0, 40, -100, 10_000, 2_000, 90),
    fix(t0 + 15 * SEC, 40, -99.96, 10_000, 2_000, 90),
  ];
  const info = {
    altitude: 10_000,
    renderAltitudeM: 10_000,
    rawLat: 40,
    rawLon: -99.96,
    velocity: 2_000,
    true_track: 90,
    onGround: false,
    wasAirborne: true,
  };
  const nowMs = t0 + 15 * SEC + RENDER_DELAY_SEC * SEC + 300 * SEC;
  const { motion } = motionFixture({ info, fixes, nowMs });
  const drawn = motion._deadReckon('00a001', new Cesium.Cartesian3());
  const limitMps = (TRAIL_CONTINUITY_MAX_SPEED_KT * 1852) / 3600;
  const d = Cesium.Cartesian3.distance(drawn, fixes[1].position);
  assert.ok(Math.abs(d - limitMps * 300) < 1_500, `${d.toFixed(0)} m`);
});

test('coasting never takes a contact below the ground', () => {
  const t0 = Date.UTC(2026, 10, 9, 20, 0);
  const fixes = [
    fix(t0, 39.7, -105.5, 3_400, 80, 270),
    fix(t0 + 15 * SEC, 39.7, -105.514, 3_400, 80, 270),
  ];
  const info = {
    altitude: 3_400,
    renderAltitudeM: 3_400,
    rawLat: 39.7,
    rawLon: -105.514,
    velocity: 80,
    true_track: 270,
    onGround: false,
    wasAirborne: true,
  };
  // 3,000 m under the report, rising to 3,600 m along the coast west.
  const nowMs = t0 + 15 * SEC + RENDER_DELAY_SEC * SEC + 60 * SEC;
  const { motion } = motionFixture({
    info,
    fixes,
    nowMs,
    ground: (lat, lon) => (lon < -105.52 ? 3_600 : 3_000),
  });
  const drawn = motion._deadReckon('00a001', new Cesium.Cartesian3());
  assert.ok(height(drawn) >= 3_600, `height ${height(drawn)}`);
});

// ---------------------------------------------------------------------------
// The trail and head across a stale gap.

function services(trail) {
  const names = [
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
  ];
  return {
    ...Object.fromEntries(names.map((name) => [name, {}])),
    groundSnap: { createGroundSnap: () => ({ clear() {} }) },
    trails: trail,
    geoid: { ensureGeoidReady: async () => {}, geoidHeight: () => 0 },
    groundFloor: {
      resolveGroundFloorCellsBounded: async () => {},
      cachedGroundFloor: () => null,
      floorAltitudeM: (alt) => alt,
    },
  };
}

function trailHarness({ fixes, nowMs, head }) {
  const calls = [];
  const trail = {
    createTrail: () => ({
      setSegments(segments) {
        calls.push(segments.map((segment) => segment.slice()));
      },
      setPositions(positions) {
        calls.push([positions.slice()]);
      },
      setVisible() {},
      clear() {},
      destroy() {},
    }),
  };
  const svc = services(trail);
  const flightState = createFlightState({
    services: svc,
    source: { label: 'Fixture aircraft' },
  });
  const added = [];
  flightState._viewer = {
    isDestroyed: () => false,
    entities: {
      add(definition) {
        added.push(definition);
        return definition;
      },
      remove() {},
    },
  };
  flightState._trackedIcao = '00a001';
  let clock = nowMs;
  flightState.now = () => clock;
  flightState._positionHistory.set('00a001', fixes);
  let headPosition = head;
  const tracking = createTracking({
    flightState,
    services: svc,
    parts: {
      motion: {
        _isTrackWarmingUp: () => false,
        _trackedTrailCached: () => headPosition,
        _trackedDisplayPosition: () => headPosition,
        _trackedModelCenterWorld: () => null,
        _trackedModelEnvelopeM: () => null,
      },
    },
    layer: {},
  });
  const headEntity = () =>
    added.find((definition) =>
      String(definition.id).startsWith('gev-trail:fl-head-'),
    );
  return {
    tracking,
    flightState,
    drawn: () => (calls.at(-1) ?? []).flat(),
    head: () => headEntity().polyline.positions.getValue(),
    setClock: (ms) => {
      clock = ms;
    },
    setHead: (position) => {
      headPosition = position;
    },
  };
}

test('a holding contact draws no head, and the trail ends at the last report, never past the icon', () => {
  const t0 = Date.UTC(2026, 10, 9, 20, 0);
  const fixes = [
    fix(t0, 38.1678, -122.527, 303, 45, 200),
    fix(t0 + 30 * SEC, 38.1279, -122.5425, 122, 40, 340),
    fix(t0 + 60 * SEC, 38.133, -122.5494, 38, 37, 10),
    fix(t0 + 90 * SEC, 38.1436, -122.5561, 0, 36.4, 63),
  ];
  const last = fixes.at(-1).position;
  // The display time is long past the last report; the icon holds there.
  const h = trailHarness({
    fixes,
    nowMs: t0 + 90 * SEC + RENDER_DELAY_SEC * SEC + 120 * SEC,
    head: Cesium.Cartesian3.clone(last),
  });
  h.tracking._startTrail('00a001');
  // Every report, including the last, is in the trail: the head no longer
  // cuts from the one before it to the icon.
  assert.equal(h.drawn().length, 4);
  assert.equal(h.drawn().at(-1), h.flightState._trailFixes.at(-1).position);
  assert.deepEqual(h.head(), []);
});

test('while the display is between reports, the trail stops at the report behind the icon', () => {
  const t0 = Date.UTC(2026, 10, 9, 20, 0);
  // Reports every 10 s; the icon is drawn 30 s behind, between the 2nd and 3rd.
  const fixes = [0, 1, 2, 3, 4, 5].map((i) =>
    fix(t0 + i * 10 * SEC, 40, -100 + i * 0.03, 10_000, 230, 90),
  );
  const nowMs = t0 + 25 * SEC + RENDER_DELAY_SEC * SEC;
  const icon = Cesium.Cartesian3.fromDegrees(-100 + 0.075, 40, 10_000);
  const h = trailHarness({ fixes, nowMs, head: icon });
  h.tracking._startTrail('00a001');
  // Reports at 0, 10 and 20 s are behind the icon (display time 25 s).
  assert.equal(h.drawn().length, 3);
  const head = h.head();
  assert.equal(head.length, 2);
  assert.ok(Cesium.Cartesian3.distance(head[0], fixes[2].position) < 0.01);
});

test('the hold-or-coast decision is made once per report: a floor that resolves mid-coast does not snap the icon back', () => {
  const t0 = Date.UTC(2026, 10, 9, 20, 0);
  const fixes = [
    fix(t0, 39.7, -104.6, 1_900, 70, 270),
    fix(t0 + 15 * SEC, 39.7, -104.6123, 1_900, 70, 270),
  ];
  const info = {
    altitude: 1_950,
    renderAltitudeM: 1_900,
    rawLat: 39.7,
    rawLon: -104.6123,
    velocity: 70,
    true_track: 270,
    onGround: false,
    wasAirborne: true,
    lastContactEpochMs: t0 + 15 * SEC + 120 * SEC,
  };
  // No floor known when the contact goes stale: baro says well clear of the
  // ground, so it coasts. Mid-coast the floor resolves 100 m under the report.
  let ground = () => null;
  const at = (afterSec) => {
    const nowMs = t0 + 15 * SEC + RENDER_DELAY_SEC * SEC + afterSec * SEC;
    const { motion } = motionFixture({
      info,
      fixes,
      nowMs,
      ground: (lat, lon) => ground(lat, lon),
    });
    return motion._deadReckon('00a001', new Cesium.Cartesian3());
  };
  const d = (p) => Cesium.Cartesian3.distance(p, fixes[1].position);
  const before = d(at(30));
  assert.ok(Math.abs(before - 70 * 30) < 50, `coasted ${before.toFixed(0)} m`);
  ground = () => 1_800;
  const after = d(at(31));
  assert.ok(
    after > before,
    `the icon went from ${before.toFixed(0)} m to ${after.toFixed(0)} m`,
  );
});
