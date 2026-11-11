import { createFakeEngine } from '../../globe/testing/fakeEngine.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { createViewport } from './viewport.js';
import { createDisplayHarness } from './render/displayHarness.mjs';
import { createFakeGroundHarness } from '../../testSupport/groundDisplayEngines.mjs';

test('camera changes debounce, deduplicate moveEnd, cancel superseded loads and recover from wide views', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let rectangle = Cesium.Rectangle.fromDegrees(-117.2, 32.7, -117.1, 32.8);
  const h = createDisplayHarness(createFakeGroundHarness);
  const { engine, state, parts } = h;
  engine.fake.script('viewRectangle', () => rectangle);
  const camera = engine.camera;
  const base = {
    changed: camera.changed.numberOfListeners,
    moveEnd: camera.moveEnd.numberOfListeners,
    sensitivity: camera.percentageChanged,
  };
  const changed = () => engine.fake.emit('camera.changed');
  const moveEnd = () => engine.fake.emit('camera.moveEnd');
  const loads = [];
  parts.ingestion = {
    loadInstallations() {
      state.abort = new AbortController();
      loads.push({
        ...parts.viewport.loadArea(null),
        signal: state.abort.signal,
      });
    },
    setInstallationStatus() {},
  };
  parts.viewport = createViewport({
    state,
    parts,
    services: h.services,
    source: {},
  });
  const life = parts.display;
  life.init();
  life.enable();
  assert.equal(
    camera.percentageChanged,
    0.01,
    'the layer claims a fine camera',
  );
  for (let i = 0; i < 8; i++) {
    changed();
    t.mock.timers.tick(15);
  }
  t.mock.timers.tick(200);
  assert.equal(
    loads.length,
    1,
    'changed alone must load, even without moveEnd',
  );
  moveEnd();
  t.mock.timers.tick(200);
  assert.equal(loads.length, 1);
  assert.equal(
    loads[0].signal.aborted,
    false,
    'duplicate settle must not abort its own load',
  );
  rectangle = Cesium.Rectangle.fromDegrees(-117.5, 33.2, -117.3, 33.4);
  changed();
  assert.equal(loads[0].signal.aborted, true);
  t.mock.timers.tick(200);
  assert.equal(loads.length, 2);
  rectangle = Cesium.Rectangle.fromDegrees(-150, 10, -80, 60);
  moveEnd();
  t.mock.timers.tick(200);
  assert.equal(
    loads.at(-1).box.west,
    -150,
    'wide views reach the named-point source',
  );
  rectangle = Cesium.Rectangle.fromDegrees(-117.2, 32.7, -117.1, 32.8);
  changed();
  t.mock.timers.tick(200);
  assert.ok(loads.at(-1).box);
  state.contextAnchor = { latitude: 32.8, longitude: -117.1 };
  const count = loads.length;
  moveEnd();
  t.mock.timers.tick(200);
  assert.equal(loads.length, count, 'Contacts owns the anchor while active');
  life.disable();
  assert.equal(state.contextAnchor, null);
  life.enable();
  rectangle = Cesium.Rectangle.fromDegrees(-117.5, 33.2, -117.3, 33.4);
  changed();
  t.mock.timers.tick(200);
  assert.equal(loads.at(-1).coverage.kind, 'viewport');
  h.destroy();
  assert.equal(camera.changed.numberOfListeners, base.changed);
  assert.equal(camera.moveEnd.numberOfListeners, base.moveEnd);
  assert.equal(camera.percentageChanged, base.sensitivity);
});

test('an aborting real ingestion cannot clear the next scheduled view key', async (t) => {
  const { createIngestion } = await import('./ingestion.js');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let rectangle = Cesium.Rectangle.fromDegrees(-117.2, 32.7, -117.1, 32.8);
  const viewer = {
    camera: { computeViewRectangle: () => rectangle },
    scene: { globe: { ellipsoid: Cesium.Ellipsoid.WGS84 } },
  };
  const state = { enabled: true, viewer };
  const pending = [];
  const parts = {
    rendering: { renderRecords() {}, warmInstallationFloors() {} },
    model: { installationWithinViewport: () => true },
  };
  const ctx = {
    state,
    parts,
    services: {
      render: { governorRequestRender() {} },
      ground: { resolveGroundFloorCellsBounded: async () => {} },
    },
    source: {
      getMappedSites(box, { signal }) {
        return new Promise((resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), {
            once: true,
          });
          pending.push({ box, signal, resolve });
        });
      },
    },
  };
  parts.viewport = createViewport(ctx);
  parts.ingestion = createIngestion(ctx);
  const flush = async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  };
  parts.viewport.scheduleLoad();
  t.mock.timers.tick(200);
  assert.equal(pending.length, 1);
  rectangle = Cesium.Rectangle.fromDegrees(-117.5, 33.2, -117.3, 33.4);
  parts.viewport.scheduleLoad();
  const nextKey = state.cameraLoadKey;
  assert.equal(pending[0].signal.aborted, true);
  await flush();
  assert.equal(
    state.cameraLoadKey,
    nextKey,
    'A finally must not clear B schedule ownership',
  );
  t.mock.timers.tick(200);
  assert.equal(pending.length, 2);
  parts.viewport.scheduleLoad();
  t.mock.timers.tick(600);
  assert.equal(pending.length, 2);
  assert.equal(pending[1].signal.aborted, false);
  pending[1].resolve({ records: [], status: 'ready' });
  await flush();
  assert.equal(state.loading, false);
  assert.equal(state.cameraLoadKey, nextKey);
});

test('Navara installation ingestion loads from its engine camera without a viewer', async () => {
  const { createIngestion } = await import('./ingestion.js');
  const rectangle = Cesium.Rectangle.fromDegrees(-123, 37, -122, 38);
  const engine = createFakeEngine({ kind: 'navara' });
  engine.fake.script('viewRectangle', () => rectangle);
  const state = {
    enabled: true,
    viewer: null,
    engine: engine,
    records: [],
    recordById: new Map(),
    coverage: { kind: 'viewport' },
  };
  const requests = [];
  const parts = {
    model: { installationWithinViewport: () => true },
    rendering: { renderRecords() {}, warmInstallationFloors() {} },
    namedMarkers: { sync() {} },
  };
  const context = {
    state,
    parts,
    services: {
      render: { governorRequestRender() {} },
      ground: { resolveGroundFloorCellsBounded: async () => {} },
    },
    source: {
      async getMappedSites(box) {
        requests.push(box);
        return { records: [], status: 'ready', wide: false, saturated: false };
      },
    },
  };
  parts.viewport = createViewport(context);
  const ingestion = createIngestion(context);

  await ingestion.loadInstallations();

  assert.equal(requests.length, 1);
  assert.ok(Math.abs(requests[0].west + 123) < 1e-10);
  assert.ok(Math.abs(requests[0].south - 37) < 1e-10);
  assert.equal(state.loading, false);
  assert.ok(state.lastUpdate);
});

test('wide views refresh screen decluttering when the globe rectangle stays unchanged', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const camera = {
    positionWC: new Cesium.Cartesian3(10000000, 0, 0),
    directionWC: new Cesium.Cartesian3(-1, 0, 0),
    computeViewRectangle: () => Cesium.Rectangle.MAX_VALUE,
  };
  const state = {
    enabled: true,
    viewer: { camera, scene: { globe: { ellipsoid: Cesium.Ellipsoid.WGS84 } } },
  };
  let loads = 0;
  const parts = {
    ingestion: {
      loadInstallations() {
        loads++;
      },
    },
  };
  const viewport = createViewport({ state, parts, services: {}, source: {} });
  viewport.scheduleLoad();
  t.mock.timers.tick(200);
  viewport.scheduleLoad();
  t.mock.timers.tick(200);
  assert.equal(loads, 1, 'the same settled camera remains deduplicated');
  camera.positionWC = new Cesium.Cartesian3(0, 10000000, 0);
  camera.directionWC = new Cesium.Cartesian3(0, -1, 0);
  viewport.scheduleLoad();
  t.mock.timers.tick(200);
  assert.equal(loads, 2, 'a different continent needs fresh projected labels');
});

test('the engine camera drives installation viewport requests without a viewer', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const rectangle = {
    west: Cesium.Math.toRadians(179),
    south: Cesium.Math.toRadians(-12),
    east: Cesium.Math.toRadians(-178),
    north: Cesium.Math.toRadians(16),
  };
  const engine = createFakeEngine();
  engine.fake.script('viewRectangle', () => rectangle);
  engine.camera.pose = () => ({
    position: { x: 1, y: 2, z: 3 },
    direction: { x: -1, y: 0, z: 0 },
  });
  const state = {
    enabled: true,
    viewer: null,
    engine: engine,
  };
  const loads = [];
  const parts = {
    ingestion: {
      loadInstallations() {
        loads.push(parts.viewport.loadArea(null));
      },
    },
  };
  parts.viewport = createViewport({ state, parts, services: {}, source: {} });

  parts.viewport.scheduleLoad();
  t.mock.timers.tick(200);

  assert.equal(loads.length, 1);
  assert.ok(Math.abs(loads[0].box.south + 12) < 1e-10);
  assert.equal(loads[0].box.west, 179);
  assert.equal(loads[0].box.north, 16);
  assert.equal(loads[0].box.east, -178);
  assert.equal(loads[0].coverage.kind, 'viewport');
});
