import { layerFeedState } from '../../data/feedState.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createChesterCountyEmsLayer } from './index.js';

function setup(source, options = {}) {
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
    ...options,
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
  const { layer, entries, entities } = setup({
    getSnapshot: async () => snapshot(rows),
  });
  await layer.update();
  assert.equal(entries.has('chester-county-ems'), false);
  assert.equal(entities.values.length, 2);
  assert.equal(layer.getStats().count, 2);
  layer.setParams({ selectedIncident: row.id });
  assert.doesNotMatch(
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

const linkedRow = {
  ...row,
  detailUrl:
    'https://webcad.chesco.org/WebCad/livecadcomments-ems.asp?eid=123&incidentno=F26000001',
};
const units = {
  observedAt: Date.now(),
  units: [
    { unit: 'MEDIC01', status: 'On Scene', entered: '11-03-2026 10:05:00' },
  ],
  stale: false,
};
const settle = () => new Promise((resolve) => setImmediate(resolve));
test('clicking an icon opens the enriched source card, respects pointer ownership and cleans up picking', async () => {
  let click,
    picked,
    owned,
    destroyed = 0,
    free = true,
    opened;
  const { layer, entries } = setup(
    {
      getSnapshot: async () => snapshot([linkedRow]),
      getIncidentDetails: async () => units,
    },
    {
      picking: {
        registerPickOwner(id, predicate) {
          owned = predicate;
        },
        unregisterPickOwner() {
          owned = null;
        },
        resolvePickId: (p) => p?.id,
        isOwnedByOtherLayer: () => false,
      },
      pointer: { isPointerFree: () => free },
      screenSpaceEventHandlerFactory(viewer) {
        viewer.scene.pick = () => picked;
        return {
          setInputAction(fn) {
            click = fn;
          },
          destroy() {
            destroyed++;
          },
        };
      },
      openExternal: (url) => {
        opened = url;
      },
    },
  );
  await layer.update();
  assert.equal(entries.has('chester-county-ems-selected'), false);
  assert.equal(owned(`chester-county-ems:${row.id}`), true);
  picked = { id: `chester-county-ems:${row.id}` };
  free = false;
  click({ position: { x: 1, y: 1 } });
  assert.equal(entries.has('chester-county-ems-selected'), false);
  free = true;
  click({ position: { x: 1, y: 1 } });
  await settle();
  const card = entries.get('chester-county-ems-selected')[0];
  assert.match(card.details.join(' '), /MEDIC01 · On Scene/);
  assert.doesNotMatch(card.details.join(' '), /Approximate intersection/);
  assert.equal(card.activate(), true);
  assert.equal(opened, linkedRow.detailUrl);
  picked = null;
  click({ position: { x: 2, y: 2 } });
  assert.equal(entries.has('chester-county-ems-selected'), false);
  layer.disable();
  assert.equal(owned, null);
  assert.equal(destroyed, 1);
  layer.destroy();
});
test('old detail responses cannot populate another incident or revive a disabled card', async () => {
  const pending = [];
  const other = {
    ...linkedRow,
    id: 'ems:F26000002',
    incidentNumber: 'F26000002',
    detailUrl: linkedRow.detailUrl.replace('F26000001', 'F26000002'),
  };
  const { layer, entries } = setup({
    getSnapshot: async () => snapshot([linkedRow, other]),
    getIncidentDetails: (id, { signal }) =>
      new Promise((resolve) => pending.push({ id, signal, resolve })),
  });
  await layer.update();
  layer.setParams({ selectedIncident: linkedRow.id });
  layer.setParams({ selectedIncident: other.id });
  assert.equal(pending[0].signal.aborted, true);
  pending[0].resolve(units);
  await settle();
  assert.doesNotMatch(
    entries.get('chester-county-ems-selected')[0].details.join(' '),
    /MEDIC01/,
  );
  layer.disable();
  pending[1].resolve(units);
  await settle();
  assert.equal(entries.has('chester-county-ems-selected'), false);
  layer.destroy();
});
test('selected unit failures keep the summary and previous units without degrading the feed', async () => {
  let fail = false;
  const { layer, entries } = setup({
    getSnapshot: async () => snapshot([linkedRow]),
    getIncidentDetails: async () => {
      if (fail) throw new Error('offline');
      return units;
    },
  });
  await layer.update();
  layer.setParams({ selectedIncident: linkedRow.id });
  await settle();
  fail = true;
  await layer.update();
  await settle();
  const text = entries.get('chester-county-ems-selected')[0].details.join(' ');
  assert.match(text, /MEDIC01/);
  assert.match(text, /Unit status is stale/);
  assert.equal(layerFeedState(layer.getStats()), 'nominal');
  layer.destroy();
});
