import test from 'node:test';
import assert from 'node:assert/strict';
import { localGeoJsonServices } from '../app/localGeojsonServices.js';
import {
  describeEntity,
  findRecord,
  layerRecords,
} from '../data/entityContext.js';
import { bindFakeGroundRenderer } from '../testSupport/fakeGroundRenderer.mjs';
import { boundLibraryFeatures } from './formats.js';
import { createLibraryDatasetLayer } from './layers.js';
import { createLibrarySource } from './source.js';

// NWS-style alerts: the event type is the label, each alert has its own
// Feature.id. The raw features go through the library normalizer.
const display = {
  color: '#ff0000',
  label: 'event',
  fields: ['areaDesc'],
  rank: { field: 'severity' },
};
const entry = {
  id: 'test-alerts',
  kind: 'dataset',
  title: 'Test alerts',
  icon: '!',
  provider: 'Test',
  display,
  source: { cacheSeconds: 60 },
  attribution: { text: 'Test' },
  licence: { name: 'CC0', url: 'https://example.org/licence' },
};
const START = 1_000_000;
const alert = (id, lon, areaDesc) => ({
  type: 'Feature',
  id,
  properties: { event: 'Dust Storm Warning', areaDesc },
  geometry: { type: 'Point', coordinates: [lon, 0] },
});
const normalized = (features) =>
  boundLibraryFeatures(features, { maxFeatures: 100, display });

async function openThenRefresh(t, before, after) {
  t.mock.timers.enable({ apis: ['Date'], now: START });
  const previousWindow = globalThis.window;
  globalThis.window = { dispatchEvent() {} };
  const viewer = {};
  const fake = bindFakeGroundRenderer(viewer, {
    eye: { lon: 0.6, lat: 0, height: 50_000 },
  });
  const loads = [normalized([before]), normalized([after])];
  let calls = 0;
  const layer = createLibraryDatasetLayer(entry, {
    services: {
      ...localGeoJsonServices,
      overlayHost: { setVisible() {}, setEntries() {}, clearSource() {} },
    },
    source: {
      async loadDataset() {
        return { features: loads[calls++].features };
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
  return { card, found: findRecord(manager, card.identity) };
}

test('a different alert with the same event name does not take over the open card', async (t) => {
  const { found } = await openThenRefresh(
    t,
    alert('urn:alert:A', 0.6, 'County A'),
    alert('urn:alert:B', 12.5, 'County B'),
  );
  assert.equal(found, null, `resolved to ${JSON.stringify(found)}`);
});

test('control: the same alert id that moved still follows the open card', async (t) => {
  const { found } = await openThenRefresh(
    t,
    alert('urn:alert:A', 0.6, 'County A'),
    alert('urn:alert:A', 0.7, 'County A'),
  );
  assert.equal(found?.lon, 0.7);
});

test('a Library card shows alert facts without internal presentation fields', async (t) => {
  const warning = alert('urn:alert:A', 0.6, 'County A');
  const { card } = await openThenRefresh(t, warning, warning);
  assert.equal(
    card.facts.find(({ field }) => field === 'areaDesc')?.value,
    'County A',
  );
  assert.deepEqual(
    card.facts.filter(({ field }) => field.startsWith('__gev')),
    [],
  );
});

test('a proxied alert keeps its source id through both normalization steps', async () => {
  const proxied = { ...entry, source: { fetch: 'proxied', maxFeatures: 100 } };
  const anonymous = alert(undefined, 0.7, 'County B');
  anonymous.properties.__gevSourceId = 'untrusted property';
  const source = createLibrarySource({
    entries: [proxied],
    fetchData: async () =>
      Response.json(normalized([alert(0, 0.6, 'County A'), anonymous])),
  });
  const { features } = await source.loadDataset(proxied);
  assert.deepEqual(
    features.map((row) => row.properties.__gevSourceId),
    ['0', undefined],
  );
  assert.ok(features.every((row) => row.id === undefined));
});
