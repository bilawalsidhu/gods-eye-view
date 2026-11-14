import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createDefaultLayerState,
  encodeLayerStateParams,
  decodeLayerStateParams,
  serializeStoredLayerState,
  parseStoredLayerState,
  layerOptionsForRestore,
  LAYER_STATE_TOKEN_RESERVATIONS,
  nextLayerStateToken,
  validateLayerStateAllocations,
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
  assert.match(params.get('l'), /(?:^|\.)03(?:\.|$)/);
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
    new URLSearchParams('v=2&l=03&lo=03.d.9_9.t.bad'),
  );
  assert.deepEqual(invalid.options['severe-weather-outlooks'], {
    day: 'day1',
    type: 'categorical',
  });
});

test('SPC token cannot reuse published wildlife and pair reservations', () => {
  const published = { ...LAYER_STATE_TOKEN_RESERVATIONS };
  delete published['severe-weather-outlooks'];
  assert.equal(published['wildlife-sightings'], '9');
  assert.deepEqual(
    ['news', 'shipwrecks', 'rail'].map((id) => published[id]),
    ['00', '01', '02'],
  );
  assert.equal(nextLayerStateToken(published), '03');
  assert.equal(LAYER_STATE_TOKEN_RESERVATIONS['severe-weather-outlooks'], '03');
  assert.equal(validateLayerStateAllocations(published), true);
  const publishedNine = decodeLayerStateParams(new URLSearchParams('v=2&l=9'));
  assert.equal(
    publishedNine?.enabledLayerIds?.includes('severe-weather-outlooks') ?? false,
    false,
  );
});
