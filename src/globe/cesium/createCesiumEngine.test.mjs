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
    visualStyles: true,
    bloom: true,
    cloudCover: false,
    contactSonar: true,
    movers: true,
    lines: true,
    ground: true,
    imagery: true,
    meshes: true,
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

test('movers and lines draw on the scene, answer picks with their pickId and go with the engine', async () => {
  const geo = await import('../../geo/index.js');
  const viewer = createFakeViewer();
  const reasons = [];
  const engine = createCesiumEngine(viewer, {
    requestRender: (reason) => reasons.push(reason),
  });
  const set = engine.movers.createSet({
    id: 'horizon-points',
    pickable: true,
    kind: 'point',
    capacity: 2,
    point: { sizePx: 8 },
  });
  // The fake camera is at x = 7e6 (over 0°, 0°): 0°E is in front, 180° behind.
  set.set(0, { position: geo.cartesian3.fromDegrees(0, 1, 0), pickId: 'a' });
  set.set(1, { position: geo.cartesian3.fromDegrees(180, 1, 0), pickId: 'b' });
  set.setCount(2);
  set.commit();
  const line = engine.lines.createLine({
    id: 'orbit',
    widthPx: 2,
    color: [1, 1, 1, 1],
    pickId: 'orbit-1',
  });
  assert.deepEqual(engine.movers.list(), [
    { id: 'horizon-points', kind: 'point', count: 2, capacity: 2 },
  ]);
  assert.deepEqual(engine.lines.list(), [
    { id: 'orbit', points: 0, shown: true },
  ]);
  assert.ok(reasons.includes('movers'));
  assert.equal(viewer.primitiveList.length, 2, 'one root each');
  const [points] = collectionsUnder(viewer).filter(
    (item) => item instanceof Cesium.PointPrimitiveCollection,
  );
  const front = points.get(0);
  const back = points.get(1);
  const lineSlot = { gevLine: 'orbit' };
  viewer.scene.drillPick = () => [
    { primitive: back, id: 'b' },
    { primitive: front, id: 'stale' },
    { primitive: lineSlot, id: 'orbit-1' },
  ];
  assert.deepEqual(
    engine.picker
      .drillPick({ x: 1, y: 1 })
      .map(({ id, owner, instance }) => [id, owner, instance]),
    [
      ['a', 'horizon-points', 0],
      ['orbit-1', 'orbit', undefined],
    ],
    'the instance behind the horizon is left out',
  );
  viewer.scene.pick = () => ({ primitive: front, id: 'stale' });
  assert.equal(engine.picker.pick({ x: 1, y: 1 }).id, 'a');
  // A mover set in a surface exclusion is hidden for the sample only.
  let shownDuring;
  viewer.scene.sampleHeight = (position, excluded) => {
    shownDuring = [points.show, excluded];
    return 5;
  };
  const place = geo.cartographic.fromDegrees(0, 1, 0);
  assert.equal(engine.surface.sampleHeight(place, [set]), 5);
  assert.deepEqual(shownDuring, [false, []]);
  assert.equal(points.show, true);
  engine.destroy();
  assert.equal(points.isDestroyed(), true);
  assert.deepEqual(viewer.primitiveList, []);
  assert.deepEqual(engine.movers.list(), []);
  assert.deepEqual(engine.lines.list(), []);
  assert.equal(set.isDestroyed(), true);
  assert.throws(() => line.show(false), /destroyed/);
});

test('the contract suite movers and lines checks pass on the Cesium engine (no pixels or pointer)', async (t) => {
  // Cesium's Material sorts uniform values with instanceof checks against
  // these DOM classes; Node has none of them.
  for (const name of [
    'HTMLCanvasElement',
    'HTMLImageElement',
    'HTMLVideoElement',
    'ImageBitmap',
    'OffscreenCanvas',
  ])
    globalThis[name] ??= class {};
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
    /^(shape|movers|lines|colours|input: picks|surface\.sampleHeightDetailed)\b/.test(
      name,
    ),
  );
  assert.equal(checks.length, 8);
  try {
    for (const { name, run } of checks) await t.test(name, run);
  } finally {
    engine.destroy();
  }
  assert.equal(scene.primitives.length, 0, 'no collection left behind');
});
