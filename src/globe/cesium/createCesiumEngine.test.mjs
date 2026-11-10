import { installDomClasses } from '../../testSupport/domClasses.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { assertGlobeEngine, engineCapabilities } from '../contract.js';
import { createContractSuite } from '../testing/contractSuite.mjs';
import { createCesiumEngine } from './createCesiumEngine.js';
import { createCameraViewer } from './testing/cameraViewer.mjs';
import {
  createFakeEventHandlers,
  createFakeViewer,
} from './testing/fakeViewer.mjs';

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

test('the engine draws the visual styles, bloom and contact sonar, not the cloud cover', () => {
  const viewer = createFakeViewer();
  const engine = createCesiumEngine(viewer);
  assert.deepEqual(engineCapabilities(engine), {
    tileErrors: true,
    visualStyles: true,
    bloom: true,
    cloudCover: false,
    contactSonar: true,
  });
  assert.equal(engine.contactSonarDiagnostics().contacts, 0);
  engine.destroy();
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
  assert.equal(viewer.scene.requestRenderMode, true);
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
    clock: { onTick: new Cesium.Event() },
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
  assert.equal(viewer.clock.onTick.numberOfListeners, 1);
  wall += 16;
  viewer.clock.onTick.raiseEvent(viewer.clock);
  wall += 5;
  assert.equal(engine.clock.frameTime(), 1_000_016);
  engine.destroy();
  assert.equal(viewer.clock.onTick.numberOfListeners, 0);
});

// The Cesium collections under the engine's root collections.
function collectionsUnder(viewer) {
  return viewer.primitiveList.flatMap((root) =>
    Array.from({ length: root.length }, (_, index) => root.get(index)),
  );
}

test('the contract suite movers and lines checks pass on the Cesium engine (no pixels or pointer)', async (t) => {
  // Cesium's Material sorts uniform values with instanceof checks against
  // these DOM classes; Node has none of them.
  installDomClasses();
  const handlers = createFakeEventHandlers();
  const { scene, engine, frame } = createCameraViewer({
    engineOptions: {
      createEventHandler: handlers.create,
      // The atlas crop needs a DOM, the glTF load the network.
      moverFactories: {
        cropCells: async (atlas, keys) =>
          new Map(keys.map((key) => [key, { width: 16, height: 16 }])),
        loadModel: async () => ({
          ready: true,
          modelMatrix: new Cesium.Matrix4(),
          isDestroyed: () => false,
          destroy() {},
        }),
      },
    },
  });
  // The terrain under the surface check's sample.
  scene.globe.getHeight = () => 12;
  const checks = createContractSuite(engine, {
    waitFrames: async (count) => {
      for (let index = 0; index < count; index++) frame();
    },
  }).filter(({ name }) =>
    /^(kind|movers|lines|input\.on: picks|surface\.sampleHeightDetailed)\b/.test(
      name,
    ),
  );
  assert.equal(checks.length, 10);
  try {
    for (const { name, run } of checks) await t.test(name, run);
  } finally {
    engine.destroy();
  }
  assert.equal(scene.primitives.length, 0, 'no collection left behind');
});

test('the camera, clock and failed model suite checks pass on the Cesium adapter', async (t) => {
  const { createAppClock } = await import('../../time/clock.js');
  let wall = 1_000_000;
  // The failed-model check turns the model's load failure on and off.
  let modelFails = false;
  const { viewer, camera, engine, frame } = createCameraViewer({
    engineOptions: {
      createEventHandler: createFakeEventHandlers().create,
      appClock: createAppClock({ now: () => wall }),
      moverFactories: {
        loadModel: async () => {
          if (modelFails) throw new Error('Model unavailable');
          return {
            ready: true,
            modelMatrix: new Cesium.Matrix4(),
            isDestroyed: () => false,
            destroy() {},
          };
        },
      },
    },
  });
  viewer.entities = new Cesium.EntityCollection();
  const checks = createContractSuite(engine, {
    fixtures: {
      failModel(id, fails) {
        modelFails = fails;
      },
    },
    waitFrames: async (count) => {
      for (let i = 0; i < count; i++) {
        wall += 16;
        camera.update(Cesium.SceneMode.SCENE3D);
        camera._updateCameraChanged();
        frame();
      }
    },
  }).filter(({ name }) =>
    /^(camera.changed: a pure|camera.following:|clock.frameTime:|movers.createSet: failed model)/.test(
      name,
    ),
  );
  assert.equal(checks.length, 6);
  try {
    for (const { name, run } of checks) await t.test(name, run);
  } finally {
    engine.destroy();
  }
});
