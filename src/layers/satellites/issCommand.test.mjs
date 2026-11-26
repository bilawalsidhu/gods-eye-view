import assert from 'node:assert/strict';
import test from 'node:test';
import {
  issCommandCameraOnStation,
  issCommandZoomOffset,
  issCommandZoomRange,
  ISS_COMMAND_ZOOM_RANGE_M,
  issCommandFastOrbit,
  issCommandZoomStep,
} from './issCommand.js';
import { ISS_NORAD } from './policy.js';

test('the zoom eases in to its range and stops there, never past it', () => {
  let distance = 726_000;
  let steps = 0;
  for (; steps < 400; steps++) {
    const step = issCommandZoomStep(distance);
    if (!step) break;
    assert.ok(step > 0 && step < distance - ISS_COMMAND_ZOOM_RANGE_M);
    distance -= step;
  }
  assert.ok(steps < 120); // under two seconds at 60 frames a second
  assert.ok(distance >= ISS_COMMAND_ZOOM_RANGE_M);
  assert.ok(distance <= ISS_COMMAND_ZOOM_RANGE_M * 1.02 + 1e-6);
  // Already closer: nothing to do, and it never pushes the camera back out.
  assert.equal(issCommandZoomStep(180), 0);
});

test('the fast orbit turns the Sun once per lap, part of it in shadow', () => {
  const start = issCommandFastOrbit(0);
  assert.ok(Math.abs(Math.hypot(...start.sun) - 1) < 1e-9);
  assert.equal(start.sunlit, true);
  assert.equal(issCommandFastOrbit(20_000).sunlit, false); // half a lap: below
  const lap = issCommandFastOrbit(40_000);
  lap.sun.forEach((v, i) => assert.ok(Math.abs(v - start.sun[i]) < 1e-9));
});

test('the zoom is offered only from far away', async () => {
  const { ISS_COMMAND_FAR_M, issCommandOffersZoom } =
    await import('./issCommand.js');
  assert.equal(issCommandOffersZoom(726_000), true);
  assert.equal(issCommandOffersZoom(ISS_COMMAND_FAR_M + 1), true);
  // Where the zoom itself stops, and anywhere closer, it is gone.
  assert.equal(issCommandOffersZoom(ISS_COMMAND_ZOOM_RANGE_M * 1.02), false);
  assert.equal(issCommandOffersZoom(150), false);
});

test('an object docked to the ISS is the station too', async () => {
  const { issTrackedOnStation } = await import('./policy.js');
  const NAUKA = 49044;
  // Tracking Nauka, the ISS shares its position; tracking the ISS needs nothing.
  assert.equal(issTrackedOnStation(ISS_NORAD, new Set()), true);
  assert.equal(issTrackedOnStation(ISS_NORAD, null), true);
  assert.equal(issTrackedOnStation(NAUKA, new Set([ISS_NORAD, 68837])), true);
  // Another satellite, with or without neighbours, is not.
  assert.equal(issTrackedOnStation(20580, new Set()), false);
  assert.equal(issTrackedOnStation(20580, new Set([20581])), false);
  assert.equal(issTrackedOnStation(null, new Set([ISS_NORAD])), false);
  assert.equal(issTrackedOnStation(undefined, undefined), false);
});

test('the zoom range only ever shortens, settles at the target range and never runs away', () => {
  let range = 1e9;
  let steps = 0;
  while (steps < 400) {
    const next = issCommandZoomRange(range);
    assert.ok(next <= range, `step ${steps} moved out: ${range} -> ${next}`);
    assert.ok(next >= ISS_COMMAND_ZOOM_RANGE_M, 'never past the target');
    if (next === range) break;
    range = next;
    steps += 1;
  }
  assert.ok(steps < 400, "settles within the loop's budget");
  assert.ok(range <= ISS_COMMAND_ZOOM_RANGE_M * 1.02);
  assert.equal(
    issCommandZoomRange(ISS_COMMAND_ZOOM_RANGE_M),
    ISS_COMMAND_ZOOM_RANGE_M,
  );
  assert.equal(
    issCommandZoomRange(100),
    100,
    'closer than the range: left alone',
  );
  for (const bad of [0, -5, NaN, Infinity])
    assert.ok(
      Object.is(issCommandZoomRange(bad), bad),
      `${bad} passes through`,
    );
});

test('one zoom step shortens the follow offset on its own bearing, and stops at the range', () => {
  const next = issCommandZoomOffset({ x: 3000, y: 4000, z: 0 });
  const range = Math.hypot(next.x, next.y, next.z);
  assert.ok(Math.abs(range - issCommandZoomRange(5000)) < 1e-9);
  assert.ok(Math.abs(next.x / next.y - 3 / 4) < 1e-12, 'the bearing is kept');
  assert.equal(next.z, 0);
  // Already at the range, or closer: no step.
  assert.equal(
    issCommandZoomOffset({ x: ISS_COMMAND_ZOOM_RANGE_M, y: 0, z: 0 }),
    null,
  );
  assert.equal(issCommandZoomOffset({ x: 0, y: 100, z: 0 }), null);
  // Nothing to shorten: no follow offset yet (the follow has not framed).
  assert.equal(issCommandZoomOffset(null), null);
  assert.equal(issCommandZoomOffset(undefined), null);
  assert.equal(issCommandZoomOffset({ x: 0, y: 0, z: 0 }), null);
});

test("the zoom needs the camera following the station's target, framed", () => {
  const target = { key: 'satellites:25544' };
  const on = { followed: target, followFramed: true };
  assert.equal(issCommandCameraOnStation(on, target), true);
  assert.equal(
    issCommandCameraOnStation(
      { followed: target, followFramed: false },
      target,
    ),
    false,
    'not before the follow has framed the eye',
  );
  assert.equal(
    issCommandCameraOnStation({ followed: null, followFramed: false }, target),
    false,
  );
  assert.equal(
    issCommandCameraOnStation(
      { followed: { key: 'flights:a' }, followFramed: true },
      target,
    ),
    false,
    'following something else',
  );
  assert.equal(issCommandCameraOnStation(null, target), false);
  assert.equal(issCommandCameraOnStation(undefined, target), false);
  assert.equal(issCommandCameraOnStation(on, null), false);
  assert.equal(
    issCommandCameraOnStation({ followed: null, followFramed: true }, null),
    false,
    'nothing followed and no target is not a match',
  );
});
