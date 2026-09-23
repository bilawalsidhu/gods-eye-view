// src/data/deadReckonContracts.test.mjs
// Wave-6 (cycle 4) contracts for the two layer forks of `_deadReckon` — the
// per-frame estimator that positions every aircraft between polls. This is
// the load-bearing flight-path math (interpolate → warm-up → coast), so the
// tests run the REAL estimator against seeded history (the same seams the
// tracking suites use) and pin position answers computed independently in
// the ENU frame. No viewer, no mock choreography.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as Cesium from 'cesium';

import {
  _addFlightTrackingCandidateForTest,
  _deadReckonForTest as civilDeadReckon,
} from './flights.js';
import {
  _addMilitaryTrackingCandidateForTest,
  _deadReckonForTest as militaryDeadReckon,
} from './militaryFlights.js';
import { arcOffsetEnu } from './motionModel.js';

const sec = (n) => Cesium.JulianDate.addSeconds(Cesium.JulianDate.now(), n, new Cesium.JulianDate());
const at = (lonDeg, latDeg, hM) => Cesium.Cartesian3.fromDegrees(lonDeg, latDeg, hM);
const enuOffset = (fix, eastM, northM) => Cesium.Matrix4.multiplyByPoint(
  Cesium.Transforms.eastNorthUpToFixedFrame(fix.position, Cesium.Ellipsoid.WGS84, new Cesium.Matrix4()),
  new Cesium.Cartesian3(eastM, northM, 0),
  new Cesium.Cartesian3(),
);
const near = (actual, expected, tolM, msg) => {
  const d = Cesium.Cartesian3.distance(actual, expected);
  assert.ok(d < tolM, `${msg} (off by ${d.toFixed(3)} m)`);
};

// One estimator suite per layer fork: the field names differ (civil
// `velocity`/`true_track`, military `speedMps`/`track`) but the contracts —
// bracket → warm-up backward → contact-bounded coast — must hold on BOTH.
function estimatorContracts(name, deadReckon, seed) {
  test(`${name}: no history is a null position, not a throw`, () => {
    assert.equal(deadReckon('never-seen', new Cesium.Cartesian3()), null);
  });

  test(`${name}: between two fixes the icon rides the bracket midpoint`, () => {
    // renderTime runs at now − 30 s, so fixes at −40 s and −20 s bracket it
    // exactly: t = 0.5, and the displayed position is the chord midpoint.
    const a = { time: sec(-40), position: at(0, 0, 10_000), track: 90 };
    const b = { time: sec(-20), position: at(0.01, 0, 10_000), track: 100 };
    seed({
      icao24: 'bracket',
      meta: { velocity: 60, true_track: 95, speedMps: 60, track: 95, klass: 'helicopter' },
      history: [a, b],
    });
    const out = deadReckon('bracket', new Cesium.Cartesian3());
    const midpoint = new Cesium.Cartesian3(
      (a.position.x + b.position.x) / 2,
      (a.position.y + b.position.y) / 2,
      (a.position.z + b.position.z) / 2,
    );
    // 1 m bar: the module re-reads the clock per call, so sub-millisecond
    // anchor skew is expected; an endpoint answer would be ~560 m off.
    near(out, midpoint, 1, 't = 0.5 lands on the chord midpoint, not an endpoint');
  });

  test(`${name}: warm-up projects the first fix BACKWARD, capped at one minute`, () => {
    // A single fix 200 s AHEAD of the delayed renderTime (just-started
    // tracking): the icon glides in from behind the first observed fix, but
    // the backward look is bounded to 60 s — not the full 200 s gap.
    const fix = {
      time: sec(170), // renderTime (now − 30) is 200 s behind this fix
      position: at(0, 0, 10_000),
      track: 90, // east
      epochMs: Date.now() + 170_000,
    };
    seed({
      icao24: 'warmup',
      meta: { velocity: 100, true_track: 90, speedMps: 100, track: 90 },
      history: [fix],
    });
    // dt = −min(200, 60) = −60 → 100 m/s × 60 s due WEST of the fix.
    near(deadReckon('warmup', new Cesium.Cartesian3()), enuOffset(fix, -6_000, 0), 0.5,
      'warm-up draws 60 s of track-90 history west of the first fix');
  });

  test(`${name}: coasting is bounded by the freshest contact, then by the floor`, () => {
    // Newest fix 370 s behind renderTime. A contact 120 s fresher than the
    // fix permits lead 120 + 60 grace = 180 s of coast; without any contact
    // clock the 60 s floor applies. Both answers sit under the 300 s ceiling.
    const fix = {
      time: sec(-400), // renderTime (now − 30) is 370 s ahead of this fix
      position: at(0, 0, 10_000),
      track: 90,
      epochMs: Date.now() - 370_000,
    };
    const meta = { velocity: 100, true_track: 90, speedMps: 100, track: 90 };
    seed({ icao24: 'coast', meta: { ...meta, lastContactEpochMs: fix.epochMs + 120_000 }, history: [fix] });
    near(deadReckon('coast', new Cesium.Cartesian3()), enuOffset(fix, 18_000, 0), 0.5,
      'fresh contact coasts the full 180 s grace east of the fix');

    seed({ icao24: 'coast', meta, history: [fix] });
    near(deadReckon('coast', new Cesium.Cartesian3()), enuOffset(fix, 6_000, 0), 0.5,
      'no contact clock falls to the 60 s floor, not the 370 s elapsed');
  });

  test(`${name}: an observed turn rate bends the coast off the straight line`, () => {
    // 3 deg/s for 60 s of coast is a 180°-per-minute arc; a straight-line
    // projection would be off by kilometres. The expected answer integrates
    // the SAME arc the estimator uses (arcOffsetEnu, unit-tested separately)
    // — what is pinned here is that the layer plumbs info.turnRateDps through.
    const fix = {
      time: sec(-100), // renderTime is 70 s ahead → coast 60 s (floor)
      position: at(0, 0, 10_000),
      track: 90,
      epochMs: Date.now() - 100_000,
    };
    seed({
      icao24: 'turning',
      meta: { velocity: 100, true_track: 90, speedMps: 100, track: 90, turnRateDps: 3 },
      history: [fix],
    });
    const arc = arcOffsetEnu(100, 90, 3, 60, { east: 0, north: 0, endCourseDeg: 0 });
    near(deadReckon('turning', new Cesium.Cartesian3()), enuOffset(fix, arc.east, arc.north), 0.5,
      'the coast follows the constant-rate-turn arc');
    // And it genuinely left the tangent: the straight-line answer is far away.
    const straight = enuOffset(fix, 6_000, 0);
    assert.ok(
      Cesium.Cartesian3.distance(deadReckon('turning', new Cesium.Cartesian3()), straight) > 1_000,
      'a 3 deg/s coast is not a straight line',
    );
  });
}

estimatorContracts('civil flights', civilDeadReckon, _addFlightTrackingCandidateForTest);
estimatorContracts('military flights', militaryDeadReckon, _addMilitaryTrackingCandidateForTest);
