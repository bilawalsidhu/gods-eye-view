import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import {
  joinTrailBackfill,
  trailGroundTransitionBreaks,
} from './trailContinuity.js';

// A history backfill that ends in the air does not join an aircraft now on
// the ground (or the reverse) across a landing or take-off nobody saw: a
// parked plane's track history is often its last flight.

const MIN = 60_000;
const LIMIT = 2_000;
const enu = Cesium.Transforms.eastNorthUpToFixedFrame(
  Cesium.Cartesian3.fromDegrees(-122.21, 37.7, 0),
);
const at = (e, n, u) =>
  Cesium.Matrix4.multiplyByPoint(
    enu,
    new Cesium.Cartesian3(e, n, u),
    new Cesium.Cartesian3(),
  );
const fix = (position, timeMs) => ({
  position,
  timeMs,
  nullAltitude: false,
  drawn: false,
  breakBefore: false,
});

/** The last flight's final waypoint: 5.8 km up, 35 minutes before the taxi. */
const lastFlight = () => ({
  fixes: [fix(at(0, 900, 5_800), 0)],
  breakAfter: false,
});
const taxi = () => [fix(at(0, 0, 2), 35 * MIN), fix(at(40, -20, 2), 36 * MIN)];

test('an unseen landing or take-off breaks the join', () => {
  assert.equal(trailGroundTransitionBreaks(false, true, 35 * MIN), true);
  assert.equal(trailGroundTransitionBreaks(true, false, 35 * MIN), true);
  assert.equal(trailGroundTransitionBreaks(false, true, 4 * MIN), false);
  assert.equal(trailGroundTransitionBreaks(false, false, 35 * MIN), false);
  assert.equal(trailGroundTransitionBreaks(true, true, 35 * MIN), false);
});

test('an airborne history does not join a taxiing aircraft', () => {
  const joined = joinTrailBackfill(lastFlight(), taxi(), LIMIT, {
    backfillEndsOnGround: false,
    onGroundNow: true,
    nowMs: 36 * MIN,
  });
  assert.equal(joined.length, 3);
  assert.equal(joined[1].breakBefore, true);
});

test('without the ground state the join is unchanged', () => {
  const joined = joinTrailBackfill(lastFlight(), taxi(), LIMIT);
  assert.equal(joined[1].breakBefore, false);
});

test('a landing seen in the history still joins', () => {
  const history = {
    fixes: [fix(at(0, 900, 300), 31 * MIN)],
    breakAfter: false,
  };
  const joined = joinTrailBackfill(history, taxi(), LIMIT, {
    backfillEndsOnGround: false,
    onGroundNow: true,
    nowMs: 36 * MIN,
  });
  assert.equal(joined[1].breakBefore, false);
});

test('with no live fix, an unseen transition leaves the history out', () => {
  const ground = {
    backfillEndsOnGround: false,
    onGroundNow: true,
    nowMs: 35 * MIN,
  };
  assert.deepEqual(joinTrailBackfill(lastFlight(), [], LIMIT, ground), []);
  assert.equal(
    joinTrailBackfill(lastFlight(), [], LIMIT, {
      ...ground,
      onGroundNow: false,
    }).length,
    1,
  );
});

test('the first live report decides, not the aircraft now', () => {
  // Held short with no history waypoints, then took off inside the live
  // window: the history and the first live report are both on the ground.
  const held = {
    fixes: [fix(at(0, 0, 2), 0)],
    breakAfter: false,
  };
  const live = taxi().map((f) => ({ ...f, onGround: true }));
  const joined = joinTrailBackfill(held, live, LIMIT, {
    backfillEndsOnGround: true,
    onGroundNow: false,
    nowMs: 36 * MIN,
  });
  assert.equal(joined[1].breakBefore, false);
});
