import test from 'node:test';
import assert from 'node:assert/strict';
import {
  groundAircraftAlpha,
  normalizeGroundAircraftMode,
} from './groundAircraft.js';
import {
  createDefaultLayerState,
  encodeLayerStateParams,
  decodeLayerStateParams,
  serializeStoredLayerState,
  parseStoredLayerState,
} from './layerState.js';

test('ground preference defaults to Dim and survives storage and shared URLs', () => {
  assert.equal(createDefaultLayerState().options.flights.groundMode, 'dim');
  for (const mode of ['show', 'dim', 'hide']) {
    const state = createDefaultLayerState();
    state.enabledLayerIds = ['flights', 'military'];
    state.options.flights.groundMode = mode;
    const params = encodeLayerStateParams(new URLSearchParams('v=2'), state);
    assert.equal(
      decodeLayerStateParams(params).options.flights.groundMode,
      mode,
    );
    assert.equal(
      parseStoredLayerState(serializeStoredLayerState(state)).options.flights
        .groundMode,
      mode,
    );
  }
});
test('ground policy defaults to Dim and only affects explicitly grounded untracked contacts', () => {
  assert.equal(normalizeGroundAircraftMode(undefined), 'dim');
  assert.equal(normalizeGroundAircraftMode('bad'), 'dim');
  for (const [mode, alpha] of [
    ['show', 1],
    ['dim', 0.35],
    ['hide', 0],
  ]) {
    assert.equal(groundAircraftAlpha(mode, true), alpha);
    assert.equal(groundAircraftAlpha(mode, false), 1);
    assert.equal(groundAircraftAlpha(mode, undefined), 1);
    assert.equal(groundAircraftAlpha(mode, true, true), 1);
  }
});
