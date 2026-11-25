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
  const loads = [normalized(before), normalized(after)];
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
  const areaOf = (card) =>
    card.facts.find((fact) => fact.field === 'areaDesc')?.value;
  const cards = new Map();
  for (const record of layerRecords(manager, layer.id)) {
    const card = describeEntity(manager, {
      layerId: layer.id,
      id: record.key,
      label: record.name,
      lat: record.lat,
      lon: record.lon,
      record,
    });
    cards.set(areaOf(card), card);
  }
  t.mock.timers.tick(60_000);
  await layer.update(viewer);
  const found = new Map();
  for (const [area, card] of cards) {
    const record = findRecord(manager, card.identity);
    found.set(
      area,
      record
        ? {
            lon: record.lon,
            area: areaOf(describeEntity(manager, { ...card.identity, record })),
          }
        : null,
    );
  }
  return { cards, found };
}

test('a different alert with the same event name does not take over the open card', async (t) => {
  const { found } = await openThenRefresh(
    t,
    [alert('urn:alert:A', 0.6, 'County A')],
    [alert('urn:alert:B', 12.5, 'County B')],
  );
  assert.equal(found.get('County A'), null);
});

test('a moved alert keeps its card while another with the same event name takes its old place', async (t) => {
  const { found } = await openThenRefresh(
    t,
    [alert('urn:A', 0.6, 'County A')],
    [alert('urn:A', 0.7, 'County A moved'), alert('urn:B', 0.6, 'County B')],
  );
  assert.deepEqual(found.get('County A'), { lon: 0.7, area: 'County A moved' });
});

test('an alert that moves onto a departed one keeps its own card', async (t) => {
  const { found } = await openThenRefresh(
    t,
    [alert('urn:A', 0.6, 'County A'), alert('urn:B', 0.7, 'County B')],
    [alert('urn:A', 0.7, 'County A moved')],
  );
  assert.equal(found.get('County B'), null);
  assert.deepEqual(found.get('County A'), { lon: 0.7, area: 'County A moved' });
});

test('colocated alerts keep their cards when one is revised', async (t) => {
  const { found } = await openThenRefresh(
    t,
    [alert('urn:A', 0.6, 'County A'), alert('urn:B', 0.6, 'County B')],
    [alert('urn:B', 0.6, 'County B'), alert('urn:A', 0.6, 'County A revised')],
  );
  assert.equal(found.get('County A')?.area, 'County A revised');
  assert.equal(found.get('County B')?.area, 'County B');
});

test('a Library card shows alert facts without internal presentation fields', async (t) => {
  const warning = alert('urn:alert:A', 0.6, 'County A');
  const { cards } = await openThenRefresh(t, [warning], [warning]);
  const card = cards.get('County A');
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
