// src/data/flightPhase.test.mjs
// Gates on the flight-phase classifier — including, and especially, the cases
// where it must refuse to answer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FLIGHT_DIRECTION,
  FLIGHT_PHASE,
  FLIGHT_PHASE_THRESHOLDS as T,
  classifyFlightPhase,
  flightDirection,
} from './flightPhase.js';

/** An aircraft at Austin (field elevation 165 m) unless told otherwise. */
const at = (overrides = {}) => ({
  onGround: false,
  altitudeM: 165 + 300,
  velocityMps: 70,
  verticalRateMps: 0,
  ...overrides,
});
const KAUS = { fieldElevationM: 165 };

test('on the ground, taxi and runway split on ground speed', () => {
  const taxi = classifyFlightPhase(
    at({ onGround: true, velocityMps: 8 }),
    KAUS,
  );
  assert.equal(taxi.phase, FLIGHT_PHASE.TAXI);
  const roll = classifyFlightPhase(
    at({ onGround: true, velocityMps: T.RUNWAY_SPEED_MPS + 1 }),
    KAUS,
  );
  assert.equal(roll.phase, FLIGHT_PHASE.RUNWAY);
  // Exactly at the threshold counts as the runway: 50 kt is far past any taxi
  // speed limit, so the boundary belongs on the runway side.
  assert.equal(
    classifyFlightPhase(
      at({ onGround: true, velocityMps: T.RUNWAY_SPEED_MPS }),
      KAUS,
    ).phase,
    FLIGHT_PHASE.RUNWAY,
  );
});

test('the ground flag beats the altitude, not the other way round', () => {
  // A stale or wrong barometric altitude on a parked aircraft must not put it
  // on approach. The aircraft's own ground flag is the better evidence.
  const parked = classifyFlightPhase(
    { onGround: true, altitudeM: 11_000, velocityMps: 0, verticalRateMps: 0 },
    KAUS,
  );
  assert.equal(parked.phase, FLIGHT_PHASE.TAXI);
});

test('a ground report with no speed is taxi, not a guess at the runway', () => {
  assert.equal(
    classifyFlightPhase({ onGround: true, altitudeM: 165 }, KAUS).phase,
    FLIGHT_PHASE.TAXI,
  );
});

test('climbing splits into takeoff and climb at circuit height', () => {
  const low = classifyFlightPhase(
    at({ altitudeM: 165 + T.CIRCUIT_AGL_M - 1, verticalRateMps: 8 }),
    KAUS,
  );
  assert.equal(low.phase, FLIGHT_PHASE.TAKEOFF);
  const high = classifyFlightPhase(
    at({ altitudeM: 165 + T.CIRCUIT_AGL_M, verticalRateMps: 8 }),
    KAUS,
  );
  assert.equal(high.phase, FLIGHT_PHASE.CLIMB);
});

test('descending splits into approach and descent at the en-route boundary', () => {
  const near = classifyFlightPhase(
    at({ altitudeM: 165 + T.ENROUTE_AGL_M - 1, verticalRateMps: -6 }),
    KAUS,
  );
  assert.equal(near.phase, FLIGHT_PHASE.APPROACH);
  const far = classifyFlightPhase(
    at({ altitudeM: 165 + T.ENROUTE_AGL_M, verticalRateMps: -6 }),
    KAUS,
  );
  assert.equal(far.phase, FLIGHT_PHASE.DESCENT);
});

test('level flight is cruise only when it is well above the field', () => {
  const high = classifyFlightPhase(
    at({ altitudeM: 165 + T.ENROUTE_AGL_M, verticalRateMps: 0 }),
    KAUS,
  );
  assert.equal(high.phase, FLIGHT_PHASE.CRUISE);
  // Level at circuit height is a circuit, a hold or a level-off — the
  // airport's business, and not distinguishable from one sample.
  const low = classifyFlightPhase(
    at({ altitudeM: 165 + 300, verticalRateMps: 0 }),
    KAUS,
  );
  assert.equal(low.phase, FLIGHT_PHASE.AIRBORNE);
});

test('a small vertical rate is level, not a climb', () => {
  // Mode S quantises the rate at 64 ft/min and the air is never still. Calling
  // every non-zero sample a climb would flip the phase, and the frequency,
  // every few seconds.
  for (const rate of [T.LEVEL_RATE_MPS, -T.LEVEL_RATE_MPS, 0.3, -0.3]) {
    const result = classifyFlightPhase(
      at({ altitudeM: 165 + T.ENROUTE_AGL_M + 100, verticalRateMps: rate }),
      KAUS,
    );
    assert.equal(
      result.phase,
      FLIGHT_PHASE.CRUISE,
      `rate ${rate} must read level`,
    );
  }
});

test('WITHOUT A FIELD ELEVATION it refuses to guess, and says why', () => {
  // The whole reason the pack carries elevation. Classifying against sea level
  // would make an aircraft on short final at Denver (1,655 m field) look like
  // it was at 1,655 m AGL — cruise, one band over.
  const result = classifyFlightPhase(at({ verticalRateMps: -6 }), {});
  assert.equal(result.phase, FLIGHT_PHASE.AIRBORNE);
  assert.equal(result.aglM, null);
  assert.ok(result.missing.includes('fieldElevationM'));
});

test('WITHOUT A VERTICAL RATE it refuses to guess, and says why', () => {
  // Level at 3,000 ft and descending through 3,000 ft are the same row without
  // a rate, and they are different controllers.
  const result = classifyFlightPhase(
    { onGround: false, altitudeM: 165 + 900, velocityMps: 70 },
    KAUS,
  );
  assert.equal(result.phase, FLIGHT_PHASE.AIRBORNE);
  assert.equal(result.aglM, 900, 'height above the field is still reported');
  assert.deepEqual(result.missing, ['verticalRateMps']);

  // The case that actually catches a missing guard. Without a rate, a naive
  // implementation falls through to the LEVEL branch — and a null rate
  // compares false against both thresholds, so it looks level. High above the
  // field that silently becomes "cruise", a confident answer built on a
  // datum that was never reported.
  const high = classifyFlightPhase(
    {
      onGround: false,
      altitudeM: 165 + T.ENROUTE_AGL_M + 2_000,
      velocityMps: 240,
    },
    KAUS,
  );
  assert.equal(
    high.phase,
    FLIGHT_PHASE.AIRBORNE,
    'no rate must never read as cruise, however high the aircraft is',
  );
  assert.deepEqual(high.missing, ['verticalRateMps']);
});

test('with nothing to reason from it says unknown, not airborne', () => {
  // "Airborne" is a claim. An aircraft with no altitude and no ground flag has
  // not supported it.
  const nothing = classifyFlightPhase({}, {});
  assert.equal(nothing.phase, FLIGHT_PHASE.UNKNOWN);
  assert.deepEqual(nothing.missing.sort(), [
    'altitudeM',
    'fieldElevationM',
    'verticalRateMps',
  ]);
  // ...but an explicit ground flag of false IS that claim, even with no altitude.
  assert.equal(
    classifyFlightPhase({ onGround: false }, {}).phase,
    FLIGHT_PHASE.AIRBORNE,
  );
});

test('junk inputs are treated as absent rather than coerced', () => {
  for (const junk of [Number.NaN, '465', null, undefined, Infinity]) {
    const result = classifyFlightPhase(
      { onGround: false, altitudeM: junk, verticalRateMps: -6 },
      KAUS,
    );
    assert.ok(
      [FLIGHT_PHASE.AIRBORNE, FLIGHT_PHASE.UNKNOWN].includes(result.phase),
      `altitude ${String(junk)} must not produce a confident phase`,
    );
    assert.ok(result.missing.includes('altitudeM'));
  }
  // A string elevation must not be silently coerced either.
  const coerced = classifyFlightPhase(at({ verticalRateMps: -6 }), {
    fieldElevationM: '165',
  });
  assert.equal(coerced.phase, FLIGHT_PHASE.AIRBORNE);
  assert.ok(coerced.missing.includes('fieldElevationM'));
});

test('every phase carries a reader-facing label', () => {
  const seen = new Set();
  const cases = [
    [at({ onGround: true, velocityMps: 2 }), KAUS],
    [at({ onGround: true, velocityMps: 60 }), KAUS],
    [at({ altitudeM: 200, verticalRateMps: 8 }), KAUS],
    [at({ altitudeM: 5000, verticalRateMps: 8 }), KAUS],
    [at({ altitudeM: 12000, verticalRateMps: 0 }), KAUS],
    [at({ altitudeM: 12000, verticalRateMps: -6 }), KAUS],
    [at({ altitudeM: 600, verticalRateMps: -6 }), KAUS],
    [at({ verticalRateMps: 0 }), KAUS],
    [{}, {}],
  ];
  for (const [info, reference] of cases) {
    const result = classifyFlightPhase(info, reference);
    seen.add(result.phase);
    assert.ok(
      result.label && result.label.length > 2,
      `${result.phase} has no label`,
    );
  }
  assert.equal(seen.size, 9, 'every phase should be exercised');
});

test('flightDirection answers without an airport or an altitude', () => {
  // It exists to break the circular dependency: the phase needs the reference
  // airport's elevation, and choosing that airport needs to know whether the
  // aircraft is leaving one or arriving at one.
  assert.equal(flightDirection({ onGround: true }), FLIGHT_DIRECTION.GROUND);
  assert.equal(
    flightDirection({ onGround: false, verticalRateMps: 8 }),
    FLIGHT_DIRECTION.CLIMBING,
  );
  assert.equal(
    flightDirection({ onGround: false, verticalRateMps: -8 }),
    FLIGHT_DIRECTION.DESCENDING,
  );
  assert.equal(
    flightDirection({ onGround: false, verticalRateMps: 0 }),
    FLIGHT_DIRECTION.LEVEL,
  );
  assert.equal(flightDirection({ onGround: false }), FLIGHT_DIRECTION.UNKNOWN);
  assert.equal(flightDirection(null), FLIGHT_DIRECTION.UNKNOWN);
  // The ground flag wins here too — a rate reported by a parked aircraft is
  // noise, not a climb.
  assert.equal(
    flightDirection({ onGround: true, verticalRateMps: 8 }),
    FLIGHT_DIRECTION.GROUND,
  );
});
