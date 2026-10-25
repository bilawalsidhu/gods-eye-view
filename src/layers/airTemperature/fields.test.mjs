import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createTemperatureRaster,
  sampleTemperature,
  temperatureColor,
  TEMPERATURE_STOPS,
} from './fields.js';
import { field } from './fixtures.mjs';

test('bilinear temperature readings wrap the antimeridian and interpolate latitude', () => {
  // Given
  const snapshot = field();
  // When
  const middle = sampleTemperature(snapshot, 90, 0);
  // Then
  assert.equal(middle, 10);
  assert.equal(
    sampleTemperature(snapshot, -180, 0),
    sampleTemperature(snapshot, 180, 0),
  );
  assert.equal(sampleTemperature(snapshot, 0, 90), -20);
});

test('the freezing anchor stays neutral and extreme temperatures clamp to the scale', () => {
  // Given / When / Then
  assert.deepEqual(temperatureColor(0), [233, 245, 238]);
  assert.deepEqual(temperatureColor(-40), [59, 15, 112]);
  assert.deepEqual(temperatureColor(-25), [44, 91, 214]);
  assert.deepEqual(temperatureColor(-10), [57, 184, 224]);
  assert.deepEqual(temperatureColor(10), [143, 207, 90]);
  assert.deepEqual(temperatureColor(20), [244, 207, 58]);
  assert.deepEqual(temperatureColor(30), [236, 106, 37]);
  assert.deepEqual(temperatureColor(45), [158, 11, 59]);
  // Tropical air (25–30 °C) must not share a colour with temperate air.
  assert.notDeepEqual(temperatureColor(27), temperatureColor(15));
  assert.deepEqual(temperatureColor(-100), temperatureColor(-40));
  assert.deepEqual(temperatureColor(100), temperatureColor(45));
  assert.equal(TEMPERATURE_STOPS[3].value, 0);
  assert.deepEqual(temperatureColor(-5), [145, 215, 231]);
  assert.equal(sampleTemperature(field([-70, -70, -70, -70]), 0, 0), -70);
  assert.equal(sampleTemperature(field([55, 55, 55, 55]), 0, 0), 55);
});

test('raster pixel centers sample physical longitude, not the grid origin', () => {
  // Given
  const snapshot = field();
  // When
  const raster = createTemperatureRaster(snapshot, { width: 2, height: 2 });
  // Then
  assert.deepEqual([...raster.rgba.slice(0, 3)], temperatureColor(0));
  assert.equal(raster.rgba[3], 255);
  assert.equal(createTemperatureRaster(snapshot, { width: 721 }), null);
});
