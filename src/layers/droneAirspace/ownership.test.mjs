import assert from 'node:assert/strict';
import test from 'node:test';
import { createDroneAirspaceLayer } from './index.js';

function harness(source, { pick = () => null, cardHit = () => null } = {}) {
  const sources = [];
  const overlay = { entries: new Map(), visible: null };
  const clicks = { handler: null, destroyed: 0 };
  const owners = new Map();
  const viewer = {
    scene: { pick },
    dataSources: {
      add(value) {
        sources.push(value);
      },
      remove(value) {
        sources.splice(sources.indexOf(value), 1);
      },
    },
  };
  const layer = createDroneAirspaceLayer({
    source,
    overlayHost: {
      setEntries(sourceId, entries) {
        overlay.entries.set(sourceId, entries);
      },
      setVisible(sourceId, visible) {
        overlay.visible = visible;
      },
      clearSource(sourceId) {
        overlay.entries.delete(sourceId);
      },
      hitTest: (x, y, options) => cardHit(x, y, options),
    },
    screenSpaceEventHandlerFactory: () => ({
      setInputAction(callback) {
        clicks.handler = callback;
      },
      destroy() {
        clicks.destroyed += 1;
        clicks.handler = null;
      },
    }),
    picking: {
      resolvePickId: (picked) => picked?.id ?? null,
      isOwnedByOtherLayer: (layerId, pickedId) =>
        String(pickedId).startsWith('other-layer:'),
      registerPickOwner: (layerId, predicate) => owners.set(layerId, predicate),
      unregisterPickOwner: (layerId) => owners.delete(layerId),
    },
    pointer: { isPointerFree: () => true },
  });
  layer.init(viewer);
  layer.enable(viewer);
  return { layer, viewer, sources, overlay, clicks, owners };
}

const ring = [
  [-77.04, 38.89],
  [-77.03, 38.89],
  [-77.03, 38.9],
  [-77.04, 38.89],
];
const row = {
  stableId: '310',
  name: 'P-56',
  typeCode: 'P',
  type: 'Prohibited',
  lowerDesc: 'SFC',
  upperDesc: 'TNI',
  timesOfUse: 'CONTINUOUS',
  agency: null,
  city: 'WASHINGTON',
  state: 'DC',
  polygons: [[ring]],
};

test('each zone polygon renders as one filled entity with its outline', async () => {
  const h = harness({
    getSnapshot: async () => [
      row,
      { ...row, stableId: '400', typeCode: 'R', polygons: [[ring], [ring]] },
    ],
  });
  assert.equal(await h.layer.update(h.viewer), true);
  const entities = h.sources[0].entities.values;
  assert.equal(entities.length, 3);
  assert.equal(entities[0].id, 'drone-airspace:310:0');
  assert.ok(entities[0].polygon, 'zone fill missing');
  assert.ok(entities[0].polyline, 'zone outline missing');
  assert.equal(h.layer.getStats().count, 2);
});

test('clicking a zone publishes its card; empty space clears it', async () => {
  let pickResult = null;
  const h = harness(
    { getSnapshot: async () => [row] },
    { pick: () => pickResult },
  );
  await h.layer.update(h.viewer);
  assert.equal(typeof h.clicks.handler, 'function', 'click handler missing');
  assert.equal(h.owners.size, 0);

  pickResult = { id: 'drone-airspace:310:0' };
  h.clicks.handler({ position: { x: 10, y: 10 } });
  const entries = h.overlay.entries.get('drone-airspace');
  assert.equal(entries.length, 1);
  assert.equal(entries[0].id, 'drone-airspace-card:310');
  assert.equal(entries[0].title, 'PROHIBITED · P-56');
  assert.ok(entries[0].position, 'card must carry a world anchor');

  pickResult = { id: 'other-layer:aircraft-1' };
  h.clicks.handler({ position: { x: 10, y: 10 } });
  assert.equal(
    h.overlay.entries.get('drone-airspace')?.length,
    1,
    'sibling-layer picks must not clear the selection',
  );

  pickResult = null;
  h.clicks.handler({ position: { x: 10, y: 10 } });
  assert.equal(h.overlay.entries.get('drone-airspace')?.length ?? 0, 0);
});

test('late refresh cannot publish after disable or destroy', async () => {
  for (const action of ['disable', 'destroy']) {
    let resolve, signal;
    const h = harness({
      getSnapshot(options) {
        signal = options.signal;
        return new Promise((done) => {
          resolve = done;
        });
      },
    });
    const pending = h.layer.update(h.viewer);
    h.layer[action](h.viewer);
    assert.equal(signal.aborted, true);
    if (action === 'disable') h.layer.enable(h.viewer);
    resolve([row]);
    assert.equal(await pending, false);
    assert.equal(h.layer.getStats().count, 0);
    h.layer.destroy(h.viewer);
  }
});

test('the row legend names prohibited and restricted with the disclaimer', async () => {
  const h = harness({
    getSnapshot: async () => [
      row,
      { ...row, stableId: '400', typeCode: 'R', type: 'Restricted' },
    ],
  });
  await h.layer.update(h.viewer);
  const legend = h.layer.getRowControls().legend;
  assert.equal(legend[0].label, 'Prohibited (P)');
  assert.equal(legend[1].label, 'Restricted (R)');
  assert.equal(legend[0].count, 1);
  assert.equal(legend[1].count, 1);
  assert.match(legend[0].blurb, /not a substitute/);
});
