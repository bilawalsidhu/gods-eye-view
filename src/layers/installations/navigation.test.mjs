import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { createViewport } from './viewport.js';
import { createLifecycle } from './lifecycle.js';

test('camera changes debounce, deduplicate moveEnd, cancel superseded loads and recover from wide views', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let rectangle = Cesium.Rectangle.fromDegrees(-117.2, 32.7, -117.1, 32.8);
  const camera = {
    changed: new Cesium.Event(),
    moveEnd: new Cesium.Event(),
    percentageChanged: 0.5,
    computeViewRectangle: () => rectangle,
  };
  const viewer = {
    camera,
    scene: { globe: { ellipsoid: Cesium.Ellipsoid.WGS84 } },
    dataSources: { add() {}, remove() {} },
  };
  const state = { enabled: false, renderedKeys: new Map() };
  const loads = [];
  const parts = {
    selection: { installInteraction() {} },
    rendering: { clearRendered() {} },
    ingestion: {
      loadInstallations() {
        state.abort = new AbortController();
        loads.push({
          ...parts.viewport.loadArea(viewer),
          signal: state.abort.signal,
        });
      },
      setInstallationStatus() {},
    },
  };
  const services = {
    picking: { registerPickOwner() {}, unregisterPickOwner() {} },
    context: { clearSelectedEntityContextForLayer() {} },
  };
  const ctx = { state, parts, services, source: {} };
  parts.viewport = createViewport(ctx);
  const life = createLifecycle(ctx).methods;
  life.init(viewer);
  life.enable();
  for (let i = 0; i < 8; i++) {
    camera.changed.raiseEvent();
    t.mock.timers.tick(15);
  }
  t.mock.timers.tick(200);
  assert.equal(
    loads.length,
    1,
    'changed alone must load, even without moveEnd',
  );
  camera.moveEnd.raiseEvent();
  t.mock.timers.tick(200);
  assert.equal(loads.length, 1);
  assert.equal(
    loads[0].signal.aborted,
    false,
    'duplicate settle must not abort its own load',
  );
  rectangle = Cesium.Rectangle.fromDegrees(-117.5, 33.2, -117.3, 33.4);
  camera.changed.raiseEvent();
  assert.equal(loads[0].signal.aborted, true);
  t.mock.timers.tick(200);
  assert.equal(loads.length, 2);
  rectangle = Cesium.Rectangle.fromDegrees(-150, 10, -80, 60);
  camera.moveEnd.raiseEvent();
  t.mock.timers.tick(200);
  assert.equal(
    loads.at(-1).box.west,
    -150,
    'wide views reach the named-point source',
  );
  rectangle = Cesium.Rectangle.fromDegrees(-117.2, 32.7, -117.1, 32.8);
  camera.changed.raiseEvent();
  t.mock.timers.tick(200);
  assert.ok(loads.at(-1).box);
  state.contextAnchor = { latitude: 32.8, longitude: -117.1 };
  const count = loads.length;
  camera.moveEnd.raiseEvent();
  t.mock.timers.tick(200);
  assert.equal(loads.length, count, 'Contacts owns the anchor while active');
  life.disable();
  assert.equal(state.contextAnchor, null);
  life.enable();
  rectangle = Cesium.Rectangle.fromDegrees(-117.5, 33.2, -117.3, 33.4);
  camera.changed.raiseEvent();
  t.mock.timers.tick(200);
  assert.equal(loads.at(-1).coverage.kind, 'viewport');
  life.destroy(viewer);
  assert.equal(camera.changed.numberOfListeners, 0);
  assert.equal(camera.moveEnd.numberOfListeners, 0);
  assert.equal(camera.percentageChanged, 0.5);
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
