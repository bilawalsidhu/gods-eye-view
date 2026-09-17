// BIKESHARE FAILURE REPORTING — one dead city is not a dead layer.
//
// City feeds are fetched independently, but the layer reported failure through
// a single flag. A city whose operator had retired its feed set that flag on
// every proximity check, and the only code that cleared it ran on a successful
// *activation* — which an already-loaded city never repeats. The result was a
// permanent LOAD FAILED over a map drawing a thousand live stations.
//
// These cases pin the rule that replaced it: the layer reports failure only
// when it has nothing to show, and a city that comes back clears its own
// failure rather than waiting for a neighbour to succeed.
//
// Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createState } from './state.js';
import { createControls } from './controls.js';

function makeLayer() {
  const services = {
    overlays: {
      setOverlayEntries() {},
      setOverlaySourceVisible() {},
      clearOverlaySource() {},
    },
  };
  const state = createState({ services });
  const parts = { queries: { collectDetectableStations: () => [] } };
  const { methods } = createControls({ state, services, parts, source: {} });
  return { state, methods };
}

/** Stand in for a rendered station without reaching into the renderer. */
function renderStations(state, count) {
  for (let i = 0; i < count; i += 1) state._stationRenderMap.set(`s${i}`, {});
  state._count = state._stationRenderMap.size;
}

test('a failed city does not fail a layer that is drawing stations', () => {
  const { state, methods } = makeLayer();
  renderStations(state, 1069);
  state._failedCityIds.add('buffalo-reddy');

  const stats = methods.getStats();
  assert.equal(stats.count, 1069);
  assert.equal(
    stats.error,
    undefined,
    'a layer drawing 1069 stations reported LOAD FAILED',
  );
});

test('the layer reports failure when a failed city left it with nothing', () => {
  const { state, methods } = makeLayer();
  state._failedCityIds.add('buffalo-reddy');

  const stats = methods.getStats();
  assert.equal(stats.count, 0);
  assert.equal(stats.error, 'GBFS fetch error');
});

test('a layer with nothing to draw and nothing failed is not an error', () => {
  const { state, methods } = makeLayer();

  // Out of range of every city is empty, not broken.
  assert.equal(methods.getStats().error, undefined);
});

test('a recovered city clears its own failure', () => {
  const { state, methods } = makeLayer();
  state._failedCityIds.add('buffalo-reddy');
  assert.equal(methods.getStats().error, 'GBFS fetch error');

  state._failedCityIds.delete('buffalo-reddy');
  assert.equal(
    methods.getStats().error,
    undefined,
    'the failure outlived the city that caused it',
  );
});
