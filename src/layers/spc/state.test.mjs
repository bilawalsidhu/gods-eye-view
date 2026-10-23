import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createDefaultLayerState,
  encodeLayerStateParams,
  decodeLayerStateParams,
  serializeStoredLayerState,
  parseStoredLayerState,
  layerOptionsForRestore,
} from '../../data/layerState.js';

test('SPC Day 2 tornado options round-trip through v2 links and local state alongside existing layers', () => {
  const state = createDefaultLayerState();
  state.enabledLayerIds = [
    'flights',
    'severe-weather-outlooks',
    'weather-radar',
  ];
  state.options['severe-weather-outlooks'] = { day: 'day2', type: 'tornado' };
  const params = new URLSearchParams('v=2');
  encodeLayerStateParams(params, state);
  assert.match(params.get('l'), /(?:^|\.)5(?:\.|$)/);
  const restored = decodeLayerStateParams(params);
  assert.deepEqual(
    layerOptionsForRestore(restored, 'severe-weather-outlooks'),
    { day: 'day2', type: 'tornado' },
  );
  assert.deepEqual(
    parseStoredLayerState(serializeStoredLayerState(state)),
    restored,
  );
  assert.deepEqual(
    layerOptionsForRestore(
      decodeLayerStateParams(new URLSearchParams('v=2&l=f')),
      'severe-weather-outlooks',
    ),
    { day: 'day1', type: 'categorical' },
  );
  const invalid = decodeLayerStateParams(
    new URLSearchParams('v=2&l=5&lo=5.d.9_5.t.bad'),
  );
  assert.deepEqual(invalid.options['severe-weather-outlooks'], {
    day: 'day1',
    type: 'categorical',
  });
});
