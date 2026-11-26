import test from 'node:test';
import assert from 'node:assert/strict';
import { localGeoJsonServices } from '../app/localGeojsonServices.js';
import { describeEntity, findRecord, layerRecords } from '../data/entityContext.js';
import { bindFakeGroundRenderer } from '../testSupport/fakeGroundRenderer.mjs';
import { boundLibraryFeatures } from './formats.js';
import { createLibraryDatasetLayer } from './layers.js';

const display = { color: '#ff0000', label: 'event', fields: ['areaDesc'], rank: { field: 'severity' } };
const entry = {
  id: 'test-alerts', kind: 'dataset', title: 'Test alerts', icon: '!', provider: 'Test', display,
  source: { cacheSeconds: 60 }, attribution: { text: 'Test' },
  licence: { name: 'CC0', url: 'https://example.org/licence' },
};
const START = 1_000_000;
const alert = (id, lon, areaDesc) => ({
  type: 'Feature', ...(id === undefined ? {} : { id }),
  properties: { event: 'Dust Storm Warning', areaDesc },
  geometry: { type: 'Point', coordinates: [lon, 0] },
});
const normalized = (features) => boundLibraryFeatures(features, { maxFeatures: 100, display });

async function harness(t, snapshots) {
  t.mock.timers.enable({ apis: ['Date'], now: START });
  const previousWindow = globalThis.window;
  globalThis.window = { dispatchEvent() {} };
  const viewer = {};
  const fake = bindFakeGroundRenderer(viewer, { eye: { lon: 0.6, lat: 0, height: 50_000 } });
  const loads = snapshots.map(normalized);
  let calls = 0;
  const layer = createLibraryDatasetLayer(entry, {
    services: { ...localGeoJsonServices, overlayHost: { setVisible() {}, setEntries() {}, clearSource() {} } },
    source: { async loadDataset() { return { features: loads[calls++].features }; } },
    inputFor: () => ({ onClick: () => () => {}, onPointer: () => () => {} }),
  });
  t.after(() => {
    layer.destroy(viewer); fake.unbind();
    if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow;
  });
  await layer.enable(viewer);
  const manager = { isEnabled: () => true, layers: new Map([[layer.id, { module: layer }]]) };
  const areaOf = (card) => card.facts.find((fact) => fact.field === 'areaDesc')?.value;
  const open = () => {
    const cards = new Map();
    for (const record of layerRecords(manager, layer.id)) {
      const card = describeEntity(manager, { layerId: layer.id, id: record.key, label: record.name, lat: record.lat, lon: record.lon, record });
      cards.set(areaOf(card), card);
    }
    return cards;
  };
  const resolve = (card) => {
    const record = findRecord(manager, card.identity);
    return record ? { lon: record.lon, area: areaOf(describeEntity(manager, { ...card.identity, record })) } : null;
  };
  const refresh = async () => { t.mock.timers.tick(60_000); await layer.update(viewer); };
  return { open, resolve, refresh, count: () => layerRecords(manager, layer.id).length, calls: () => calls };
}

test('stationary alert survives a later duplicate id', async (t) => {
  const h = await harness(t, [
    [alert('urn:X', 0.6, 'County A')],
    [alert('urn:X', 0.6, 'County A')],
    [alert('urn:X', 0.6, 'County A'), alert('urn:X', 0.9, 'County B')],
  ]);
  const a = h.open().get('County A');
  await h.refresh();
  assert.deepEqual(h.resolve(a), { lon: 0.6, area: 'County A' }, 'after load two');
  await h.refresh();
  assert.equal(h.calls(), 3);
  assert.equal(h.count(), 2);
  assert.deepEqual(h.resolve(a), { lon: 0.6, area: 'County A' }, 'after load three');
});

test('control: two loads only, duplicate id appears', async (t) => {
  const h = await harness(t, [
    [alert('urn:X', 0.6, 'County A')],
    [alert('urn:X', 0.6, 'County A'), alert('urn:X', 0.9, 'County B')],
  ]);
  const a = h.open().get('County A');
  await h.refresh();
  assert.deepEqual(h.resolve(a), { lon: 0.6, area: 'County A' });
});

test('colocated replacement cannot inherit a departed card', async (t) => {
  const h = await harness(t, [
    [alert('urn:A', 0.6, 'County A')],
    [alert('urn:A', 0.6, 'County A'), alert(undefined, 0.6, 'County B')],
    [alert('urn:A', 0.6, 'County A'), alert(undefined, 0.6, 'County C')],
  ]);
  await h.refresh();
  const cards = h.open();
  const b = cards.get('County B');
  const a = cards.get('County A');
  await h.refresh();
  assert.deepEqual(h.resolve(a), { lon: 0.6, area: 'County A' });
  assert.equal(h.resolve(b), null, 'B card resolved to ' + JSON.stringify(h.resolve(b)));
});
