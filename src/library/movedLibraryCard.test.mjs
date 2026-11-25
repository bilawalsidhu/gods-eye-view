import test from 'node:test';
import assert from 'node:assert/strict';
import { localGeoJsonServices } from '../app/localGeojsonServices.js';
import {
  describeEntity,
  findRecord,
  layerRecords,
} from '../data/entityContext.js';
import { bindFakeGroundRenderer } from '../testSupport/fakeGroundRenderer.mjs';
import { createLibraryDatasetLayer } from './layers.js';

// A live Data Library dataset (cacheSeconds 60) whose features have no
// Feature.id, as boundLibraryFeatures emits them. One feature moves between
// refreshes; its open Context card should keep following it.
const entry = {
  id: 'test-alerts',
  kind: 'dataset',
  title: 'Test alerts',
  icon: '!',
  provider: 'Test',
  display: { color: '#ff0000' },
  source: { cacheSeconds: 60 },
  attribution: { text: 'Test' },
  licence: { name: 'CC0', url: 'https://example.org/licence' },
};
const START = 1_000_000;
const site = (lon, operator) => ({
  type: 'Feature',
  properties: { name: 'Cyclone Alpha', operator },
  geometry: { type: 'Point', coordinates: [lon, 0] },
});

test('an open Library card follows a feature that moved between refreshes', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: START });
  const previousWindow = globalThis.window;
  globalThis.window = { dispatchEvent() {} };
  const viewer = {};
  const fake = bindFakeGroundRenderer(viewer, {
    eye: { lon: 0.6, lat: 0, height: 50_000 },
  });
  const loads = [
    { features: [site(0.6, 'Before')] },
    { features: [site(0.7, 'After')] },
  ];
  let calls = 0;
  const layer = createLibraryDatasetLayer(entry, {
    services: {
      ...localGeoJsonServices,
      overlayHost: { setVisible() {}, setEntries() {}, clearSource() {} },
    },
    source: {
      async loadDataset() {
        return loads[calls++];
      },
    },
    inputFor: () => ({ onClick: () => () => {}, onPointer: () => () => {} }),
  });
  t.after(() => {
    layer.destroy(viewer);
    fake.unbind();
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  });
  await layer.enable(viewer);
  const manager = {
    isEnabled: () => true,
    layers: new Map([[layer.id, { module: layer }]]),
  };
  const [record] = layerRecords(manager, layer.id);
  // As a Nearby row opens it.
  const card = describeEntity(manager, {
    layerId: layer.id,
    id: record.key,
    label: record.name,
    lat: record.lat,
    lon: record.lon,
    record,
  });
  t.mock.timers.tick(60_000);
  await layer.update(viewer);
  assert.equal(
    findRecord(manager, card.identity)?.operator,
    'After',
    'the refreshed card finds the moved feature instead of going Out of feed',
  );
});
