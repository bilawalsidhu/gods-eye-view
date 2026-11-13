/**
 * How user layers ride through the layer-state codec: the `ul` field, and the
 * ways it deliberately differs from `l`.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  LAYER_STATE_VERSION,
  createDefaultLayerState,
  normalizeLayerState,
  encodeLayerStateParams,
  decodeLayerStateParams,
  serializeStoredLayerState,
  parseStoredLayerState,
  registerUserLayers,
  REGISTERED_LAYER_IDS,
  resetUserLayersForTest,
  userLayerMetadata,
} from './layerState.js';

const layer = (id) => ({ id, createLayer: () => ({ id }) });

function paramsFor(enabledLayerIds) {
  const state = createDefaultLayerState();
  state.enabledLayerIds = enabledLayerIds;
  const params = new URLSearchParams();
  params.set('v', String(LAYER_STATE_VERSION));
  encodeLayerStateParams(params, state);
  return params;
}

beforeEach(() => resetUserLayersForTest());

test('an unregistered user layer is dropped, as before', () => {
  const state = normalizeLayerState({ enabledLayerIds: ['not-registered'] });
  assert.deepEqual(state.enabledLayerIds, []);
});

test('a registered user layer survives normalization', () => {
  registerUserLayers([layer('boilers')]);
  const state = normalizeLayerState({ enabledLayerIds: ['boilers', 'cctv'] });
  assert.deepEqual(state.enabledLayerIds, ['cctv', 'boilers']);
});

test('user layers encode into `ul` by id and never into `l`', () => {
  registerUserLayers([layer('boilers')]);
  const params = paramsFor(['cctv', 'boilers']);
  assert.equal(params.get('ul'), 'boilers');
  // The critical property: no share token was spent.
  assert.ok(!params.get('l').includes('boilers'));
  assert.equal(params.get('l'), 'c');
});

test('`ul` is absent when no user layer is on', () => {
  registerUserLayers([layer('boilers')]);
  assert.equal(paramsFor(['cctv']).has('ul'), false);
});

test('a full round trip restores both halves', () => {
  registerUserLayers([layer('boilers'), layer('wells')]);
  const params = paramsFor(['cctv', 'boilers', 'wells']);
  const decoded = decodeLayerStateParams(params);
  assert.deepEqual(decoded.enabledLayerIds, ['cctv', 'boilers', 'wells']);
});

test('an unknown user-layer id is skipped, not fatal', () => {
  // A link from someone whose local layers differ must still restore its
  // built-in half — unlike an unknown token in `l`, which fails closed.
  registerUserLayers([layer('boilers')]);
  const params = new URLSearchParams();
  params.set('v', String(LAYER_STATE_VERSION));
  params.set('l', 'c');
  params.set('ul', 'boilers.somebody-elses-layer');
  const decoded = decodeLayerStateParams(params);
  assert.deepEqual(decoded.enabledLayerIds, ['cctv', 'boilers']);
});

test('an unknown token in `l` still fails the whole payload closed', () => {
  // Guard against the `ul` leniency leaking across to `l`.
  registerUserLayers([layer('boilers')]);
  const params = new URLSearchParams();
  params.set('v', String(LAYER_STATE_VERSION));
  params.set('l', 'c.§');
  assert.equal(decodeLayerStateParams(params), null);
});

test('an oversized `ul` fails closed rather than decoding a prefix', () => {
  registerUserLayers([layer('boilers')]);
  const params = new URLSearchParams();
  params.set('v', String(LAYER_STATE_VERSION));
  params.set('l', 'c');
  params.set('ul', 'x'.repeat(257));
  assert.equal(decodeLayerStateParams(params), null);
});

test('user layers persist through local storage, which is id-keyed already', () => {
  registerUserLayers([layer('boilers')]);
  const state = normalizeLayerState({ enabledLayerIds: ['cctv', 'boilers'] });
  const restored = parseStoredLayerState(serializeStoredLayerState(state));
  assert.deepEqual(restored.enabledLayerIds, ['cctv', 'boilers']);
});

test('registering no user layers leaves built-in behaviour untouched', () => {
  const params = paramsFor(['cctv']);
  assert.equal(params.has('ul'), false);
  assert.deepEqual(decodeLayerStateParams(params).enabledLayerIds, ['cctv']);
  // And the built-in registry export is unchanged by any of this.
  assert.ok(REGISTERED_LAYER_IDS.includes('cctv'));
  assert.ok(!REGISTERED_LAYER_IDS.includes('boilers'));
});

test('a user layer cannot shadow a built-in id', () => {
  assert.throws(
    () => registerUserLayers([layer('cctv')]),
    /collides with a built-in/,
  );
});

test('a registered user layer carries serialization metadata', () => {
  // Regression: DataLayerManager.finalizeRegistrations seals the registered
  // layers against this metadata and throws "Layer serialization registry
  // mismatch" for any layer without a disposition. Registering a user layer
  // in the codec alone made the whole application fail to start as soon as
  // one actually existed — which unit tests missed, because the loader ships
  // with none.
  registerUserLayers([layer('boilers'), layer('wells')]);
  assert.deepEqual(userLayerMetadata(), [
    { id: 'boilers', disposition: 'enabled-only' },
    { id: 'wells', disposition: 'enabled-only' },
  ]);
});

test('user-layer metadata is empty when none are registered', () => {
  assert.deepEqual(userLayerMetadata(), []);
});
