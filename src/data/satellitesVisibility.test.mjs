import assert from 'node:assert/strict';
import test from 'node:test';
import { createControls } from '../layers/satellites/controls.js';

const { satelliteVisualsVisible } = createControls({
  state: {},
  services: { layerState: {} },
  parts: {},
});

test('restoring Satellite presentation preferences cannot show a disabled layer', () => {
  assert.equal(satelliteVisualsVisible(false, true), false);
  assert.equal(satelliteVisualsVisible(false, false), false);
});

test('enabled Satellite layers honor their point and orbit presentation preferences', () => {
  assert.equal(satelliteVisualsVisible(true, true), true);
  assert.equal(satelliteVisualsVisible(true, false), false);
});
