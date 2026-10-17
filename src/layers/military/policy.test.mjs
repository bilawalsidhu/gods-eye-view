import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import {
  AMBER_TRANSPARENT,
  MIL_ICON_COLOR,
  TRACKED_ICON_COLOR,
  TRACKED_BILLBOARD_SCALE_BY_DISTANCE,
} from './policy.js';

const fields = (color) => [color.red, color.green, color.blue, color.alpha];

test('the military colours equal the Cesium.Color constants they replace', () => {
  const amber = Cesium.Color.fromCssColorString('#FFB800');
  assert.deepEqual(fields(MIL_ICON_COLOR), fields(amber));
  assert.deepEqual(
    fields(TRACKED_ICON_COLOR),
    fields(Cesium.Color.fromCssColorString('#FFD166')),
  );
  assert.deepEqual(fields(AMBER_TRANSPARENT), fields(amber.withAlpha(0)));
  for (const constant of [
    MIL_ICON_COLOR,
    TRACKED_ICON_COLOR,
    AMBER_TRANSPARENT,
  ])
    assert.ok(Object.isFrozen(constant));
  assert.deepEqual(
    { ...TRACKED_BILLBOARD_SCALE_BY_DISTANCE },
    { near: 1000, nearValue: 3, far: 8000000, farValue: 0.5 },
  );
});
