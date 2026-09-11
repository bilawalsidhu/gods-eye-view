import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as Cesium from 'cesium';
import {
  GROUND_SAMPLE_MAX_ARMED_RETRIES,
  LOCAL_OVERLAY_COHORT_LIMIT,
  LOCAL_STEM_TIP_EPSILON_M,
  createLocalGeoJsonLayer,
  createLocalInfrastructureOverlayEntry,
  createLocalInfrastructureOverlayPublisher,
  localDatasetError,
  localInfrastructureOverlayCopy,
  selectLocalInfrastructureOverlayCohort,
} from './localGeojson.js';
import { layerFeedState } from './manager.js';
import { INFRA_LOD_ACTIVE_MIN, INFRA_LOD_ACTIVE_MAX } from './localGeojsonLod.js';
import {
  installRenderGovernor,
  getRenderGovernorDiagnostics,
  _resetRenderGovernorForTest,
} from '../renderGovernor.js';

class MockLayerEvent {
  constructor() {
    this.listeners = new Set();
    this.addCount = 0;
    this.removeCount = 0;
  }

  addEventListener(listener) {
    this.addCount++;
    this.listeners.add(listener);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.removeCount++;
      this.listeners.delete(listener);
    };
  }

  raise(...args) {
    for (const listener of [...this.listeners]) listener(...args);
  }
}

/**
 * @param {object} [options]
 * @param {boolean} [options.sampleHeightSupported] Scene height-sampling capability.
 * @param {Function} [options.sampleHeight] Initial scene.sampleHeight behavior
 *   (default: throws like a scene whose tiles are not sampleable yet).
 */
async function createRealLocalLayerHarness({
  sampleHeightSupported = false,
  sampleHeight = () => { throw new Error('tiles not sampleable yet'); },
} = {}) {
  const originalFetch = globalThis.fetch;
  const originalWindow = globalThis.window;
  const preRender = new MockLayerEvent();
  const moveEnd = new MockLayerEvent();
  const dataSources = [];
  const hostCalls = [];
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({
      type: 'Feature',
      id: 'real-dam',
      properties: { name: 'Runtime Dam', tags: { associated_river: 'Test River' } },
      geometry: {
        type: 'Polygon',
        coordinates: [[
          [-97.70, 30.20],
          [-97.69, 30.20],
          [-97.69, 30.21],
          [-97.70, 30.20],
        ]],
      },
    }),
  });
  globalThis.window = { dispatchEvent() {} };
  let sampleHeightImpl = sampleHeight;
  const sampleCalls = { count: 0 };
  const overlayHost = {
    setVisible: (...args) => hostCalls.push(['visible', ...args]),
    setEntries: (...args) => hostCalls.push(['entries', ...args]),
    clearSource: (...args) => hostCalls.push(['clear', ...args]),
  };
  const viewer = {
    selectedEntity: undefined,
    dataSources: {
      add(dataSource) { dataSources.push(dataSource); return dataSource; },
      remove(dataSource) {
        const index = dataSources.indexOf(dataSource);
        if (index >= 0) dataSources.splice(index, 1);
        return index >= 0;
      },
    },
    camera: {
      positionWC: Cesium.Cartesian3.fromDegrees(-97.695, 30.205, 100_000),
      frustum: { fov: Math.PI / 3 },
      moveEnd,
      flyTo() {},
    },
    scene: {
      canvas: { clientWidth: 800, clientHeight: 600 },
      preRender,
      sampleHeightSupported,
      sampleHeight: (...args) => {
        sampleCalls.count += 1;
        return sampleHeightImpl(...args);
      },
      screenSpaceCameraController: { enableInputs: true },
      pick() { return null; },
      requestRender() {},
    },
  };
  const layer = createLocalGeoJsonLayer({
    id: 'local-dams',
    url: '/runtime-dam.geojsonl',
    name: 'Runtime Dams',
    color: '#0088ff',
    overlayHost,
    projectToWindow: () => ({ x: 400, y: 300 }),
    screenSpaceEventHandlerFactory: () => ({
      setInputAction() {},
      destroy() {},
    }),
  });
  try {
    await layer.enable(viewer);
  } finally {
    globalThis.fetch = originalFetch;
  }
  return {
    layer,
    viewer,
    dataSources,
    hostCalls,
    preRender,
    moveEnd,
    sampleCalls,
    /** Swap scene.sampleHeight mid-test (e.g. tiles finally arrive). */
    setSampleHeight(next) { sampleHeightImpl = next; },
    cleanup() {
      if (originalWindow === undefined) delete globalThis.window;
      else globalThis.window = originalWindow;
    },
  };
}

test('local infrastructure card copy uses the owner-approved source fields', () => {
  assert.deepEqual(localInfrastructureOverlayCopy({
    tags: {
      name: 'DFW-1',
      operator: 'Example Cloud',
      'capacity:it_load': '27 MW',
    },
  }, 'local-datacenters'), {
    title: 'DFW-1',
    details: ['Example Cloud · 27 MW'],
  });

  assert.deepEqual(localInfrastructureOverlayCopy({
    name: 'Barrage Bin el Ouidane',
    tags: { associated_river: 'El Abid' },
  }, 'local-dams'), {
    title: 'Barrage Bin el Ouidane',
    details: ['El Abid'],
  });

  assert.deepEqual(localInfrastructureOverlayCopy({
    tags: { name: 'Amazon Web Services', operator: 'Amazon Web Services' },
  }, 'local-datacenters'), {
    title: 'Amazon Web Services',
    details: [],
  });
});

test('local infrastructure entries satisfy the shared presentation contract', () => {
  const position = Cesium.Cartesian3.fromDegrees(-97.7, 30.2, 2000);
  const entry = createLocalInfrastructureOverlayEntry({
    id: 'dc-42',
    layerId: 'local-datacenters',
    position,
    properties: { tags: { name: 'AUS-1', operator: 'Example Cloud' } },
    priority: 1180,
    accent: '#00ffff',
  });

  assert.equal(entry.id, 'dc-42');
  assert.equal(entry.source, 'local-datacenters');
  assert.equal(entry.position, position, 'entry stays attached to the mutable stem-tip Cartesian');
  assert.equal(entry.variant, 'card');
  assert.equal(entry.title, 'AUS-1');
  assert.deepEqual(entry.details, ['Example Cloud']);
  assert.equal(entry.priority, 1180);
  assert.equal(entry.collisionGroup, 'ambient-card');
  assert.equal(entry.interactive, false, 'point/stem picking remains Cesium-native');
  assert.equal(entry.maxDistance, 14_000_000);
  assert.equal(entry.distanceFadeStartRatio, 250_000 / 14_000_000);
  assert.deepEqual(entry.distanceScale, {
    near: 250_000,
    nearValue: 1,
    far: 9_000_000,
    farValue: 0.62,
  });
  assert.equal(entry.edgeFade, 'keyhole');
  assert.equal(entry.horizonCull, true);
  assert.equal(entry.terrainOcclusion, false);
});

test('shipped local cohorts keep one grid winner plus bounded surplus contenders', () => {
  const makeRecord = (id, priority, x, y = 20) => ({
    id,
    priority,
    screen: { x, y },
    entry: { id },
  });
  const sameCell = [
    makeRecord('low', 1, 20),
    makeRecord('high', 3, 21),
    makeRecord('mid', 2, 22),
    makeRecord('offscreen', 100, -500),
  ];
  const selected = selectLocalInfrastructureOverlayCohort(sameCell, {
    maxEntries: 700,
    cohortLimit: LOCAL_OVERLAY_COHORT_LIMIT,
    gridPx: 138,
    width: 1440,
    height: 900,
    project: (record) => record.screen,
  });
  assert.deepEqual(selected.map(({ id }) => id), ['high', 'mid']);

  const field = Array.from({ length: 220 }, (_, index) => makeRecord(
    `record-${index}`,
    1000 - index,
    index * 140,
  ));
  const datacenters = selectLocalInfrastructureOverlayCohort(field, {
    maxEntries: 700,
    cohortLimit: LOCAL_OVERLAY_COHORT_LIMIT,
    gridPx: 138,
    width: 150_000,
    height: 900,
    project: (record) => record.screen,
  });
  const dams = selectLocalInfrastructureOverlayCohort(field, {
    maxEntries: 900,
    cohortLimit: LOCAL_OVERLAY_COHORT_LIMIT,
    gridPx: 132,
    width: 150_000,
    height: 900,
    project: (record) => record.screen,
  });
  assert.equal(datacenters.length, LOCAL_OVERLAY_COHORT_LIMIT);
  assert.equal(dams.length, LOCAL_OVERLAY_COHORT_LIMIT);

  const pairedCells = Array.from({ length: 120 }, (_, index) => [
    makeRecord(`primary-${index}`, 1000, index * 140),
    makeRecord(`surplus-${index}`, 900, index * 140 + 1),
  ]).flat();
  const hostBound = selectLocalInfrastructureOverlayCohort(pairedCells, {
    maxEntries: 700,
    cohortLimit: LOCAL_OVERLAY_COHORT_LIMIT,
    gridPx: 138,
    width: 20_000,
    height: 900,
    project: (record) => record.screen,
  });
  assert.equal(hostBound.length, LOCAL_OVERLAY_COHORT_LIMIT);
  assert.equal(hostBound.filter(({ id }) => id.startsWith('primary-')).length, 120);
  assert.equal(hostBound.filter(({ id }) => id.startsWith('surplus-')).length, 40);
});

test('local overlay publisher owns add/remove/visibility lifecycle and becomes inert on destroy', () => {
  const calls = [];
  const publisher = createLocalInfrastructureOverlayPublisher({
    sourceId: 'local-datacenters',
    host: {
      setVisible: (...args) => calls.push(['visible', ...args]),
      setEntries: (...args) => calls.push(['entries', ...args]),
      clearSource: (...args) => calls.push(['clear', ...args]),
    },
  });

  publisher.publish([{ id: 'ignored-before-show' }]);
  publisher.show();
  publisher.show();
  publisher.publish([{ id: 'dc-1' }]);
  publisher.publish([]);
  publisher.hide();
  publisher.show();
  publisher.publish([{ id: 'dc-2' }]);
  publisher.destroy();
  const countAtDestroy = calls.length;
  publisher.show();
  publisher.publish([{ id: 'zombie' }]);

  assert.equal(calls.length, countAtDestroy, 'destroyed publishers reject late source work');
  assert.deepEqual(calls[0], ['visible', 'local-datacenters', true]);
  assert.deepEqual(calls[1].slice(0, 3), ['entries', 'local-datacenters', [{ id: 'dc-1' }]]);
  assert.deepEqual(calls[1][3], {
    cohortLimit: LOCAL_OVERLAY_COHORT_LIMIT,
    collisionCapacity: 96,
    moving: false,
  });
  assert.deepEqual(calls[2].slice(0, 3), ['entries', 'local-datacenters', []]);
  assert.deepEqual(calls[3], ['visible', 'local-datacenters', false]);
  assert.deepEqual(calls[4], ['visible', 'local-datacenters', true]);
  assert.deepEqual(calls[6], ['clear', 'local-datacenters']);
  assert.deepEqual(calls[7], ['visible', 'local-datacenters', false]);
});

test('slow parked frames do not keep republishing the same local overlay cohort', async (t) => {
  const env = await createRealLocalLayerHarness();
  const clock = installFakeClock(t);
  t.after(() => { env.layer.destroy(env.viewer); env.cleanup(); });
  const publications = () => env.hostCalls.filter(([type]) => type === 'entries');
  env.preRender.raise();
  assert.equal(publications().length, 1);
  assert.ok(publications()[0][2].length > 0, 'the initial cohort must be populated');
  for (let i = 0; i < 6; i++) {
    clock.advance(1_000); // Every slow frame passes the 450 ms source throttle.
    env.preRender.raise();
  }
  assert.equal(publications().length, 1,
    'unchanged publication invalidates the real host and requests another slow frame');

  const camera = env.viewer.camera.positionWC;
  env.viewer.camera.positionWC = Cesium.Cartesian3.add(camera,
    new Cesium.Cartesian3(10_000, 0, 0), new Cesium.Cartesian3());
  env.moveEnd.raise();
  env.preRender.raise();
  assert.equal(publications().length, 2, 'changed stem positions must still reach the host');
  env.layer.disable(env.viewer);
  await env.layer.enable(env.viewer);
  env.preRender.raise();
  assert.equal(publications().length, 3, 're-enable must republish after clearing the host');
});

test('real layer disable clears its published host entries and balances settle listeners', async () => {
  const env = await createRealLocalLayerHarness();
  env.preRender.raise();
  assert.ok(env.hostCalls.some(([type]) => type === 'entries'), 'real preRender path did not publish');

  env.layer.disable(env.viewer);
  assert.ok(
    env.hostCalls.some((call) => call[0] === 'clear' && call[1] === 'local-dams'),
    'real disable path must clear the host source',
  );
  assert.equal(env.moveEnd.listeners.size, 0);
  assert.equal(env.moveEnd.addCount, 1);
  assert.equal(env.moveEnd.removeCount, 1);

  await env.layer.enable(env.viewer);
  await env.layer.enable(env.viewer);
  assert.equal(env.moveEnd.listeners.size, 1, 'repeated enable must retain one settle listener');
  env.layer.disable(env.viewer);
  assert.equal(env.moveEnd.addCount, 2);
  assert.equal(env.moveEnd.removeCount, 2);

  await env.layer.enable(env.viewer);
  env.layer.destroy(env.viewer);
  assert.equal(env.moveEnd.listeners.size, 0);
  assert.equal(env.moveEnd.addCount, 3);
  assert.equal(env.moveEnd.removeCount, 3);
  const addCountAtDestroy = env.moveEnd.addCount;
  await env.layer.enable(env.viewer);
  assert.equal(env.moveEnd.addCount, addCountAtDestroy, 'destroyed layer must stay permanently inert');
  env.cleanup();
});

test('unchanged moveEnds do not redefine stem constants and real tip changes update once', async () => {
  const env = await createRealLocalLayerHarness();
  env.preRender.raise();
  const entity = env.dataSources[0].entities.values[0];
  let positionSetCalls = 0;
  let polylineSetCalls = 0;
  let polylineDefinitionChanges = 0;
  const stemArrays = [];
  const initialStemArray = entity.polyline.positions.getValue();
  const originalPositionSet = entity.position.setValue.bind(entity.position);
  const originalPolylineSet = entity.polyline.positions.setValue.bind(entity.polyline.positions);
  const removeDefinitionListener = entity.polyline.definitionChanged.addEventListener(
    (_polyline, propertyName) => {
      if (propertyName === 'positions') polylineDefinitionChanges++;
    },
  );
  entity.position.setValue = (...args) => {
    positionSetCalls++;
    return originalPositionSet(...args);
  };
  entity.polyline.positions.setValue = (...args) => {
    polylineSetCalls++;
    stemArrays.push(args[0]);
    return originalPolylineSet(...args);
  };

  env.moveEnd.raise();
  env.preRender.raise();
  env.moveEnd.raise();
  env.preRender.raise();
  assert.equal(positionSetCalls, 0);
  assert.equal(polylineSetCalls, 0);
  assert.equal(polylineDefinitionChanges, 0);

  const camera = env.viewer.camera.positionWC;
  env.viewer.camera.positionWC = Cesium.Cartesian3.add(
    camera,
    new Cesium.Cartesian3(LOCAL_STEM_TIP_EPSILON_M / 10, 0, 0),
    new Cesium.Cartesian3(),
  );
  env.moveEnd.raise();
  env.preRender.raise();
  assert.equal(positionSetCalls, 0, 'sub-epsilon camera noise must not redefine the tip');
  assert.equal(polylineSetCalls, 0);
  assert.equal(polylineDefinitionChanges, 0, 'sub-epsilon jitter must not redefine the polyline');

  env.viewer.camera.positionWC = Cesium.Cartesian3.add(
    camera,
    new Cesium.Cartesian3(10_000, 0, 0),
    new Cesium.Cartesian3(),
  );
  env.moveEnd.raise();
  env.preRender.raise();
  assert.equal(positionSetCalls, 1);
  assert.equal(polylineSetCalls, 1);
  assert.equal(polylineDefinitionChanges, 1, 'one real tip change must emit one polyline notification');

  env.viewer.camera.positionWC = Cesium.Cartesian3.add(
    camera,
    new Cesium.Cartesian3(20_000, 0, 0),
    new Cesium.Cartesian3(),
  );
  env.moveEnd.raise();
  env.preRender.raise();
  assert.equal(positionSetCalls, 2);
  assert.equal(polylineSetCalls, 2);
  assert.equal(polylineDefinitionChanges, 2, 'each real tip change must emit exactly one notification');

  env.viewer.camera.positionWC = Cesium.Cartesian3.add(
    camera,
    new Cesium.Cartesian3(30_000, 0, 0),
    new Cesium.Cartesian3(),
  );
  env.moveEnd.raise();
  env.preRender.raise();
  assert.equal(positionSetCalls, 3);
  assert.equal(polylineSetCalls, 3);
  assert.equal(polylineDefinitionChanges, 3, 'third real tip change must emit exactly one notification');
  assert.notEqual(stemArrays[0], initialStemArray, 'first real update must select the alternate buffer');
  assert.equal(stemArrays[1], initialStemArray, 'second real update must return to the initial buffer');
  assert.equal(stemArrays[2], stemArrays[0], 'consecutive real updates must alternate buffer identity');
  assert.equal(
    new Set([initialStemArray, ...stemArrays]).size,
    2,
    'steady-state updates must allocate no stem arrays beyond the two preallocated buffers',
  );
  removeDefinitionListener();
  env.layer.destroy(env.viewer);
  env.cleanup();
});

test('a real enabled local layer has no native label graphics at runtime', async () => {
  const env = await createRealLocalLayerHarness();
  const entities = env.dataSources[0].entities.values;
  assert.ok(entities.length > 0, 'runtime guard requires a populated real data source');
  assert.ok(entities.every((entity) => entity.label === undefined));
  env.layer.destroy(env.viewer);
  env.cleanup();
});

for (const [heightM, minStemM, maxStemM] of [[500, 45, 90], [10000, 1100, 1400]]) {
  test(`local infrastructure keeps stems proportional at ${heightM} m`, async (t) => {
    const env = await createRealLocalLayerHarness();
    t.after(() => { env.layer.destroy(env.viewer); env.cleanup(); });
    const entity = env.dataSources[0].entities.values[0];
    const carto = entity.__localBaseCarto;
    env.viewer.camera.positionWC = Cesium.Cartesian3.fromRadians(carto.longitude, carto.latitude, heightM);
    env.preRender.raise(env.viewer.scene, Cesium.JulianDate.now());
    const positions = entity.polyline.positions.getValue(Cesium.JulianDate.now());
    const stemM = Cesium.Cartesian3.distance(positions[0], positions[1]);
    assert.ok(stemM >= minStemM && stemM <= maxStemM,
      `a ${heightM} m close-up must not inherit a globe-sized stem: ${stemM.toFixed(1)} m`);
  });
}

test('local infrastructure creates no native labels or per-frame geometry callbacks', () => {
  const source = readFileSync(new URL('./localGeojson.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /new Cesium\.LabelGraphics/);
  assert.doesNotMatch(source, /new Cesium\.CallbackProperty/);
  assert.match(source, /feature\.position = tip/);
  assert.match(source, /record\.entity\.position\.setValue\(record\.tip\)/);
  assert.match(source, /const stemPositionBuffers = \[\[base, tip\], \[base, tip\]\]/);
  assert.match(source, /record\.entity\.polyline\.positions\.setValue\(stemPositions\)/);
  assert.match(source, /viewer\.camera\.moveEnd\.addEventListener/);
  assert.match(source, /if \(refreshStemGeometry \|\| terrainFloorChanged\)/);
  assert.match(source, /now - _lastVisibilityUpdate < VISIBILITY_UPDATE_MS/);
});

// ─── Bundled-dataset failure surfacing (roadmap L7) ───────────
//
// These datasets ship with the build, so a failed load means a broken
// install. Before this contract the catch only logged: a dead layer and an
// empty one both reported {count: 0} and the manager painted a green ON chip.

/** Build the failing layer alone — the harness above owns the happy path. */
async function enableLayerWithFetch(fetchImpl, { dataSources, windowStub } = {}) {
  const originalFetch = globalThis.fetch;
  const originalWindow = globalThis.window;
  globalThis.window = windowStub || { dispatchEvent() {} };
  const viewer = {
    dataSources: dataSources || { add() {}, remove() { return true; } },
    camera: { positionWC: Cesium.Cartesian3.fromDegrees(0, 0, 1000), moveEnd: new MockLayerEvent() },
    scene: { canvas: {}, preRender: new MockLayerEvent(), pick() { return null; } },
  };
  const layer = createLocalGeoJsonLayer({
    id: 'local-dams',
    url: '/missing.geojsonl',
    name: 'Dams',
    color: '#0088ff',
    overlayHost: { setVisible() {}, setEntries() {}, clearSource() {} },
    screenSpaceEventHandlerFactory: () => ({ setInputAction() {}, destroy() {} }),
  });
  const enable = async () => {
    globalThis.fetch = fetchImpl;
    try {
      await layer.enable(viewer);
    } finally {
      globalThis.fetch = originalFetch;
    }
  };
  await enable();
  const cleanup = () => {
    layer.destroy(viewer);
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  };
  return { layer, viewer, cleanup, enable };
}

test('a bundled-dataset failure reduces to a short, honest reason', () => {
  assert.equal(
    localDatasetError(new SyntaxError('Unexpected token < in JSON at position 0')),
    'dataset is malformed',
  );
  assert.equal(localDatasetError(new Error('HTTP 404')), 'dataset unavailable (HTTP 404)');
  assert.equal(localDatasetError(new Error('')), 'dataset unavailable');
  assert.equal(localDatasetError(undefined), 'dataset unavailable');
});

test('a missing dataset reports UNAVAILABLE instead of a silent empty layer', async () => {
  const { layer, cleanup } = await enableLayerWithFetch(async () => ({
    ok: false,
    status: 404,
    text: async () => '<!DOCTYPE html>',
  }));
  const stats = layer.getStats();
  assert.equal(stats.count, 0);
  assert.equal(stats.lastUpdate, null);
  assert.equal(stats.error, 'dataset unavailable (HTTP 404)');
  assert.equal(layerFeedState(stats), 'unavailable');
  cleanup();
});

test('a corrupt dataset line reports malformed rather than parsing into nothing', async () => {
  const { layer, cleanup } = await enableLayerWithFetch(async () => ({
    ok: true,
    status: 200,
    text: async () => '{"type":"Feature"\n',
  }));
  const stats = layer.getStats();
  assert.equal(stats.error, 'dataset is malformed');
  assert.equal(layerFeedState(stats), 'unavailable');
  cleanup();
});

// Polygon, like the harness above: Cesium builds Point features through a
// canvas pin builder, which needs a DOM these tests do not have.
const ONE_POLYGON_FEATURE = JSON.stringify({
  type: 'Feature',
  id: 'dam-1',
  properties: { name: 'Test Dam' },
  geometry: {
    type: 'Polygon',
    coordinates: [[[-97.70, 30.20], [-97.69, 30.20], [-97.69, 30.21], [-97.70, 30.20]]],
  },
});

const serveOnePolygon = async () => ({
  ok: true,
  status: 200,
  text: async () => ONE_POLYGON_FEATURE,
});

/**
 * Scene collection with Cesium's real timing: DataSourceCollection.add()
 * returns a promise and inserts on a LATER microtask, so the source is not in
 * the collection when add() returns. A synchronous mock hides exactly the bug
 * this models.
 */
function asyncDataSources({ rejectAdd = false } = {}) {
  const added = [];
  return {
    added,
    add(dataSource) {
      if (rejectAdd) return Promise.reject(new Error('scene rejected the data source'));
      return Promise.resolve().then(() => {
        added.push(dataSource);
        return dataSource;
      });
    },
    remove(dataSource) {
      const index = added.indexOf(dataSource);
      if (index >= 0) added.splice(index, 1);
      return index >= 0;
    },
  };
}

/** A window whose context store throws once — an exception during post-processing. */
function windowThatFailsOnce() {
  let armed = true;
  let store;
  return {
    dispatchEvent() {},
    get __gevContextStore() {
      if (armed) {
        armed = false;
        throw new Error('post-processing failed');
      }
      return store;
    },
    set __gevContextStore(value) { store = value; },
  };
}

test('a post-processing failure after the scene accepts the source rolls it back, and the retry does not double-add', async () => {
  // The window between GeoJsonDataSource.load() and the end of entity
  // post-processing. Publishing early made every later enable() skip the
  // loader; rolling back before the add settled left Cesium to insert the
  // "removed" source afterwards, which the retry would then double up on.
  const scene = asyncDataSources();
  const { layer, cleanup, enable } = await enableLayerWithFetch(serveOnePolygon, {
    dataSources: scene,
    windowStub: windowThatFailsOnce(),
  });

  const failed = layer.getStats();
  assert.equal(failed.error, 'dataset unavailable (post-processing failed)');
  assert.equal(failed.count, 0);
  assert.equal(failed.lastUpdate, null);
  assert.equal(layerFeedState(failed), 'unavailable');
  assert.equal(scene.added.length, 0,
    'rollback must remove the source the scene already accepted');

  await enable();
  const retried = layer.getStats();
  assert.equal(retried.error, null, 'the retry must clear the error, not skip the loader');
  assert.equal(retried.count, 1);
  assert.ok(Number.isFinite(retried.lastUpdate));
  assert.equal(scene.added.length, 1, 'the retry must not leave two sources in the scene');
  cleanup();
});

test('a rejected scene add surfaces as an error instead of healthy stats', async () => {
  const scene = asyncDataSources({ rejectAdd: true });
  const { layer, cleanup } = await enableLayerWithFetch(serveOnePolygon, {
    dataSources: scene,
  });
  const stats = layer.getStats();
  assert.equal(stats.error, 'dataset unavailable (scene rejected the data source)');
  assert.equal(stats.count, 0);
  assert.equal(stats.lastUpdate, null);
  assert.equal(layerFeedState(stats), 'unavailable');
  assert.equal(scene.added.length, 0);
  cleanup();
});

test('a loaded dataset is distinguishable from a dead one', async () => {
  const env = await createRealLocalLayerHarness();
  const stats = env.layer.getStats();
  assert.equal(stats.error, null);
  assert.ok(stats.count > 0);
  assert.ok(Number.isFinite(stats.lastUpdate), 'a successful load must timestamp itself');
  assert.equal(layerFeedState(stats), 'nominal');
  env.layer.destroy(env.viewer);
  env.cleanup();
});

// ── Ground-sample retry vs the idle render governor ───────────────────────────
//
// These layers take NO continuous hold and have updateInterval 0, so nothing
// else ever asks for a frame. The stem grounding retry lives in preRender: if
// the first sample fails (tiles not yet sampleable) and no frame is scheduled,
// a parked camera never produces the retry frame and the stem stays at
// ellipsoid height — buried in, or floating over, the photoreal mesh until the
// user happens to move. main retried continuously; under the governor the
// retry must schedule its own frame. (perf rebase 2026-08-17)

/** Drop the camera to `altM` above the fixture dam so retries are in range. */
function setCameraAltitude(env, altM) {
  env.viewer.camera.positionWC = Cesium.Cartesian3.fromDegrees(-97.695, 30.205, altM);
}

function governorReasons() {
  return getRenderGovernorDiagnostics().recentRequests.map((entry) => entry.reason);
}

test('ground sampling waits for visible globe tiles before caching a height', async (t) => {
  const env = await createRealLocalLayerHarness({
    sampleHeightSupported: true, sampleHeight: () => 117,
  });
  const clock = installFakeClock(t);
  t.after(() => { env.layer.destroy(env.viewer); env.cleanup(); });
  env.viewer.scene.globe = { show: true, tilesLoaded: false, getHeight: () => 117 };
  setCameraAltitude(env, 20_000);
  env.preRender.raise();
  assert.equal(env.sampleCalls.count, 0, 'streaming terrain must not become a permanent coarse sample');
  assert.ok(Math.abs(baseHeightM(env)) < 0.01);
  env.viewer.scene.globe.tilesLoaded = true;
  clock.advance(2_100);
  env.preRender.raise();
  assert.equal(env.sampleCalls.count, 1, 'the existing retry must sample the settled scene');
  assert.ok(Math.abs(baseHeightM(env) - 117) < 0.01);
});

test('settled terrain refinement lifts an already sampled stem without another GPU sample', async (t) => {
  const env = await createRealLocalLayerHarness({
    sampleHeightSupported: true, sampleHeight: () => 117,
  });
  const clock = installFakeClock(t);
  t.after(() => { env.layer.destroy(env.viewer); env.cleanup(); });
  let terrain = 117;
  const globe = { show: true, tilesLoaded: true, getHeight: () => terrain };
  env.viewer.scene.globe = globe;
  setCameraAltitude(env, 20_000);
  env.preRender.raise();
  assert.ok(Math.abs(baseHeightM(env) - 117) < 0.01);

  terrain = 120;
  globe.tilesLoaded = false;
  clock.advance(500);
  env.preRender.raise();
  assert.ok(Math.abs(baseHeightM(env) - 117) < 0.01, 'wait for the refined mesh to settle');
  globe.tilesLoaded = true;
  clock.advance(500);
  env.preRender.raise();
  assert.ok(Math.abs(baseHeightM(env) - 120) < 0.01, 'a parked marker must follow the refined floor');

  terrain = 110;
  clock.advance(500);
  env.preRender.raise();
  assert.ok(Math.abs(baseHeightM(env) - 120) < 0.01, 'a lower floor must not flatten existing geometry');
  terrain = 140;
  globe.show = false;
  clock.advance(500);
  env.preRender.raise();
  assert.ok(Math.abs(baseHeightM(env) - 120) < 0.01, 'hidden globe terrain must not constrain geometry');
  assert.equal(env.sampleCalls.count, 1, 'terrain maintenance must not repeat the GPU readback');
});

for (const [terrainHeight, sampledHeight, expectedHeight, globeShown] of [
  [117, -2238, 117, true],
  [-400, -410, -400, true],
  [117, 180, 180, true],
  [117, -20, -20, false],
]) {
  test(`ground sampling respects terrain ${terrainHeight} and geometry ${sampledHeight} with globe ${globeShown}`, async (t) => {
    const env = await createRealLocalLayerHarness({
      sampleHeightSupported: true, sampleHeight: () => sampledHeight,
    });
    installFakeClock(t);
    t.after(() => { env.layer.destroy(env.viewer); env.cleanup(); });
    env.viewer.scene.globe = { show: globeShown, getHeight: () => terrainHeight };
    setCameraAltitude(env, 20_000);
    env.preRender.raise();
    assert.ok(Math.abs(baseHeightM(env) - expectedHeight) < 0.01,
      `base ${baseHeightM(env)} must respect the visible terrain without flattening roofs or below-sea-level terrain`);
  });
}

test('a failed ground sample schedules the retry frame the idle governor would never produce', async (t) => {
  const env = await createRealLocalLayerHarness({ sampleHeightSupported: true });
  _resetRenderGovernorForTest();
  installRenderGovernor({ scene: { requestRender() {} } });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => {
    env.layer.destroy(env.viewer);
    env.cleanup();
    _resetRenderGovernorForTest();
  });

  // Close enough that a retry could succeed, on a scene that CAN sample but
  // whose tiles are not sampleable yet — a camera parked over a dam while the
  // photoreal mesh is still streaming in.
  setCameraAltitude(env, 20_000);
  env.preRender.raise();

  assert.ok(
    !governorReasons().some((reason) => reason.startsWith('local-ground-retry')),
    'the request must be DEFERRED by the retry window, not fired inline',
  );
  t.mock.timers.tick(2_100); // GROUND_SAMPLE_RETRY_MS (2000) + slack
  assert.ok(
    governorReasons().includes('local-ground-retry:local-dams'),
    `expected a scheduled retry render; saw ${JSON.stringify(governorReasons())}`,
  );
});

test('a far camera arms no retry render — the governor stays fully idle', async (t) => {
  const env = await createRealLocalLayerHarness({ sampleHeightSupported: true });
  _resetRenderGovernorForTest();
  installRenderGovernor({ scene: { requestRender() {} } });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => {
    env.layer.destroy(env.viewer);
    env.cleanup();
    _resetRenderGovernorForTest();
  });

  // 400 km up: way beyond GROUND_SAMPLE_MAX_DISTANCE_M, so no retry can ever
  // succeed and asking for frames would just spin the governor forever.
  setCameraAltitude(env, 400_000);
  env.preRender.raise();
  t.mock.timers.tick(5_000);

  assert.ok(
    !governorReasons().some((reason) => reason.startsWith('local-ground-retry')),
    `a far camera must not request frames; saw ${JSON.stringify(governorReasons())}`,
  );
});

test('disable cancels a pending ground-retry render', async (t) => {
  const env = await createRealLocalLayerHarness({ sampleHeightSupported: true });
  _resetRenderGovernorForTest();
  installRenderGovernor({ scene: { requestRender() {} } });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => {
    env.layer.destroy(env.viewer);
    env.cleanup();
    _resetRenderGovernorForTest();
  });

  setCameraAltitude(env, 20_000);
  env.preRender.raise();
  env.layer.disable(env.viewer);
  t.mock.timers.tick(5_000);

  assert.ok(
    !governorReasons().some((reason) => reason.startsWith('local-ground-retry')),
    `a disabled layer must not wake the scene; saw ${JSON.stringify(governorReasons())}`,
  );
});

// ── The retry must be able to STOP (review round 2) ───────────────────────────
//
// The retry above arms itself off its own requested frame, so anything that
// makes the sample permanently impossible turns it into a perpetual-motion
// machine: every frame it asks for schedules the next 2 s timer, and the idle
// governor never gets to sleep. Two gates close that: the scene CAPABILITY
// (a scene that cannot sample heights must never arm) and a bounded budget of
// consecutive arms (a sampleable scene with no sampleable surface).

/** Freeze performance.now so the 450 ms visibility gate is under test control. */
function installFakeClock(t, startMs = 1_000_000) {
  const original = performance.now;
  let nowMs = startMs;
  performance.now = () => nowMs;
  t.after(() => { performance.now = original; });
  return { advance(ms) { nowMs += ms; } };
}

/**
 * Run the self-armed retry chain: each preRender walk arms a timer, the timer
 * asks the governor for a frame, and that frame is the next walk.
 */
function runArmedRetryChain(env, t, clock, cycles) {
  for (let i = 0; i < cycles; i += 1) {
    env.preRender.raise();
    clock.advance(2_100); // > GROUND_SAMPLE_RETRY_MS, in lockstep with the timers
    t.mock.timers.tick(2_100);
  }
}

/** Height of the (mutated-in-place) stem base — 0 until a sample lands. */
function baseHeightM(env) {
  const entity = env.dataSources[0].entities.values[0];
  return Cesium.Cartographic.fromCartesian(entity.__localBaseCartesian).height;
}

/**
 * Count Cartesian3.distance calls. The retry path costs one per ungrounded
 * record per walk; on a scene that cannot sample, every one of them is waste
 * (O(N) every 450 ms in a keyless scene that some other layer keeps awake).
 */
function countDistanceCalls(t) {
  const original = Cesium.Cartesian3.distance;
  const calls = { count: 0 };
  Cesium.Cartesian3.distance = (...args) => {
    calls.count += 1;
    return original(...args);
  };
  t.after(() => { Cesium.Cartesian3.distance = original; });
  return calls;
}

test('a scene that cannot sample heights never arms a retry — not even once', async (t) => {
  // Keyless/no-sampleable-surface scene: sampleHeightSupported === false, so a
  // retry can NEVER succeed. Arming here re-armed forever (one 2 s timer per
  // requested frame) and quietly defeated the idle governor.
  const env = await createRealLocalLayerHarness({ sampleHeightSupported: false });
  _resetRenderGovernorForTest();
  const governorScene = { renders: 0, requestRender() { this.renders += 1; } };
  installRenderGovernor({ scene: governorScene });
  governorScene.renders = 0; // discard the governor's own install settling frame
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const clock = installFakeClock(t);
  t.after(() => {
    env.layer.destroy(env.viewer);
    env.cleanup();
    _resetRenderGovernorForTest();
  });

  setCameraAltitude(env, 20_000); // in range: the ONLY thing missing is the capability
  // Settle the one-off geometry refresh (that walk legitimately measures the
  // camera distance to size the stem), then measure the STEADY state.
  env.preRender.raise();
  clock.advance(2_100);
  const distances = countDistanceCalls(t);
  runArmedRetryChain(env, t, clock, 5);

  assert.equal(governorScene.renders, 0, 'an unsampleable scene must ask for no frames at all');
  assert.ok(
    !governorReasons().some((reason) => reason.startsWith('local-ground-retry')),
    `no retry may be armed without the capability; saw ${JSON.stringify(governorReasons())}`,
  );
  assert.equal(env.sampleCalls.count, 0, 'and it must not even attempt the sample');
  assert.equal(
    distances.count,
    0,
    'nor spend a single per-record distance on a retry that cannot succeed',
  );
  assert.equal(baseHeightM(env), 0, 'records stay at ellipsoid height — the pre-perf behavior');
});

test('a sampleable scene still measures the retry distance it needs', async (t) => {
  // The mirror of the guard above: the capability check must gate the work, not
  // remove it — a scene that CAN sample still pays one distance per walk.
  const env = await createRealLocalLayerHarness({ sampleHeightSupported: true });
  _resetRenderGovernorForTest();
  installRenderGovernor({ scene: { requestRender() {} } });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const clock = installFakeClock(t);
  t.after(() => {
    env.layer.destroy(env.viewer);
    env.cleanup();
    _resetRenderGovernorForTest();
  });

  setCameraAltitude(env, 20_000);
  env.preRender.raise();
  clock.advance(2_100);
  const distances = countDistanceCalls(t);
  runArmedRetryChain(env, t, clock, 5);

  assert.ok(distances.count > 0, 'the retry path must still measure range when it can sample');
  assert.ok(env.sampleCalls.count > 0, 'and must still attempt the sample');
});

test('capability arriving late re-opens a spent budget without camera motion', async (t) => {
  // WebGL context restore / a tileset that only becomes sampleable later. A
  // parked camera has no moveEnd to re-open the budget, so the false→true edge
  // must do it — otherwise the layer stays permanently given-up.
  const env = await createRealLocalLayerHarness({ sampleHeightSupported: true });
  _resetRenderGovernorForTest();
  const governorScene = { renders: 0, requestRender() { this.renders += 1; } };
  installRenderGovernor({ scene: governorScene });
  governorScene.renders = 0;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const clock = installFakeClock(t);
  t.after(() => {
    env.layer.destroy(env.viewer);
    env.cleanup();
    _resetRenderGovernorForTest();
  });

  setCameraAltitude(env, 20_000);
  runArmedRetryChain(env, t, clock, GROUND_SAMPLE_MAX_ARMED_RETRIES + 2);
  assert.equal(governorScene.renders, GROUND_SAMPLE_MAX_ARMED_RETRIES, 'budget spent');

  // Context lost, then restored — with the camera never touched.
  env.viewer.scene.sampleHeightSupported = false;
  runArmedRetryChain(env, t, clock, 2);
  assert.equal(governorScene.renders, GROUND_SAMPLE_MAX_ARMED_RETRIES, 'no arming while unsupported');

  env.viewer.scene.sampleHeightSupported = true;
  runArmedRetryChain(env, t, clock, 3);
  assert.equal(
    governorScene.renders,
    GROUND_SAMPLE_MAX_ARMED_RETRIES + 3,
    'the false→true edge must re-open the budget on a parked camera',
  );
});

test('a sampleable scene that keeps failing gives up after a bounded run of arms', async (t) => {
  // Supported, but nothing under the feature is sampleable: every retry fails.
  const env = await createRealLocalLayerHarness({ sampleHeightSupported: true });
  _resetRenderGovernorForTest();
  const governorScene = { renders: 0, requestRender() { this.renders += 1; } };
  installRenderGovernor({ scene: governorScene });
  governorScene.renders = 0; // discard the governor's own install settling frame
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const clock = installFakeClock(t);
  t.after(() => {
    env.layer.destroy(env.viewer);
    env.cleanup();
    _resetRenderGovernorForTest();
  });

  setCameraAltitude(env, 20_000);
  runArmedRetryChain(env, t, clock, GROUND_SAMPLE_MAX_ARMED_RETRIES);
  assert.equal(
    governorScene.renders,
    GROUND_SAMPLE_MAX_ARMED_RETRIES,
    'the chain must run its full budget before giving up',
  );

  // Budget spent: further parked frames retry the sample (free) but ask for
  // nothing more — the idle governor is allowed to sleep.
  runArmedRetryChain(env, t, clock, 10);
  assert.equal(
    governorScene.renders,
    GROUND_SAMPLE_MAX_ARMED_RETRIES,
    'past the cap the layer must stop arming instead of re-arming forever',
  );
});

test('after the cap a camera-motion frame still samples, and re-opens the budget', async (t) => {
  const env = await createRealLocalLayerHarness({ sampleHeightSupported: true });
  _resetRenderGovernorForTest();
  const governorScene = { renders: 0, requestRender() { this.renders += 1; } };
  installRenderGovernor({ scene: governorScene });
  governorScene.renders = 0; // discard the governor's own install settling frame
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const clock = installFakeClock(t);
  t.after(() => {
    env.layer.destroy(env.viewer);
    env.cleanup();
    _resetRenderGovernorForTest();
  });

  setCameraAltitude(env, 20_000);
  runArmedRetryChain(env, t, clock, GROUND_SAMPLE_MAX_ARMED_RETRIES + 3);
  assert.equal(governorScene.renders, GROUND_SAMPLE_MAX_ARMED_RETRIES, 'budget spent');
  assert.equal(baseHeightM(env), 0, 'still ungrounded while the tiles were missing');

  // The tiles finally arrive. Camera-motion frames are free (the user is
  // already paying for them), so the walk they trigger must still sample.
  env.setSampleHeight(() => 210);
  setCameraAltitude(env, 19_000);
  env.moveEnd.raise();
  clock.advance(2_100);
  env.preRender.raise();

  assert.ok(
    Math.abs(baseHeightM(env) - 210) < 1e-6,
    `the motion frame must ground the stem; base height ${baseHeightM(env)}`,
  );

  // Grounded, so there is nothing left to arm: no new frame requests either.
  runArmedRetryChain(env, t, clock, 5);
  assert.equal(
    governorScene.renders,
    GROUND_SAMPLE_MAX_ARMED_RETRIES,
    'a grounded record asks for no further frames',
  );
});

// ── Globe-LOD: bound the active-stem set by camera height ────────────────────
//
// createLocalGeoJsonLayer used to give every feature a live stem and walk all
// of them (geometry trig + Cesium property writes) on every camera move. With
// three bundled-infra layers that is ~5,700 records on a full-earth view — the
// frame-rate cliff that got the INFRASTRUCTURE first-run tile cut. The walk
// now asks src/data/localGeojsonLod.js which records may carry a stem, sized to
// the camera-height budget, and skips all per-frame cost for the rest.

/**
 * Harness with N in-view point features and a controllable camera height.
 * Even-indexed features are named (high label priority), odd ones anonymous.
 */
async function createMultiFeatureLodHarness({ featureCount = 150, cameraHeightM = 9_000_000 } = {}) {
  const originalFetch = globalThis.fetch;
  const originalWindow = globalThis.window;
  const preRender = new MockLayerEvent();
  const moveEnd = new MockLayerEvent();
  const dataSources = [];
  const centerLon = -97.7;
  const centerLat = 30.2;
  // Polygons, not Points: Cesium's GeoJsonDataSource builds a PinBuilder
  // billboard for a Point, which needs a DOM canvas the node test env lacks.
  // The layer takes the polygon's bounding-sphere centre as the stem anchor.
  const lines = Array.from({ length: featureCount }, (_, i) => {
    const lon = centerLon + (i % 12) * 0.02;
    const lat = centerLat + Math.floor(i / 12) * 0.02;
    return JSON.stringify({
      type: 'Feature',
      id: `dc-${i}`,
      properties: i % 2 === 0
        ? { name: `Datacenter ${i}`, tags: { name: `Datacenter ${i}`, operator: 'Example Cloud' } }
        : { tags: {} },
      geometry: {
        type: 'Polygon',
        coordinates: [[
          [lon, lat],
          [lon + 0.004, lat],
          [lon + 0.004, lat + 0.004],
          [lon, lat],
        ]],
      },
    });
  });
  globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => lines.join('\n') });
  globalThis.window = { dispatchEvent() {} };

  const setPos = (m) => {
    const p = Cesium.Cartesian3.fromDegrees(centerLon, centerLat, m);
    viewer.camera.positionWC = p;
    viewer.camera.positionCartographic = Cesium.Cartographic.fromCartesian(p);
  };
  const viewer = {
    selectedEntity: undefined,
    dataSources: {
      add(ds) { dataSources.push(ds); return ds; },
      remove(ds) {
        const i = dataSources.indexOf(ds);
        if (i >= 0) dataSources.splice(i, 1);
        return i >= 0;
      },
    },
    camera: {
      positionWC: null,
      positionCartographic: null,
      frustum: { fov: Math.PI / 3 },
      moveEnd,
      flyTo() {},
    },
    scene: {
      canvas: { clientWidth: 1440, clientHeight: 900 },
      preRender,
      sampleHeightSupported: false,
      screenSpaceCameraController: { enableInputs: true },
      pick() { return null; },
      requestRender() {},
    },
  };
  setPos(cameraHeightM);
  const layer = createLocalGeoJsonLayer({
    id: 'local-datacenters',
    url: '/lod-fixture.geojsonl',
    name: 'LOD Datacenters',
    color: '#00ffff',
    overlayHost: { setVisible() {}, setEntries() {}, clearSource() {} },
    projectToWindow: () => ({ x: 700, y: 450 }),
    screenSpaceEventHandlerFactory: () => ({ setInputAction() {}, destroy() {} }),
  });
  try {
    await layer.enable(viewer);
  } finally {
    globalThis.fetch = originalFetch;
  }
  return {
    layer,
    viewer,
    dataSources,
    preRender,
    moveEnd,
    setCameraHeight: setPos,
    shownCount() {
      return dataSources[0].entities.values.filter((entity) => entity.show === true).length;
    },
    cleanup() {
      if (originalWindow === undefined) delete globalThis.window;
      else globalThis.window = originalWindow;
    },
  };
}

test('globe-LOD caps live stems at the camera-height budget and widens as you zoom in', async (t) => {
  const env = await createMultiFeatureLodHarness({ featureCount: 150, cameraHeightM: 9_000_000 });
  const clock = installFakeClock(t);
  t.after(() => {
    env.layer.destroy(env.viewer);
    env.cleanup();
  });

  // Full-earth framing: 150 in-view features, but the global band allows 80.
  env.preRender.raise();
  assert.equal(env.dataSources[0].entities.values.length, 150, 'all features are materialized');
  assert.equal(env.shownCount(), INFRA_LOD_ACTIVE_MIN, 'only the global-band budget carries a stem');

  // Named features (label priority ~1240) outrank anonymous nodes (~60), so
  // every one of the 75 named features keeps a stem; the 5 remaining budget
  // slots go to unnamed ones.
  const shownIds = new Set(
    env.dataSources[0].entities.values.filter((entity) => entity.show === true).map((entity) => entity.id),
  );
  const namedIds = Array.from({ length: 150 }, (_, i) => i).filter((i) => i % 2 === 0).map((i) => `dc-${i}`);
  assert.ok(namedIds.every((id) => shownIds.has(id)), 'every named feature wins a stem before any unnamed one');

  // Zoom to continental framing: the budget opens to MID (200), so all 150
  // in-view features now get a stem.
  env.setCameraHeight(1_000_000);
  env.moveEnd.raise();
  clock.advance(500); // clear the 450 ms visibility gate
  env.preRender.raise();
  assert.equal(env.shownCount(), 150, 'a closer camera lifts the cap above the in-view count');
});

test('globe-LOD selection is stable between camera moves (no per-frame churn)', async (t) => {
  const env = await createMultiFeatureLodHarness({ featureCount: 150, cameraHeightM: 9_000_000 });
  const clock = installFakeClock(t);
  t.after(() => {
    env.layer.destroy(env.viewer);
    env.cleanup();
  });

  env.preRender.raise();
  const firstSet = env.dataSources[0].entities.values
    .filter((entity) => entity.show === true)
    .map((entity) => entity.id)
    .sort();
  assert.equal(firstSet.length, INFRA_LOD_ACTIVE_MIN);

  // A second walk with no intervening moveEnd must not re-select.
  clock.advance(500);
  env.preRender.raise();
  const secondSet = env.dataSources[0].entities.values
    .filter((entity) => entity.show === true)
    .map((entity) => entity.id)
    .sort();
  assert.deepEqual(secondSet, firstSet, 'the active set only changes on camera moves');
});

test('getLodDiagnostics reports the active/total split and the band budget', async (t) => {
  const env = await createMultiFeatureLodHarness({ featureCount: 150, cameraHeightM: 9_000_000 });
  const clock = installFakeClock(t);
  t.after(() => {
    env.layer.destroy(env.viewer);
    env.cleanup();
  });

  assert.deepEqual(env.layer.getLodDiagnostics(), {
    total: 150, active: 0, budgetLimit: 0, computed: false,
  }, 'before the first walk: materialized but not yet selected');

  env.preRender.raise();
  const global = env.layer.getLodDiagnostics();
  assert.equal(global.total, 150);
  assert.equal(global.active, INFRA_LOD_ACTIVE_MIN);
  assert.equal(global.budgetLimit, INFRA_LOD_ACTIVE_MIN);
  assert.equal(global.computed, true);
  assert.ok(global.active < global.total, 'active < total means the declutter is engaged');

  env.setCameraHeight(60_000);
  env.moveEnd.raise();
  clock.advance(500);
  env.preRender.raise();
  const regional = env.layer.getLodDiagnostics();
  assert.equal(regional.active, 150, 'regional band lifts the cap above the in-view count');
  assert.ok(regional.budgetLimit >= 150, `regional budget widened (${regional.budgetLimit})`);
});

test('globe-LOD releases every stem when the layer is disabled', async (t) => {
  const env = await createMultiFeatureLodHarness({ featureCount: 40, cameraHeightM: 9_000_000 });
  t.after(() => {
    env.layer.destroy(env.viewer);
    env.cleanup();
  });

  env.preRender.raise();
  assert.equal(env.shownCount(), 40, 'under-budget: all 40 show');

  env.layer.disable(env.viewer);
  // The data source is hidden wholesale on disable; re-enabling starts from a
  // fresh (empty) LOD selection rather than inheriting the old active set.
  await env.layer.enable(env.viewer);
  env.preRender.raise();
  assert.equal(env.shownCount(), 40, 're-enable rebuilds the selection cleanly');
});

test('globe-LOD re-selects during continuous motion, without ever seeing a moveEnd', async (t) => {
  // A tracked-entity follow, Cockpit view, route flight, or continuous orbit
  // moves the camera indefinitely without emitting moveEnd. Before the motion
  // fallback the active set stayed pinned to the region the camera left, and
  // the walk hid those records as they passed behind the globe while admitting
  // nothing newly visible — the layer bled down to sparse-or-empty until the
  // motion stopped.
  const env = await createMultiFeatureLodHarness({ featureCount: 150, cameraHeightM: 9_000_000 });
  const clock = installFakeClock(t);
  t.after(() => {
    env.layer.destroy(env.viewer);
    env.cleanup();
  });

  env.preRender.raise();
  assert.equal(env.layer.getLodDiagnostics().budgetLimit, INFRA_LOD_ACTIVE_MIN);
  assert.equal(env.shownCount(), INFRA_LOD_ACTIVE_MIN, 'global band caps the first selection');

  // The camera travels; NO moveEnd is raised, here or anywhere below.
  env.setCameraHeight(60_000);

  // Inside the probe window the selection deliberately stays put: the fallback
  // is rate-limited so continuous motion cannot recompute on every walk.
  clock.advance(500); // > the 450 ms visibility gate, < the 1 s probe window
  env.preRender.raise();
  assert.equal(env.layer.getLodDiagnostics().budgetLimit, INFRA_LOD_ACTIVE_MIN,
    'the probe window rate-limits the recompute');

  // Past the window, the travelled camera re-selects on its own.
  clock.advance(600);
  env.preRender.raise();
  const moved = env.layer.getLodDiagnostics();
  assert.equal(moved.budgetLimit, INFRA_LOD_ACTIVE_MAX, 'the new camera height re-banded the budget');
  assert.equal(moved.active, 150, 'every in-view record is admitted again');
  assert.equal(env.shownCount(), 150, 'and actually carries a stem');

  // A parked camera past the same window costs nothing: travel is measured
  // from the last selection, so there is none to report.
  const parked = env.layer.getLodDiagnostics();
  clock.advance(2_000);
  env.preRender.raise();
  assert.deepEqual(env.layer.getLodDiagnostics(), parked, 'a parked camera never re-selects');
});
