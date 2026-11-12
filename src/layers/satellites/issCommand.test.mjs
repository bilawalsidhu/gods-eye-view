import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ISS_COMMAND_ZOOM_RANGE_M,
  issCommandFastOrbit,
  issCommandShouldShow,
  issCommandZoomStep,
} from './issCommand.js';
import { ISS_NORAD } from './policy.js';

test('the panel shows only while the ISS is selected, layer on, Cockpit off', () => {
  const base = { enabled: true, trackedNorad: ISS_NORAD, cockpitHeld: false };
  assert.equal(issCommandShouldShow(base), true);
  assert.equal(issCommandShouldShow({ ...base, enabled: false }), false);
  assert.equal(issCommandShouldShow({ ...base, trackedNorad: 20580 }), false);
  assert.equal(issCommandShouldShow({ ...base, trackedNorad: null }), false);
  assert.equal(issCommandShouldShow({ ...base, cockpitHeld: true }), false);
});

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

test('the status line says lit or in shadow, and nothing before the model is placed', async () => {
  const { issCommandStatusText } = await import('./issCommand.js');
  assert.equal(issCommandStatusText(null), '');
  assert.notEqual(issCommandStatusText(true), issCommandStatusText(false));
  assert.ok(issCommandStatusText(true).length > 0);
  assert.ok(issCommandStatusText(false).length > 0);
});
