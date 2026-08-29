// Camera ground-guard policy tests: pure arithmetic, no scene, no network.
//
// Arrival framing is computed before the destination's tiles exist, so it works
// from a PREDICTED ground height. Measured cold at one test site the DEM came back
// ~134 m below the rendered surface, often after the flight had already happened,
// and the preset fallback defaults to sea level, so the eye ends up buried by
// roughly the local elevation. The guard measures the real surface after arrival
// and lifts the eye; these tests pin when it acts.
//
// Heights below use Denver (~1,609 m) as the worked example.
//
// Run with: npm test   (node --test)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MIN_EYE_CLEARANCE_M,
  groundClearanceDeficitM,
} from './cameraGroundGuard.js';

test('a buried camera is lifted clear of the surface', () => {
  // The failure shape: framed near sea level, arriving over ground at ~1,609 m.
  const lift = groundClearanceDeficitM(140, 1609);
  assert.equal(lift, 1609 + MIN_EYE_CLEARANCE_M - 140);
  assert.ok(lift > 1000, 'a kilometre-deep burial must be fully corrected');
});

test('a camera resting on the pavement is lifted to a usable height', () => {
  // The state after the elevation fix alone: no longer underground, but 2 m AGL,
  // which renders as a blurry close-up of the ground.
  const lift = groundClearanceDeficitM(1611, 1609);
  assert.equal(lift, MIN_EYE_CLEARANCE_M - 2);
});

test('a well-framed arrival is left completely alone', () => {
  // 146 m above ground is a good view; correcting it would be meddling.
  assert.equal(groundClearanceDeficitM(1755, 1609), 0);
  // Comfortably high arrivals likewise.
  assert.equal(groundClearanceDeficitM(2960, 1609), 0);
});

test('sub-metre noise never triggers a nudge', () => {
  // Exactly at the clearance, and a hair under it, must both read as settled.
  // Otherwise the camera twitches every time the sampler jitters.
  assert.equal(groundClearanceDeficitM(1609 + MIN_EYE_CLEARANCE_M, 1609), 0);
  assert.equal(
    groundClearanceDeficitM(1609 + MIN_EYE_CLEARANCE_M - 1, 1609),
    0,
  );
});

test('an unmeasurable surface is never acted on', () => {
  // sampleHeight returns NaN until tiles stream in. Guessing at that moment is
  // exactly the mistake that caused the bug; the guard must simply wait.
  assert.equal(groundClearanceDeficitM(1000, Number.NaN), 0);
  assert.equal(groundClearanceDeficitM(Number.NaN, 1609), 0);
  assert.equal(groundClearanceDeficitM(1000, undefined), 0);
});

test('the clearance is enough to see past a building, not a helicopter ride', () => {
  assert.ok(
    MIN_EYE_CLEARANCE_M >= 60,
    'must clear rooftops to frame a subject',
  );
  assert.ok(
    MIN_EYE_CLEARANCE_M <= 250,
    'must not turn a close landmark shot into an overflight',
  );
});
