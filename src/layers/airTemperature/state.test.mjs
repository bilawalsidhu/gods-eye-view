import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createDefaultLayerState,
  encodeLayerStateParams,
  decodeLayerStateParams,
} from '../../data/layerState.js';

test('share state restores enabled temperature and Fahrenheit without transient point-tool state', () => {
  // Given
  const state = createDefaultLayerState();
  state.enabledLayerIds = ['temperature'];
  state.options.temperature = {
    mode: 'air',
    units: '°F',
    pick: true,
    point: { lat: 1, lon: 2 },
  };
  // When
  const encoded = encodeLayerStateParams(new URLSearchParams('v=2'), state);
  const restored = decodeLayerStateParams(encoded);
  // Then
  assert.ok(restored.enabledLayerIds.includes('temperature'));
  assert.deepEqual(restored.options.temperature, {
    mode: 'air',
    units: '°F',
    showNino34: false,
    date: null,
  });
});
