/**
 * The catalog pairs layer instances with serialization metadata, and
 * `DataLayerManager.finalizeRegistrations` later seals the registered layers
 * against that same metadata. A user layer has to appear in BOTH or the
 * application refuses to start with "Layer serialization registry mismatch".
 *
 * This is a real regression: registering user layers in the state codec alone
 * broke startup for anyone who actually had one. It escaped the unit suite
 * because the loader ships with no layers, so every gate ran against the empty
 * case, and it escaped the browser gates for the same reason.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createLayerCatalog } from './catalog.js';
import {
  LAYER_STATE_REGISTRY,
  registerUserLayers,
  userLayerMetadata,
  resetUserLayersForTest,
} from '../data/layerState.js';

const builtIn = LAYER_STATE_REGISTRY[0];
const builtInLayer = { id: builtIn.id, name: builtIn.id };
const userLayer = { id: 'operator-thing', name: 'Operator Thing' };
const descriptor = { id: 'operator-thing', createLayer: () => userLayer };

beforeEach(() => resetUserLayersForTest());

test('a user layer paired with its metadata builds a catalog', () => {
  registerUserLayers([descriptor]);
  const catalog = createLayerCatalog(
    [builtInLayer, userLayer],
    [builtIn, ...userLayerMetadata()],
  );
  assert.equal(catalog.layers.length, 2);
  assert.ok(catalog.get('operator-thing'));
});

test('a user layer without its metadata is rejected', () => {
  // The exact failure that reached a device: the layer registers, the
  // metadata does not, and startup dies.
  registerUserLayers([descriptor]);
  assert.throws(
    () => createLayerCatalog([builtInLayer, userLayer], [builtIn]),
    /Catalog metadata is incomplete/,
  );
});

test('metadata for a layer that was never registered is rejected', () => {
  registerUserLayers([descriptor]);
  assert.throws(
    () => createLayerCatalog([builtInLayer], [builtIn, ...userLayerMetadata()]),
    /Unmatched or duplicate catalog metadata/,
  );
});

test('with no user layers the built-in pairing is unchanged', () => {
  const catalog = createLayerCatalog([builtInLayer], [builtIn]);
  assert.equal(catalog.layers.length, 1);
  assert.deepEqual(userLayerMetadata(), []);
});
