import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { assertGlobeEngine } from '../contract.js';
import {
  _resetRenderGovernorForTest,
  getRenderGovernorDiagnostics,
  installRenderGovernor,
} from '../../renderGovernor.js';
import { createCesiumEngine } from './createCesiumEngine.js';
import {
  createFakeEventHandlers,
  createFakeViewer,
} from './testing/fakeViewer.mjs';

test.afterEach(() => _resetRenderGovernorForTest());

function snapshot(viewer) {
  const { scene } = viewer;
  return {
    requestRenderMode: scene.requestRenderMode,
    maximumRenderTimeChange: scene.maximumRenderTimeChange,
    globeShow: scene.globe.show,
    enableInputs: scene.screenSpaceCameraController.enableInputs,
    percentageChanged: scene.camera.percentageChanged,
    listeners: [
      scene.camera.changed,
      scene.camera.moveStart,
      scene.camera.moveEnd,
      scene.preUpdate,
      scene.preRender,
      scene.postRender,
    ].map((event) => event.numberOfListeners),
  };
}

test('the engine satisfies the contract shape and changes nothing at creation', () => {
  const viewer = createFakeViewer({ width: 800, height: 600 });
  const handlers = createFakeEventHandlers();
  const before = snapshot(viewer);
  const engine = createCesiumEngine(viewer, {
    createEventHandler: handlers.create,
  });
  assertGlobeEngine(engine);
  assert.equal(engine.kind, 'cesium');
  assert.deepEqual(viewer.calls, []);
  assert.deepEqual(snapshot(viewer), before);
  assert.equal(handlers.handlers.length, 0);
  assert.equal(engine.host.container, viewer.container);
  assert.equal(engine.host.canvas, viewer.scene.canvas);
  assert.deepEqual(engine.host.size(), { width: 800, height: 600 });
  viewer.scene.canvas.clientWidth = 640;
  assert.deepEqual(engine.host.size(), { width: 640, height: 600 });
});

test('the render option reaches render.request', () => {
  const viewer = createFakeViewer();
  const reasons = [];
  const engine = createCesiumEngine(viewer, {
    requestRender: (reason) => reasons.push(reason),
  });
  engine.render.request();
  assert.equal(reasons.length, 1);
});

test('destroy releases holds, listeners, handlers and engine-owned map state', async () => {
  const viewer = createFakeViewer();
  installRenderGovernor(viewer);
  const handlers = createFakeEventHandlers();
  const engine = createCesiumEngine(viewer, {
    createEventHandler: handlers.create,
    createImageryLayer: (provider) => ({ provider }),
  });
  engine.camera.changed.addEventListener(() => {});
  engine.frames.postRender.addEventListener(() => {});
  engine.input.on('click', () => {});
  engine.render.setContinuous(true);
  engine.credits.addStatic('credit');
  await engine.maps.setBaseImagery({ kind: 'osm' });
  assert.equal(engine.isDestroyed(), false);
  engine.destroy();
  engine.destroy();
  assert.equal(engine.isDestroyed(), true);
  assert.equal(viewer.scene.camera.changed.numberOfListeners, 0);
  assert.equal(viewer.scene.postRender.numberOfListeners, 0);
  assert.equal(handlers.handlers[0].destroyed, true);
  assert.deepEqual(getRenderGovernorDiagnostics().holds, []);
  assert.deepEqual(viewer.staticCredits, []);
  assert.deepEqual(viewer.imageryList, []);
});

test('the engine reads the Viewer aliases and builds on a minimal viewer', () => {
  // Viewer.camera/.canvas are the scene's; a viewer-shaped object that offers
  // only the aliases, a container and a remover-returning postRender works.
  const listeners = new Set();
  const postRender = {
    addEventListener(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
  let renders = 0;
  const viewer = {
    container: { kind: 'container' },
    canvas: { clientWidth: 320, clientHeight: 200 },
    camera: {
      positionWC: new Cesium.Cartesian3(7e6, 0, 0),
      positionCartographic: { height: 621863 },
      viewMatrix: Cesium.Matrix4.clone(Cesium.Matrix4.IDENTITY),
      frustum: {
        projectionMatrix: Cesium.Matrix4.clone(Cesium.Matrix4.IDENTITY),
      },
    },
    scene: { postRender, requestRender: () => renders++ },
  };
  const engine = createCesiumEngine(viewer);
  assert.equal(engine.host.canvas, viewer.canvas);
  assert.deepEqual(engine.host.size(), { width: 320, height: 200 });
  assert.equal(engine.camera.height(), 621863);
  assert.deepEqual(
    engine.projector.viewProjection(),
    Cesium.Matrix4.toArray(Cesium.Matrix4.IDENTITY),
  );
  assert.equal(
    engine.projector.horizonVisible({ x: 6378137, y: 0, z: 0 }),
    true,
  );
  const seen = [];
  const off = engine.frames.postRender.addEventListener((time) =>
    seen.push(time),
  );
  assert.equal(listeners.size, 1);
  for (const listener of listeners) listener();
  assert.equal(seen.length, 1);
  off();
  assert.equal(listeners.size, 0);
  engine.render.request();
  assert.equal(renders, 1);
  engine.destroy();
});

test('the engine clock is the app clock given, latched on the viewer clock tick', async () => {
  const { createAppClock } = await import('../../time/clock.js');
  let wall = 1_000_000;
  const appClock = createAppClock({ now: () => wall });
  const viewer = createFakeViewer();
  const engine = createCesiumEngine(viewer, { appClock });
  assert.equal(engine.clock.now(), 1_000_000);
  const seen = [];
  engine.clock.ticked.addEventListener((time) => seen.push(time));
  assert.equal(viewer.clock.onTick.numberOfListeners, 1);
  wall += 16;
  viewer.clock.onTick.raiseEvent(viewer.clock);
  assert.deepEqual(seen, [1_000_016]);
  assert.equal(engine.clock.frameTime(), 1_000_016);
  engine.destroy();
  assert.equal(viewer.clock.onTick.numberOfListeners, 0);
});

test('picks leave out mover instances behind the horizon and the follow proxy', async () => {
  const geo = await import('../../geo/index.js');
  const viewer = createFakeViewer();
  const engine = createCesiumEngine(viewer, { requestRender: () => {} });
  try {
    const set = engine.movers.createSet({
      id: 'horizon-points',
      pickable: true,
      kind: 'point',
      capacity: 2,
      point: { sizePx: 8 },
    });
    // The fake camera is at x = 7e6 (over 0°, 0°): 0°E is in front, 180° behind.
    set.set(0, { position: geo.cartesian3.fromDegrees(0, 1, 0) });
    set.set(1, { position: geo.cartesian3.fromDegrees(180, 1, 0) });
    set.setCount(2);
    set.commit();
    const [front, back] = viewer.primitiveList.flatMap((root) =>
      collectPoints(root),
    );
    viewer.scene.drillPick = () => [
      { primitive: back, id: 'back' },
      { primitive: front, id: 'front' },
    ];
    assert.deepEqual(
      engine.picker.drillPick({ x: 1, y: 1 }).map(({ id }) => id),
      ['front'],
    );
  } finally {
    engine.destroy();
  }
});

// The PointPrimitives under a primitive collection tree.
function collectPoints(collection) {
  const out = [];
  for (let i = 0; i < (collection.length ?? 0); i++) {
    const item = collection.get(i);
    if (item instanceof Cesium.PointPrimitive) out.push(item);
    else if (item?.length !== undefined) out.push(...collectPoints(item));
  }
  return out;
}
