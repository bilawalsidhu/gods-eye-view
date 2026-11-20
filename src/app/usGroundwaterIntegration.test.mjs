import assert from 'node:assert/strict';
import test from 'node:test';
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
import { toLonLatH } from '../geo/ellipsoid.js';
import { fakeInput } from '../input/testDoubles.mjs';
import { fakeCameraPort } from '../testSupport/fakeCameraPort.mjs';
import { bindFakeDraw } from '../testSupport/fakeDrawPort.mjs';

// The shared selection store and the card bridge live on window.
globalThis.window ??= new EventTarget();
globalThis.document ??= { querySelector: () => null };

const MARKERS = 'us-groundwater:markers';
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

/** A scene whose renderer ports are doubles, and the globe's real clicks. */
function fixtureScene() {
  const camera = fakeCameraPort({
    pose: { height: 25000 },
    viewRectangle: { west: -98, south: 30, east: -97, north: 31 },
  });
  const frames = new Set();
  const state = { picked: null };
  // The input double takes its clicks over a viewer's scene canvas.
  const viewer = {
    scene: { canvas: { clientWidth: 1440, clientHeight: 900 } },
  };
  const { draw } = bindFakeDraw(viewer, {
    camera: camera.port,
    frame: {
      on(phase, cb) {
        frames.add(cb);
        return () => frames.delete(cb);
      },
      requestRender() {},
    },
    query: {
      pick: () => state.picked,
      drillPick: () => (state.picked ? [state.picked] : []),
      // No well is near a click unless the renderer picks its marker.
      project: () => null,
      sampleHeightNow: () => 430,
    },
  });
  const input = fakeInput(viewer);
  return {
    viewer,
    camera,
    frames,
    state,
    input,
    markers: () => draw.set(MARKERS),
    click: () => input.tap({ x: 50, y: 50 }),
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
  const scene = fixtureScene();
  const manager = new LayerLifecycle(scene.viewer, {
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
  assert.equal(scene.markers().items.size, 6);
  assert.equal(scene.markers().show, true);
  assert.equal(findPickOwner('us-groundwater:W4'), 'us-groundwater');
  assert.equal(scene.camera.listenerCount('moveEnd'), 1);

  assert.equal(await manager.setEnabled('us-groundwater', false), true);
  assert.equal(scene.markers().items.size, 0);
  assert.equal(scene.markers().show, false);
  assert.equal(findPickOwner('us-groundwater:W4'), null);
  assert.equal(scene.camera.listenerCount('moveEnd'), 0);
  assert.equal(scene.camera.listenerCount('changed'), 0);
  assert.equal(scene.frames.size, 0, 'the frame listener is released');
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
  const scene = fixtureScene();
  const viewer = scene.viewer;
  t.after(() => {
    layer.destroy();
    destroyTrackedReadout();
    _setTrackedOverlayHostForTest();
    scene.input.destroy();
  });
  initTrackedReadout(viewer);
  layer.init(viewer);
  layer.enable();
  assert.equal(await layer.update(), true);

  scene.state.picked = {
    set: MARKERS,
    id: 'us-groundwater:W4',
    surface: false,
  };
  scene.click();
  const selected = getSelectedEntityContext();
  assert.equal(selected.id, 'us-groundwater:W4');
  assert.equal(selected.layerId, 'us-groundwater');
  const published = writes.at(-1);
  assert.equal(published.id, 'tracked');
  const card = published.entries[0];
  assert.equal(card.title, 'Water well record');
  assert.equal(card.accent, '#f5b942');
  assert.equal(card.verticalOnly, false);
  assert.deepEqual(card.details, [
    'Well depth: 24 ft',
    'Texas',
    'Historical record; not current conditions.',
    'Source: USGWD TX4',
  ]);
  assert.ok(Math.abs(toLonLatH(card.position()).height - 430) < 0.001);

  const before = writes.length;
  scene.state.picked = { set: 'flights', id: 'another-layer', surface: false };
  scene.click();
  assert.equal(writes.length, before, 'another layer’s pick publishes nothing');
  assert.equal(getSelectedEntityContext().id, 'us-groundwater:W4');

  layer.disable();
  assert.equal(getSelectedEntityContext(), null);
  assert.ok(clears.length > 0, 'turning the layer off clears the card');
});
