import assert from 'node:assert/strict';
import test from 'node:test';
import { createApplicationStreetLevel } from './streetLevel.js';
import { fakeStreetLevelProvider } from '../../testSupport/streetLevelFakes.mjs';

test('explicit providers replace the default source and an empty list removes it', () => {
  const sources = { mapillary: {} };
  const provider = fakeStreetLevelProvider({
    id: 'example',
    pickPrefix: 'example:',
  });
  const layer = createApplicationStreetLevel({
    sources,
    providers: [provider],
  });
  assert.deepEqual(layer.providerIds, ['example']);
  assert.deepEqual(
    createApplicationStreetLevel({ sources, providers: [] }).providerIds,
    [],
  );
  assert.throws(
    () => createApplicationStreetLevel({ sources }),
    /Mapillary source/,
  );
  assert.throws(
    () => createApplicationStreetLevel({ providers: null }),
    /array/,
  );
});

test('the defaults are Mapillary (given its source) and Street View, which starts off and travels as a provider switch', async () => {
  const { createDefaultLayerState } = await import('../../data/layerState.js');
  const mapillary = {
    getStatus() {},
    getTile() {},
    getSequenceImages() {},
    nearestImages() {},
  };
  const layer = createApplicationStreetLevel({ sources: { mapillary } });
  assert.deepEqual(layer.providerIds, ['mapillary', 'google']);
  // A fresh page and a restored default agree: Street View is billed, so off.
  layer.setParams(createDefaultLayerState().options['street-level']);
  assert.equal(layer.getParams().google, false);
  assert.equal(layer.getParams().mapillary, true);
  // A link that lit Street View carries it in the shared switch field.
  layer.setParams({ providerSwitches: 'google-1' });
  assert.equal(layer.getParams().google, true);
  assert.equal(layer.getParams().providerSwitches, 'google-1');
  // Without the application's Street Level source there are none.
  assert.deepEqual(createApplicationStreetLevel({}).providerIds, []);
});
