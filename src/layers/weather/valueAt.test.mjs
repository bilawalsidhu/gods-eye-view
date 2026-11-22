import test from 'node:test';
import assert from 'node:assert/strict';
import { createWeatherLayer } from './index.js';

// Radar, lightning and cloud frames are image tiles whose pixels are
// released to the globe, so no layer holds a value at a point. Without
// getValueAt, Context shows each as an overlay on the map with its update
// time, rather than as a field with no value.
test('weather layers offer no value at a point', () => {
  for (const id of [
    'weather-radar',
    'weather-lightning',
    'weather-satellite',
  ]) {
    const layer = createWeatherLayer({
      id,
      feed: { getSnapshot: async () => ({}) },
    });
    assert.equal(layer.getValueAt, undefined, id);
  }
});
