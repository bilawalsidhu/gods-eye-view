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
import { claimPointer, releasePointer } from '../data/inputOwnership.js';
import { createBundledWellPackSource } from '../layers/usGroundwater/bundledSource.js';
import { createUsGroundwaterLayer } from '../layers/usGroundwater/index.js';

test('standalone wells use the viewport source without fetching on construction', () => {
  const old = globalThis.location;
  try {
    globalThis.location = new URL('http://localhost/?wellPilot=indexed');
    assert.equal(
      createStandaloneLayerSources()['us-groundwater'].viewport,
      true,
    );
  } finally {
    globalThis.location = old;
  }
});

test('wheel motion requests current detail before moveEnd, preserves last good data and releases sensitivity on OFF', async () => {
  const f = fixtureViewer();
  f.viewer.camera.changed = new Cesium.Event();
  f.viewer.camera.percentageChanged = 0.5;
  let bounds = Cesium.Rectangle.fromDegrees(-125, 24, -66, 50);
  f.viewer.camera.computeViewRectangle = () => bounds;
  const sample = await createBundledWellPackSource().getSnapshot();
  const requests = [];
  const layer = createUsGroundwaterLayer({
    source: {
      viewport: true,
      getSnapshot(options) {
        if (!requests.length) {
          requests.push(options);
          return Promise.resolve(sample);
        }
        return new Promise((resolve) => requests.push({ ...options, resolve }));
      },
    },
  });
  layer.init(f.viewer);
  try {
    await layer.enable();
    assert.equal(f.viewer.camera.percentageChanged, 0.05);
    const original = layer.getRecords();
    for (let i = 0; i < 12; i++) f.viewer.camera.changed.raiseEvent(0.06);
    assert.equal(layer.getStats().loading, true);
    await new Promise((resolve) => setTimeout(resolve, 230));
    assert.equal(
      requests.length,
      2,
      'motion is throttled, not postponed until stopping',
    );
    assert.deepEqual(
      layer.getRecords(),
      original,
      'pending work keeps real last-good locations',
    );
    bounds = Cesium.Rectangle.fromDegrees(-150, 29, -149, 30);
    requests[1].resolve({ ...sample, records: [] });
    await new Promise(setImmediate);
    assert.deepEqual(
      layer.getRecords(),
      original,
      'completion for an obsolete camera cannot blank the display',
    );
    f.viewer.camera.changed.raiseEvent(0.06);
    f.viewer.camera.moveEnd.raiseEvent();
    assert.equal(requests.length, 3, 'settled view starts immediately');
    layer.disable();
    assert.equal(requests[2].signal.aborted, true);
    assert.equal(f.viewer.camera.percentageChanged, 0.5);
    requests[2].resolve(sample);
    await new Promise((resolve) => setTimeout(resolve, 230));
    assert.equal(requests.length, 3, 'OFF cancels the trailing timer');
    assert.equal(layer.getStats().representedLocationCount, 0);
  } finally {
    layer.destroy();
  }
});

test('manifest catalog count survives pan, zoom and OFF while map representation changes', async () => {
  const f = fixtureViewer();
  const detail = await createBundledWellPackSource().getSnapshot();
  detail.catalogTotal = 1042777;
  detail.coverage.indexed = true;
  detail.records = detail.records.slice(0, 1);
  const counts = {
    schemaVersion: 1,
    kind: 'gev-well-count-view',
    total: 1042777,
    degrees: 2,
    coverageComplete: false,
    reason: 'test',
    cells: [{ bounds: [-104, 28, -102, 30], count: 7200 }],
  };
  const views = [counts, detail, counts];
  const layer = createUsGroundwaterLayer({
    source: {
      viewport: true,
      async getSnapshot() {
        return views.shift() ?? counts;
      },
    },
  });
  layer.init(f.viewer);
  try {
    assert.equal(await layer.enable(), true);
    assert.equal(layer.getStats().count, 1042777);
    assert.equal(layer.getStats().representedLocationCount, 7200);
    f.viewer.camera.positionCartographic.height = 1000;
    f.viewer.camera.moveEnd.raiseEvent();
    await new Promise(setImmediate);
    assert.equal(layer.getStats().catalogCount, 1042777);
    assert.equal(layer.getStats().representedLocationCount, 1);
    const dot = f.viewer.dataSources.get(0).entities.values[0];
    assert.equal(
      dot.billboard.width.getValue(),
      12,
      'detail after aggregate transition has explicit dot dimensions',
    );
    assert.equal(dot.billboard.height.getValue(), 12);
    assert.equal(
      dot.point,
      undefined,
      'do not reuse clamped PointVisualizer dimensions',
    );
    f.viewer.camera.positionCartographic.height = 6000000;
    f.viewer.camera.moveEnd.raiseEvent();
    await new Promise(setImmediate);
    assert.equal(layer.getStats().count, 1042777);
    assert.equal(layer.getStats().representedLocationCount, 7200);
    layer.disable();
    assert.equal(layer.getStats().count, 1042777);
    assert.equal(layer.getStats().representedLocationCount, 0);
    assert.equal(layer.getStats().screenGroups, 0);
    assert.equal(await layer.enable(), true);
    assert.equal(layer.getStats().count, 1042777);
  } finally {
    layer.destroy();
  }
});

test('main layer viewport lifecycle ignores stale packs and cancels disabled loads', async () => {
  const fixture = fixtureViewer();
  const sample = await createBundledWellPackSource().getSnapshot();
  const requests = [];
  const source = {
    viewport: true,
    getSnapshot: ({ signal, bounds }) => {
      if (!requests.length) {
        requests.push({ signal, bounds });
        return Promise.resolve(sample);
      }
      return new Promise((resolve) =>
        requests.push({ signal, bounds, resolve }),
      );
    },
  };
  const layer = createUsGroundwaterLayer({ source });
  layer.init(fixture.viewer);
  try {
    assert.equal(await layer.enable(), true);
    fixture.viewer.camera.moveEnd.raiseEvent();
    fixture.viewer.camera.moveEnd.raiseEvent();
    assert.equal(requests[1].signal.aborted, true);
    const small = structuredClone(sample);
    small.records = small.records.slice(0, 1);
    requests[2].resolve(small);
    await new Promise(setImmediate);
    requests[1].resolve(sample);
    await new Promise(setImmediate);
    assert.equal(layer.getRecords().length, 1);
    assert.equal(
      layer.getStats().catalogCount,
      null,
      'legacy viewport packs do not establish a catalog total',
    );
    fixture.viewer.camera.moveEnd.raiseEvent();
    layer.disable();
    assert.equal(requests[3].signal.aborted, true);
    requests[3].resolve(sample);
    await new Promise(setImmediate);
    assert.equal(layer.getStats().visible, 0);
    assert.equal(fixture.viewer.dataSources.length, 0);
  } finally {
    layer.destroy();
  }
});

test('native well overlay hit selects the actual entity and an empty click dismisses it', async () => {
  const previousDocument = globalThis.document;
  globalThis.document = { querySelector: () => null };
  const f = fixtureViewer();
  let hit, selected;
  const layer = createUsGroundwaterLayer({
    source: createBundledWellPackSource(),
    overlays: {
      clearOverlaySource() {},
      hitTestWorldOverlay: (_x, _y, options) => {
        assert.equal(options.sourceId, 'us-groundwater-counts');
        const value = hit;
        hit = null; // Shared host can clear its hit rectangles before mouse-up.
        return value;
      },
    },
    onSelect: (value) => {
      selected = value;
    },
  });
  f.viewer.scene.pick = () => undefined;
  layer.init(f.viewer);
  try {
    await layer.enable();
    const entity = f.dataSources.get(0).entities.values[0];
    hit = { entryId: entity.id };
    f.click();
    assert.equal(f.viewer.selectedEntity, entity);
    assert.ok(selected);
    hit = null;
    f.click();
    assert.equal(f.viewer.selectedEntity, undefined);
    assert.equal(selected, null);
  } finally {
    layer.destroy();
    globalThis.document = previousDocument;
  }
});

function fixtureViewer() {
  const dataSources = new Cesium.DataSourceCollection();
  const moveEnd = new Cesium.Event();
  const listeners = new Set();
  const events = new Map();
  const canvas = {
    disableRootEvents: true,
    onwheel: null,
    getBoundingClientRect: () => ({ left: 0, top: 0 }),
    addEventListener(type, listener) {
      listeners.add(listener);
      events.set(type, listener);
    },
    removeEventListener(_type, listener) {
      listeners.delete(listener);
    },
  };
  return {
    dataSources,
    listeners,
    click() {
      const event = {
        button: 0,
        clientX: 50,
        clientY: 50,
        preventDefault() {},
      };
      assert.ok(events.has('mousedown'), 'uses Cesium mouse input');
      events.get('mousedown')(event);
      events.get('mouseup')(event);
    },
    viewer: {
      dataSources,
      camera: {
        computeViewRectangle: () =>
          Cesium.Rectangle.fromDegrees(-125, 24, -66, 50),
        // Keep the dispersed six-site fixture above the horizon; height separately drives the detail gate.
        positionWC: Cesium.Cartesian3.fromDegrees(-96, 38, 9500000),
        positionCartographic: { height: 25000 },
        moveEnd,
      },
      scene: { canvas },
    },
  };
}

test('main GEV catalog exposes the bundled well snapshot through its layer lifecycle', async (t) => {
  const lifetime = new AbortController();
  t.after(async () => lifetime.abort());
  const catalog = createApplicationCatalog({
    sources: createStandaloneLayerSources({
      'us-groundwater': createBundledWellPackSource(),
    }),
    signal: lifetime.signal,
    surface: createSurfaceServices({
      terrainSource: { getHeights: async () => [] },
      signal: lifetime.signal,
      eventTarget: null,
    }),
  });
  const layer = catalog.get('us-groundwater');
  assert.ok(layer);
  assert.equal(catalog.getSourceAvailability('us-groundwater').available, true);
  assert.equal(catalog.metadata.find(({ id }) => id === layer.id)?.token, '03');
  const viewer = fixtureViewer();
  let renderRequests = 0;
  viewer.viewer.scene.requestRender = () => {
    renderRequests += 1;
  };
  const postRender = new Cesium.Event();
  viewer.viewer.scene.postRender = postRender;
  const manager = new LayerLifecycle(viewer.viewer, {
    getSourceAvailability: catalog.getSourceAvailability,
  });
  for (const item of catalog.layers) manager.register(item);
  manager.finalizeRegistrations(catalog.metadata);

  assert.equal(await manager.setEnabled('us-groundwater', true), true);
  const row = manager.getAll().find(({ id }) => id === 'us-groundwater');
  assert.equal(row.enabled, true);
  assert.equal(row.stats.count, 6);
  assert.equal(row.stats.visible, 6);
  assert.equal(row.stats.partial, true);
  assert.match(row.stats.coverage, /not nationwide/);
  assert.equal(viewer.dataSources.length, 1);
  assert.ok(
    renderRequests > 0,
    'enabling requests a frame in idle-render mode',
  );
  const beforeReady = renderRequests;
  assert.equal(postRender.numberOfListeners, 2);
  postRender.raiseEvent();
  assert.equal(
    renderRequests,
    beforeReady + 1,
    'one readiness frame after Cesium visualizer update',
  );
  assert.equal(
    postRender.numberOfListeners,
    1,
    'only the live visibility gate remains after the readiness frame',
  );
  postRender.raiseEvent();
  assert.equal(renderRequests, beforeReady + 1);
  assert.deepEqual(
    layer.getRecords().map(({ id }) => id),
    [
      'USGS-330548081391102',
      'USGS-380743102240300',
      'USGS-414834102302001',
      'USGS-422702079005101',
      'USGS-451822093413201',
      'USGS-453816087590101',
    ],
  );

  assert.equal(await manager.setEnabled('us-groundwater', false), true);
  assert.equal(viewer.dataSources.length, 0);
  assert.equal(viewer.listeners.size, 0);
  assert.ok(renderRequests > 1, 'disable requests a cleanup frame');
  assert.equal(await manager.setEnabled('us-groundwater', true), true);
  assert.equal(postRender.numberOfListeners, 2);
  await manager.setEnabled('us-groundwater', false);
  assert.equal(
    postRender.numberOfListeners,
    0,
    'disable cancels the readiness callback',
  );
  const afterDisable = renderRequests;
  postRender.raiseEvent();
  assert.equal(
    renderRequests,
    afterDisable,
    'disabled layer schedules no more frames',
  );
});

test('main catalog marker pick publishes well details to the actual shared card bridge', async (t) => {
  const oldWindow = globalThis.window;
  const oldDocument = globalThis.document;
  globalThis.window = new EventTarget();
  globalThis.document = { querySelector: () => null };
  const lifetime = new AbortController();
  const writes = [];
  const visible = [];
  const clears = [];
  _setTrackedOverlayHostForTest({
    setEntries: (id, entries) => writes.push({ id, entries }),
    setVisible: (id, show) => visible.push({ id, show }),
    clearSource: (id) => clears.push(id),
  });
  const catalog = createApplicationCatalog({
    sources: createStandaloneLayerSources({
      'us-groundwater': createBundledWellPackSource(),
    }),
    signal: lifetime.signal,
    surface: createSurfaceServices({
      terrainSource: { getHeights: async () => [] },
      signal: lifetime.signal,
      eventTarget: null,
    }),
  });
  const layer = catalog.get('us-groundwater');
  t.after(() => {
    layer.destroy();
    destroyTrackedReadout();
    _setTrackedOverlayHostForTest();
    lifetime.abort();
    globalThis.window = oldWindow;
    globalThis.document = oldDocument;
  });
  const owned = fixtureViewer();
  const viewer = owned.viewer;
  viewer.scene.requestRender = () => {};
  viewer.scene.globe = { getHeight: () => 430 };
  initTrackedReadout(viewer);
  layer.init(viewer);
  assert.equal(await layer.enable(), true);
  const ny = owned.dataSources
    .get(0)
    .entities.getById('us-groundwater:USGS-422702079005101');
  assert.ok(ny, 'the source record participates in this fixture view');
  viewer.scene.pick = () => ({ id: ny, primitive: {} });

  const lease = claimPointer('draw');
  try {
    owned.click();
    assert.equal(writes.length, 0, 'drawing owns the pointer');
  } finally {
    releasePointer(lease);
  }
  owned.click();
  assert.equal(viewer.selectedEntity, ny);
  assert.equal(getSelectedEntityContext().entity, ny);
  const published = writes.at(-1);
  assert.equal(published.id, 'tracked');
  const card = published.entries[0];
  assert.equal(card.title, 'USGS-422702079005101');
  assert.equal(card.paintLane, 'tracked');
  assert.equal(card.protected, true);
  assert.ok(
    card.details.every((line) => line.length <= 68),
    'well card lines stay within the native monospace card width',
  );
  assert.ok(visible.some(({ id, show }) => id === 'tracked' && show));
  assert.match(card.details.join('\n'), /Ct-2498/);
  assert.match(card.details.join('\n'), /32.01 ft/);
  assert.match(card.details.join('\n'), /Depth below land surface/);
  assert.match(card.details.join('\n'), /Observed:.*precision/);
  assert.match(card.details.join('\n'), /Retrieved:.*2026/);
  assert.match(card.details.join('\n'), /Approval: Provisional/);
  assert.match(card.details.join('\n'), /https:\/\/waterdata.usgs.gov/);
  const visual = Cesium.Cartographic.fromCartesian(card.position());
  assert.ok(Math.abs(visual.height - 430) < 0.001);

  const beforeMiss = writes.length;
  viewer.scene.pick = () => ({ id: { id: 'another-layer' } });
  owned.click();
  assert.equal(writes.length, beforeMiss, 'unowned picks do not publish cards');
  const beforeClear = clears.length;
  layer.disable();
  assert.equal(getSelectedEntityContext(), null);
  assert.ok(clears.length > beforeClear, 'disable clears the card host');
  assert.equal(owned.listeners.size, 0);
});
test('camera movement during initial load, count/detail transitions and disposal never commit stale data', async () => {
  const f = fixtureViewer();
  f.viewer.scene.groundPrimitives = new Cesium.PrimitiveCollection();
  const requests = [];
  const source = {
    viewport: true,
    getSnapshot: ({ signal, bounds }) =>
      new Promise((resolve, reject) =>
        requests.push({ signal, bounds, resolve, reject }),
      ),
  };
  const layer = createUsGroundwaterLayer({ source });
  layer.init(f.viewer);
  const starting = layer.enable();
  await new Promise(setImmediate);
  f.viewer.camera.computeViewRectangle = () =>
    Cesium.Rectangle.fromDegrees(-104, 29, -103, 30);
  f.viewer.camera.moveEnd.raiseEvent();
  await new Promise(setImmediate);
  assert.equal(requests[0].signal.aborted, true);
  const sample = await createBundledWellPackSource().getSnapshot();
  sample.coverage.indexed = true;
  sample.records = sample.records.slice(0, 1);
  requests[1].resolve(sample);
  await new Promise(setImmediate);
  requests[0].resolve({ ...sample, records: [] });
  assert.equal(await starting, true);
  assert.equal(layer.getRecords().length, 1);
  const counts = {
    schemaVersion: 1,
    kind: 'gev-well-count-view',
    total: 10,
    degrees: 2,
    coverageComplete: false,
    reason: 'test',
    cells: [{ bounds: [-104, 28, -102, 30], count: 10 }],
  };
  f.viewer.camera.moveEnd.raiseEvent();
  requests[2].resolve(counts);
  await new Promise(setImmediate);
  assert.equal(layer.getStats().count, 10);
  assert.deepEqual(layer.getRecords(), []);
  let drill;
  f.viewer.camera.flyTo = (options) => {
    drill = options.destination;
  };
  f.viewer.scene.pick = () => ({
    id: f.viewer.dataSources.get(0).entities.values[0],
  });
  f.click();
  assert.equal(
    drill,
    undefined,
    'internal count evidence never triggers a camera flight',
  );
  assert.equal(f.viewer.scene.groundPrimitives.length, 0);
  assert.equal(
    f.viewer.dataSources.get(0).entities.values.length,
    0,
    'counts allocate no representative well',
  );
  f.viewer.camera.moveEnd.raiseEvent();
  requests[3].reject(new Error('synthetic failure'));
  await new Promise(setImmediate);
  assert.equal(layer.getStats().count, 10);
  f.viewer.camera.moveEnd.raiseEvent();
  requests[4].resolve(sample);
  await new Promise(setImmediate);
  assert.equal(f.viewer.scene.groundPrimitives.length, 0);
  layer.disable();
  assert.equal(f.viewer.dataSources.length, 0);
  assert.equal(f.viewer.camera.moveEnd.numberOfListeners, 0);
  const again = layer.enable();
  await new Promise(setImmediate);
  requests[5].resolve(counts);
  assert.equal(await again, true);
  layer.destroy();
  assert.equal(f.viewer.scene.groundPrimitives.length, 0);
  assert.equal(f.viewer.dataSources.length, 0);
});

test('one enable operation follows repeated initial moves and settles the actual manager ON', async () => {
  const f = fixtureViewer(),
    requests = [];
  const source = {
    viewport: true,
    getSnapshot: ({ signal, bounds }) =>
      new Promise((resolve) => requests.push({ signal, bounds, resolve })),
  };
  const layer = createUsGroundwaterLayer({ source });
  const manager = new LayerLifecycle(f.viewer);
  manager.register(layer);
  let settled = false;
  const enabling = manager.setEnabled('us-groundwater', true).then((value) => {
    settled = true;
    return value;
  });
  await new Promise(setImmediate);
  for (let i = 0; i < 3; i++) {
    f.viewer.camera.computeViewRectangle = () =>
      Cesium.Rectangle.fromDegrees(-104 + i * 0.1, 29, -103 + i * 0.1, 30);
    f.viewer.camera.moveEnd.raiseEvent();
    await new Promise(setImmediate);
    assert.equal(requests[i].signal.aborted, true);
    assert.equal(settled, false);
  }
  const pack = await createBundledWellPackSource().getSnapshot();
  requests[3].resolve(pack);
  assert.equal(await enabling, true);
  const row = manager.getAll().find((r) => r.id === 'us-groundwater');
  assert.equal(row.enabled, true);
  for (const old of requests.slice(0, 3)) old.resolve({ ...pack, records: [] });
  await new Promise(setImmediate);
  assert.equal(layer.getRecords().length, 6);
  assert.equal(await manager.setEnabled('us-groundwater', false), true);
  assert.equal(
    manager.getAll().find((r) => r.id === 'us-groundwater').enabled,
    false,
  );
  layer.destroy();
});
test('disable cancels the same pending enable promptly even when transport ignores abort', async () => {
  const f = fixtureViewer(),
    requests = [];
  const layer = createUsGroundwaterLayer({
    source: {
      viewport: true,
      getSnapshot: ({ signal }) =>
        new Promise((resolve) => requests.push({ signal, resolve })),
    },
  });
  layer.init(f.viewer);
  const enabling = layer.enable();
  await new Promise(setImmediate);
  f.viewer.camera.moveEnd.raiseEvent();
  await new Promise(setImmediate);
  layer.disable();
  assert.equal(await enabling, false);
  assert.equal(requests[1].signal.aborted, true);
  const pack = await createBundledWellPackSource().getSnapshot();
  for (const r of requests) r.resolve(pack);
  await new Promise(setImmediate);
  assert.equal(f.viewer.dataSources.length, 0);
  assert.equal(f.viewer.camera.moveEnd.numberOfListeners, 0);
  assert.deepEqual(layer.getRecords(), []);
  layer.destroy();
});
