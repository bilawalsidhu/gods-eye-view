import { layerFeedState } from '../../data/feedState.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createChesterCountyEmsLayer } from './index.js';

function setup(source) {
  const entries = new Map();
  let entities;
  const viewer = {
    dataSources: {
      add(source) {
        entities = source.entities;
      },
      remove() {},
    },
    scene: { requestRender() {} },
    camera: { flyTo() {} },
  };
  const layer = createChesterCountyEmsLayer({
    source,
    overlayHost: {
      setVisible() {},
      clearSource(id) {
        entries.delete(id);
      },
      setEntries(id, rows) {
        entries.set(id, rows);
      },
    },
  });
  layer.init(viewer);
  layer.enable();
  return { layer, entries, entities };
}
const row = {
  id: 'ems:F26000001',
  incidentNumber: 'F26000001',
  category: 'ems',
  municipality: 'Example Township',
  mapPosition: { lat: 40, lon: -75.7, kind: 'intersection', approximate: true },
  type: 'TEST',
  location: 'EXAMPLE RD',
  dispatched: '11-03-2026 10:00:00',
  station: '01',
};
const snapshot = (rows) => ({
  rows,
  fetchedAt: Date.now(),
  observedAt: Date.now(),
  stale: false,
});
test('renders individual street markers, selects card, removes expired incidents and tears down', async () => {
  let rows = [row, { ...row, id: 'F26000002' }];
  const { layer, entries } = setup({ getSnapshot: async () => snapshot(rows) });
  await layer.update();
  assert.equal(entries.get('chester-county-ems').length, 2);
  assert.equal(layer.getStats().count, 2);
  layer.setParams({ selectedIncident: row.id });
  assert.match(
    entries.get('chester-county-ems-selected')[0].details.join(' '),
    /Approximate intersection/,
  );
  rows = [];
  await layer.update();
  assert.equal(layer.getStats().count, 0);
  assert.equal(entries.has('chester-county-ems-selected'), false);
  layer.destroy();
  assert.equal(entries.size, 0);
});
test('late response after disable cannot repaint', async () => {
  let finish;
  const { layer, entries } = setup({
    getSnapshot: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  });
  const pending = layer.update();
  layer.disable();
  finish(snapshot([row]));
  assert.equal(await pending, false);
  assert.equal(entries.size, 0);
  assert.equal(layer.getStats().count, 0);
  layer.destroy();
});
test('failed refresh retains last report as stale; unlocated reports stay in list', async () => {
  let fail = false;
  const { layer } = setup({
    getSnapshot: async () => {
      if (fail) throw new Error('offline');
      return snapshot([{ ...row, mapPosition: null }]);
    },
  });
  await layer.update();
  assert.equal(layer.getRowControls().list.items.length, 1);
  fail = true;
  await layer.update();
  assert.equal(layer.getStats().stale, true);
  assert.equal(layer.getStats().count, 1);
  layer.destroy();
});

test('three categories have distinct flame, red cross and siren billboards', async () => {
  const rows = ['fire', 'ems', 'traffic'].map((category) => ({
    ...row,
    category,
    id: `${category}:test`,
  }));
  const { layer, entities } = setup({
    getSnapshot: async () => snapshot(rows),
  });
  await layer.update();
  const images = entities.values.map((e) =>
    decodeURIComponent(e.billboard.image.getValue()),
  );
  assert.equal(new Set(images).size, 3);
  assert.match(images[0], /#ff761a/);
  assert.match(images[1], /#ed2438/);
  assert.match(images[2], /#3285ff/);
  layer.destroy();
});

test('fresh unresolved records show explicit coverage without claiming feed degradation', async () => {
  const { layer } = setup({
    getSnapshot: async () => ({
      ...snapshot([{ ...row, mapPosition: null, locationStatus: 'unmatched' }]),
      locationCoverage: { matched: 0, unmatched: 1, unavailable: 0 },
    }),
  });
  await layer.update();
  assert.equal(layerFeedState(layer.getStats()), 'nominal');
  assert.equal(layer.getStats().unresolvedCount, 1);
  assert.match(
    layer.getRowControls().info,
    /0 mapped · 1 unresolved · 0 lookup errors/,
  );
  assert.match(layer.getRowControls().list.items[0].text, /No location match/);
  layer.destroy();
});
test('actual GIS errors remain degraded and feed staleness takes precedence', async () => {
  let isStale = false;
  const { layer } = setup({
    getSnapshot: async () => ({
      ...snapshot([
        { ...row, mapPosition: null, locationStatus: 'unavailable' },
      ]),
      stale: isStale,
      locationCoverage: { matched: 0, unmatched: 0, unavailable: 1 },
    }),
  });
  await layer.update();
  assert.equal(layerFeedState(layer.getStats()), 'degraded');
  assert.match(layer.getRowControls().info, /1 lookup errors/);
  isStale = true;
  await layer.update();
  assert.equal(layerFeedState(layer.getStats()), 'stale');
  layer.destroy();
});
