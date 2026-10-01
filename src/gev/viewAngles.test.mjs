import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clampPitch,
  normalizeHeading,
  stepPitch,
  stepHeading,
  activePreset,
  describeAngle,
  ANGLE_KEYS,
  ANGLE_PRESETS,
  MAX_PITCH,
  MIN_PITCH,
} from './viewAngles/model.js';

test('pitch stays between straight down and just above the horizon', () => {
  assert.equal(clampPitch(-120), MIN_PITCH);
  assert.equal(clampPitch(5), MAX_PITCH);
  assert.equal(clampPitch(NaN), MIN_PITCH);
  assert.equal(stepPitch(-35, 1), -25);
  assert.equal(stepPitch(-12, 1), MAX_PITCH, 'cannot tilt past the limit');
  assert.equal(stepPitch(-85, -1), MIN_PITCH);
});

test('heading wraps around the compass', () => {
  assert.equal(normalizeHeading(-15), 345);
  assert.equal(normalizeHeading(360), 0);
  assert.equal(stepHeading(350, 1), 5);
  assert.equal(stepHeading(5, -1), 350);
});

test('presets and readout', () => {
  assert.equal(activePreset(-33).id, 'oblique');
  assert.equal(activePreset(-47), null);
  assert.equal(describeAngle(-35, 270), '35° down · facing 270° W');
  assert.equal(describeAngle(-89, 359.6), '89° down · facing 0° N');
  for (const p of ANGLE_PRESETS) assert.equal(clampPitch(p.pitch), p.pitch);
});

test('angle keys avoid the app shortcuts', () => {
  const taken = ['1', '2', '3', '4', '5', '6', '7', 'h', 'o', 'v', 'f', 'd', 'c', '`', 'Escape'];
  for (const k of Object.keys(ANGLE_KEYS)) assert.ok(!taken.includes(k), k);
});
