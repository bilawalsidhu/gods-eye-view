import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';
import { createApplicationCatalog } from './constructCatalog.js';
import { createSurfaceServices } from './surfaceServices.js';
import { createStandaloneLayerSources } from '../standalone/layerSources.js';
import { LayerLifecycle } from '../data/lifecycle.js';
import {
  initTrackedReadout,
  destroyTrackedReadout,
  _setTrackedOverlayHostForTest,
} from '../data/trackedReadout.js';
import { getSelectedEntityContext } from '../data/contextStore.js';
import { findPickOwner } from '../data/pickRegistry.js';

// The shared selection store and the card bridge live on window.
globalThis.window ??= new EventTarget();
globalThis.document ??= { querySelector: () => null };

const wells = Array.from({ length: 6 }, (_, i) => ({
  id: `W${i + 1}`,
  recordId: `TX${i + 1}`,
  state: 'Texas',
  longitude: -97.74 + i * 0.01,
  latitude: 30.27,
  depthFt: 21 + i,
  capacityGpm: null,
  screenDepthFt: null,
  screenLengthFt: null,
  constructedYear: null,
  reportedYear: null,
}));
const fixtureSource = () => ({
  getSnapshot: async () => ({ records: wells, total: 6, limited: false }),
});

function fixtureViewer() {
  const dataSources = new Cesium.DataSourceCollection();
  const events = new Map();
  const canvas = {
    clientWidth: 1440,
    clientHeight: 900,
    disableRootEvents: true,
    onwheel: null,
    getBoundingClientRect: () => ({ left: 0, top: 0 }),
    addEventListener: (type, listener) => events.set(type, listener),
    removeEventListener: (type) => events.delete(type),
  };
  return {
    dataSources,
    events,
    click() {
      const event = {
        button: 0,
        clientX: 50,
        clientY: 50,
        preventDefault() {},
      };
      events.get('mousedown')(event);
      events.get('mouseup')(event);
    },
    viewer: {
      dataSources,
      camera: {
        changed: new Cesium.Event(),
        moveEnd: new Cesium.Event(),
        percentageChanged: 0.5,
        positionCartographic: { height: 25000 },
        computeViewRectangle: () =>
          Cesium.Rectangle.fromDegrees(-98, 30, -97, 31),
      },
      scene: {
        canvas,
        preRender: new Cesium.Event(),
        globe: { getHeight: () => 430 },
        requestRender() {},
        pick: () => undefined,
        cartesianToCanvasCoordinates: () => undefined,
      },
    },
  };
}

function wellCatalog(t) {
  const lifetime = new AbortController();
  t.after(() => lifetime.abort());
  return createApplicationCatalog({
    sources: createStandaloneLayerSources({
      'us-groundwater': fixtureSource(),
    }),
    signal: lifetime.signal,
    surface: createSurfaceServices({
      terrainSource: { getHeights: async () => [] },
      signal: lifetime.signal,
      eventTarget: null,
    }),
  });
}

test('the standalone source is built without fetching anything', () => {
  const fetched = globalThis.fetch;
  globalThis.fetch = () => assert.fail('no request before the layer is on');
  try {
    const source = createStandaloneLayerSources()['us-groundwater'];
    assert.equal(typeof source.getSnapshot, 'function');
  } finally {
    globalThis.fetch = fetched;
  }
});

test('the catalog layer turns on and off through the layer manager', async (t) => {
  const catalog = wellCatalog(t);
  const layer = catalog.get('us-groundwater');
  assert.ok(layer);
  assert.equal(catalog.getSourceAvailability('us-groundwater').available, true);
  assert.equal(catalog.metadata.find(({ id }) => id === layer.id)?.token, '03');
  const fixture = fixtureViewer();
  const manager = new LayerLifecycle(fixture.viewer, {
    getSourceAvailability: catalog.getSourceAvailability,
  });
  for (const item of catalog.layers) manager.register(item);
  manager.finalizeRegistrations(catalog.metadata);

  assert.equal(await manager.setEnabled('us-groundwater', true), true);
  const row = manager.getAll().find(({ id }) => id === 'us-groundwater');
  assert.equal(row.enabled, true);
  assert.equal(row.stats.count, 6);
  assert.equal(row.stats.countLabel, '6');
  assert.equal(row.stats.visible, 6);
  assert.equal(fixture.dataSources.get(0).entities.values.length, 6);
  assert.equal(findPickOwner('us-groundwater:W4'), 'us-groundwater');

  assert.equal(await manager.setEnabled('us-groundwater', false), true);
  assert.equal(fixture.dataSources.get(0).entities.values.length, 0);
  assert.equal(fixture.events.size, 0, 'the click handler is released');
  assert.equal(findPickOwner('us-groundwater:W4'), null);
  assert.equal(fixture.viewer.camera.moveEnd.numberOfListeners, 0);
});

test('a picked well publishes its card through the shared tracked-card bridge', async (t) => {
  const writes = [];
  const clears = [];
  _setTrackedOverlayHostForTest({
    setEntries: (id, entries) => writes.push({ id, entries }),
    setVisible: () => {},
    clearSource: (id) => clears.push(id),
  });
  const layer = wellCatalog(t).get('us-groundwater');
  const fixture = fixtureViewer();
  const viewer = fixture.viewer;
  t.after(() => {
    layer.destroy();
    destroyTrackedReadout();
    _setTrackedOverlayHostForTest();
  });
  initTrackedReadout(viewer);
  layer.init(viewer);
  layer.enable();
  assert.equal(await layer.update(), true);
  const marker = fixture.dataSources
    .get(0)
    .entities.getById('us-groundwater:W4');
  viewer.scene.pick = () => ({ id: marker, primitive: {} });

  fixture.click();
  assert.equal(viewer.selectedEntity, marker);
  assert.equal(getSelectedEntityContext().entity, marker);
  const published = writes.at(-1);
  assert.equal(published.id, 'tracked');
  const card = published.entries[0];
  assert.equal(card.title, 'Water well record');
  assert.equal(card.accent, '#f5b942');
  assert.deepEqual(card.details, [
    'Well depth: 24 ft',
    'Texas',
    'Historical record; not current conditions.',
    'Source: USGWD TX4',
  ]);
  const anchor = Cesium.Cartographic.fromCartesian(card.position());
  assert.ok(Math.abs(anchor.height - 430) < 0.001);

  const before = writes.length;
  viewer.scene.pick = () => ({ id: { id: 'another-layer' } });
  fixture.click();
  assert.equal(writes.length, before, 'another layer’s pick publishes nothing');

  layer.disable();
  assert.equal(getSelectedEntityContext(), null);
  assert.ok(clears.length > 0, 'turning the layer off clears the card');
});
