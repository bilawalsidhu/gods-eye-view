// src/cockpitLook.test.mjs — the bridge look-around policy: arrow steps,
// yaw wrapping, pitch limits, easing and the readout's parts.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LOOK_COARSE_STEP_DEG,
  LOOK_STEP_DEG,
  ORBITAL_LOOK_LIMIT_DEG,
  clampLookPitch,
  clampOrbitalLook,
  easeLook,
  lookIsOffset,
  lookKeyStep,
  lookReadoutParts,
  orbitalLookReadoutParts,
  stepLook,
  stepOrbitalLook,
  wrapLookYaw,
} from './cockpitLook.js';

const REST = { yawDeg: 0, pitchDeg: -2 };

/** Press one key `count` times from `start`. */
function press(start, key, count = 1, coarse = false) {
  let look = start;
  for (let index = 0; index < count; index += 1)
    look = stepLook(look, lookKeyStep(key, coarse));
  return look;
}

test('yaw wraps to (-180, 180] and pitch clamps to [-90, 90]', () => {
  assert.equal(wrapLookYaw(0), 0);
  assert.equal(wrapLookYaw(-0), 0);
  assert.equal(wrapLookYaw(180), 180);
  assert.equal(wrapLookYaw(-180), 180);
  assert.equal(wrapLookYaw(185), -175);
  assert.equal(wrapLookYaw(-185), 175);
  assert.equal(wrapLookYaw(720 + 45), 45);
  assert.equal(wrapLookYaw(NaN), 0);
  assert.equal(clampLookPitch(120), 90);
  assert.equal(clampLookPitch(-120), -90);
  assert.equal(clampLookPitch(-0), 0);
  assert.equal(clampLookPitch(Infinity), 0);
});

test('only the arrows step, 5° plain and 45° with Shift', () => {
  assert.deepEqual(lookKeyStep('ArrowLeft'), {
    axis: 'yaw',
    sign: -1,
    stepDeg: LOOK_STEP_DEG,
  });
  assert.deepEqual(lookKeyStep('ArrowUp', true), {
    axis: 'pitch',
    sign: 1,
    stepDeg: LOOK_COARSE_STEP_DEG,
  });
  assert.equal(lookKeyStep('ArrowDown').sign, -1);
  assert.equal(lookKeyStep('ArrowRight').sign, 1);
  for (const key of ['Home', '0', 'a', 'Escape', undefined])
    assert.equal(lookKeyStep(key), null);
});

test('arrows turn the yaw in 5° steps and Shift reaches either beam in two', () => {
  assert.deepEqual(press(REST, 'ArrowRight'), { yawDeg: 5, pitchDeg: -2 });
  assert.deepEqual(press(REST, 'ArrowLeft', 3), { yawDeg: -15, pitchDeg: -2 });
  assert.equal(press(REST, 'ArrowRight', 2, true).yawDeg, 90);
  assert.equal(press(REST, 'ArrowLeft', 2, true).yawDeg, -90);
  // A coarse step from off the 45° grid lands on it.
  assert.equal(press({ ...REST, yawDeg: 5 }, 'ArrowRight', 1, true).yawDeg, 45);
  // Past astern the yaw wraps to the other side.
  assert.equal(press(REST, 'ArrowRight', 4, true).yawDeg, 180);
  assert.equal(press(REST, 'ArrowRight', 5, true).yawDeg, -135);
  assert.equal(press(REST, 'ArrowLeft', 37).yawDeg, 175);
});

test('pitch steps onto the 5° grid from the rest pitch and stops at ±90°', () => {
  assert.equal(press(REST, 'ArrowUp').pitchDeg, 0);
  assert.equal(press(REST, 'ArrowUp', 3).pitchDeg, 10);
  assert.equal(press(REST, 'ArrowDown').pitchDeg, -5);
  assert.equal(press(REST, 'ArrowUp', 40).pitchDeg, 90);
  assert.equal(press(REST, 'ArrowDown', 40).pitchDeg, -90);
  assert.equal(press(REST, 'ArrowUp', 3, true).pitchDeg, 90);
  assert.equal(press(REST, 'ArrowDown', 2, true).pitchDeg, -90);
  assert.equal(press(REST, 'ArrowUp').yawDeg, 0, 'pitch leaves the yaw');
});

test('the eased view closes most of a step in about 180 ms', () => {
  const target = { yawDeg: 90, pitchDeg: -2 };
  let view = { ...REST };
  view = easeLook(view, target, 180);
  assert.ok(view.yawDeg > 85 && view.yawDeg < 90, `yaw ${view.yawDeg}`);
  for (let step = 0; step < 20; step += 1) view = easeLook(view, target, 50);
  assert.deepEqual(view, target, 'it lands exactly on the target');
  assert.deepEqual(easeLook(REST, target, 0), REST, 'no time, no motion');
});

test('the eased yaw takes the short way across astern', () => {
  const view = easeLook(
    { yawDeg: 170, pitchDeg: 0 },
    { yawDeg: -170, pitchDeg: 0 },
    30,
  );
  assert.ok(view.yawDeg > 170 || view.yawDeg < -170, `yaw ${view.yawDeg}`);
});

test('reduced motion jumps straight to the target', () => {
  const target = { yawDeg: -45, pitchDeg: 30 };
  assert.deepEqual(easeLook(REST, target, 1, { immediate: true }), target);
});

test('the readout names the side, the bearing and the elevation', () => {
  assert.equal(lookIsOffset(REST, -2), false);
  assert.equal(lookIsOffset({ yawDeg: 0, pitchDeg: 0 }, -2), true);
  assert.equal(lookIsOffset({ yawDeg: 5, pitchDeg: -2 }, -2), true);
  assert.deepEqual(lookReadoutParts({ yawDeg: 45, pitchDeg: 10 }, -2), {
    side: 'starboard',
    bearingDeg: 45,
    elevation: 'up',
    angleDeg: 10,
  });
  assert.deepEqual(lookReadoutParts({ yawDeg: -90, pitchDeg: -2 }, -2), {
    side: 'port',
    bearingDeg: 90,
    elevation: null,
    angleDeg: 2,
  });
  assert.deepEqual(lookReadoutParts({ yawDeg: 0, pitchDeg: -30 }, -2), {
    side: null,
    bearingDeg: 0,
    elevation: 'down',
    angleDeg: 30,
  });
  assert.equal(
    lookReadoutParts({ yawDeg: 0, pitchDeg: 0 }, -2).elevation,
    'level',
  );
  assert.equal(
    lookReadoutParts({ yawDeg: 180, pitchDeg: -2 }, -2).side,
    'astern',
  );
});

test('an orbital look steps 5° per arrow and stops at 45° on each axis', () => {
  let look = { yawDeg: 0, pitchDeg: 0 };
  for (let index = 0; index < 3; index += 1)
    look = stepOrbitalLook(look, lookKeyStep('ArrowUp'));
  assert.deepEqual(look, { yawDeg: 0, pitchDeg: 15 });
  look = stepOrbitalLook(look, lookKeyStep('ArrowRight'));
  assert.deepEqual(look, { yawDeg: 5, pitchDeg: 15 });
  for (let index = 0; index < 20; index += 1) {
    look = stepOrbitalLook(look, lookKeyStep('ArrowDown'));
    look = stepOrbitalLook(look, lookKeyStep('ArrowLeft'));
  }
  assert.deepEqual(look, {
    yawDeg: -ORBITAL_LOOK_LIMIT_DEG,
    pitchDeg: -ORBITAL_LOOK_LIMIT_DEG,
  });
  assert.deepEqual(clampOrbitalLook({ yawDeg: 90, pitchDeg: NaN }), {
    yawDeg: 45,
    pitchDeg: 0,
  });
  assert.deepEqual(clampOrbitalLook({ yawDeg: 180, pitchDeg: -60 }), {
    yawDeg: 45,
    pitchDeg: -45,
  });
});

test('the orbital readout names north or south and east or west', () => {
  assert.deepEqual(orbitalLookReadoutParts({ yawDeg: 15, pitchDeg: 10 }), {
    northSouth: 'N',
    northSouthDeg: 10,
    eastWest: 'E',
    eastWestDeg: 15,
  });
  assert.deepEqual(orbitalLookReadoutParts({ yawDeg: -5, pitchDeg: 0 }), {
    northSouth: null,
    northSouthDeg: 0,
    eastWest: 'W',
    eastWestDeg: 5,
  });
  assert.equal(
    orbitalLookReadoutParts({ yawDeg: 0, pitchDeg: -45 }).northSouth,
    'S',
  );
});

test('the bridge look keeps its own limits beside the orbital clamp', () => {
  const look = stepLook({ yawDeg: 45, pitchDeg: 45 }, lookKeyStep('ArrowUp'));
  assert.deepEqual(look, { yawDeg: 45, pitchDeg: 50 });
  assert.equal(
    stepLook({ yawDeg: 45, pitchDeg: 0 }, lookKeyStep('ArrowRight', true))
      .yawDeg,
    90,
  );
});
