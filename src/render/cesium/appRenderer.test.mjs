import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';
import { CONTRACT_VERSION, checkRendererShape } from '../contract/index.js';
import { rendererOf } from '../rendererOf.js';
import { IDLE_FRAME_RATE } from '../../renderGovernor.js';
import { cesiumMapEngine } from './mapEngine.js';
import {
  ReadonlySet,
  cesiumRenderer,
  cesiumViewerOf,
  createCesiumRendererPlugin,
} from './appRenderer.js';

/** A document with just a body, recording what is attached. */
function fakeDocument() {
  const children = [];
  const make = () => {
    const el = {
      id: '',
      remove() {
        const i = children.indexOf(el);
        if (i >= 0) children.splice(i, 1);
      },
    };
    return el;
  };
  return {
    children,
    createElement: make,
    body: { appendChild: (el) => children.push(el) },
    getElementById: () => null,
    // The input port watches the document's pointer events.
    addEventListener() {},
    removeEventListener() {},
  };
}

/** A Cesium event: listeners added, and removed by the returned function. */
function fakeEvent(listeners) {
  return {
    addEventListener(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
}

function fakeViewer(log, { failDestroy = false } = {}) {
  let destroyed = false;
  const listeners = new Set();
  return {
    listeners,
    scene: {
      camera: {
        moveStart: fakeEvent(listeners),
        moveEnd: fakeEvent(listeners),
      },
      primitives: { add() {}, remove() {} },
      // The free-look height limit writes the camera controller's look.
      screenSpaceCameraController: {
        enableLook: true,
        minimumTrackBallHeight: 7_500_000,
      },
      requestRender() {},
      preUpdate: fakeEvent(listeners),
      postUpdate: fakeEvent(listeners),
      preRender: fakeEvent(listeners),
      postRender: fakeEvent(listeners),
    },
    camera: { positionCartographic: { height: 20_000_000 } },
    entities: { contains: (entity) => entity?.own === true },
    canvas: {
      tag: 'canvas',
      // Cesium's input handler binds the canvas's events.
      addEventListener() {},
      removeEventListener() {},
    },
    resize: () => log.push('resize'),
    isDestroyed: () => destroyed,
    destroy() {
      log.push('destroy');
      if (failDestroy) throw new Error('destroy failed');
      destroyed = true;
    },
  };
}

function withDocument(t, doc) {
  const saved = globalThis.document;
  globalThis.document = doc;
  t.after(() => {
    globalThis.document = saved;
  });
}

test('the default plugin is the Cesium renderer', () => {
  assert.equal(cesiumRenderer.id, 'cesium');
  assert.ok(Object.isFrozen(cesiumRenderer));
});

test('the plugin wraps the viewer it is given, behind the accessor only', async (t) => {
  const doc = fakeDocument();
  withDocument(t, doc);
  const log = [];
  let given;
  let viewer;
  const plugin = createCesiumRendererPlugin({
    createViewer(options) {
      given = options;
      viewer = fakeViewer(log);
      return viewer;
    },
  });
  const container = { tag: 'container' };
  const renderer = await plugin.create({
    container,
    signal: new AbortController().signal,
  });
  assert.equal(given.container, container);
  assert.equal(given.creditContainer.id, 'cesium-credits');
  assert.deepEqual(
    doc.children,
    [given.creditContainer],
    'credits on the page',
  );

  assert.equal(renderer.id, 'cesium');
  assert.equal(renderer.contractVersion, CONTRACT_VERSION);
  assert.equal(renderer.canvas.tag, 'canvas');
  assert.ok(Object.isFrozen(renderer));
  assert.ok(renderer.capabilities instanceof Set);
  assert.throws(() => renderer.capabilities.add('models'), TypeError);
  assert.throws(() => renderer.capabilities.delete('models'), TypeError);
  assert.throws(() => renderer.capabilities.clear(), TypeError);
  assert.ok(!('viewer' in renderer), 'no engine object is a member');
  assert.equal(cesiumViewerOf(renderer).canvas, renderer.canvas);
  assert.equal(rendererOf(viewer), renderer, 'the viewer finds its renderer');

  assert.equal(
    viewer.scene.screenSpaceCameraController.enableLook,
    false,
    'free look is limited to low heights from the start',
  );
  const hooks = plugin.applicationHooks(renderer);
  assert.equal(hooks.mapEngine, cesiumMapEngine, 'the map stacks use Cesium');
  assert.equal(hooks.ownCreditDisplay, true, 'Cesium shows its own credits');
  assert.equal(hooks.qaHandles.viewer, viewer, 'QA scripts read the viewer');
  assert.equal(hooks.viewerDrawsEntity({ own: true }), true);
  assert.equal(hooks.viewerDrawsEntity({}), false);
  assert.equal(typeof hooks.trimStaleCommands, 'function');

  assert.ok(viewer.listeners.size > 0, 'the ports follow the frame phases');
  assert.equal(typeof renderer.draw.icons, 'function');
  assert.ok(renderer.capabilities.has('models'), 'draw.models is declared');

  renderer.resize();
  renderer.destroy();
  assert.equal(viewer.listeners.size, 0, 'and stop on destroy');
  assert.equal(rendererOf(viewer), null, 'and lets go of the viewer');
  assert.equal(
    viewer.scene.screenSpaceCameraController.enableLook,
    true,
    'and gives free look back',
  );
  assert.deepEqual(log, ['resize', 'destroy']);
  assert.deepEqual(doc.children, [], 'credits leave with the renderer');
  renderer.destroy();
  assert.deepEqual(log, ['resize', 'destroy'], 'destroying twice is safe');
});

test('the application’s loop ticks at the idle rate while nothing moves, and at the display’s while anything does', async (t) => {
  withDocument(t, fakeDocument());
  let viewer;
  const plugin = createCesiumRendererPlugin({
    createViewer() {
      viewer = fakeViewer([]);
      // The viewer starts at the idle rate (createApplicationViewer).
      viewer.targetFrameRate = IDLE_FRAME_RATE;
      return viewer;
    },
  });
  const renderer = await plugin.create({
    container: {},
    signal: new AbortController().signal,
  });
  assert.equal(viewer.targetFrameRate, IDLE_FRAME_RATE);
  assert.equal(renderer.frame.diagnostics().targetFps, 0, 'no cap');
  const release = renderer.frame.holdContinuous('flights');
  assert.equal(viewer.targetFrameRate, undefined);
  release();
  assert.equal(viewer.targetFrameRate, IDLE_FRAME_RATE);
  renderer.destroy();
});

test('work pending at destroy is rejected and lets go of the scene', async (t) => {
  withDocument(t, fakeDocument());
  const viewers = [];
  const plugin = createCesiumRendererPlugin({
    createViewer: () => {
      const viewer = fakeViewer([]);
      viewers.push(viewer);
      return viewer;
    },
  });

  const renderer = await plugin.create({ container: {} });
  const rendered = renderer.frame.renderOnce();
  renderer.destroy();
  await assert.rejects(rendered, /renderer destroyed/, 'the one waiting');
  assert.equal(viewers[0].listeners.size, 0, 'no one-shot render stays');
  await assert.rejects(renderer.frame.renderOnce(), /renderer destroyed/);
  await assert.rejects(renderer.capture(), /renderer destroyed/);

  const waiting = await plugin.create({ container: {} });
  const standing = viewers[1].listeners.size;
  await assert.rejects(
    waiting.frame.renderOnce({ timeoutMs: 5 }),
    /timed out/,
    'a frame that never comes times out when asked to',
  );
  assert.equal(
    viewers[1].listeners.size,
    standing,
    'and lets go of its listener',
  );
  waiting.destroy();

  // A model that finishes loading after destroy is destroyed, not added.
  const load = Promise.withResolvers();
  const saved = Cesium.Model.fromGltfAsync;
  Cesium.Model.fromGltfAsync = () => load.promise;
  t.after(() => {
    Cesium.Model.fromGltfAsync = saved;
  });
  const again = await plugin.create({ container: {} });
  again.draw.models({ id: 'm' }).set([
    {
      id: 'a',
      url: 'a.glb',
      pos: { lon: 0, lat: 0, height: 0 },
      orientation: { heading: 0, pitch: 0, roll: 0 },
    },
  ]);
  again.destroy();
  let destroyed = false;
  load.resolve({
    destroy: () => (destroyed = true),
    readyEvent: fakeEvent(new Set()),
    errorEvent: fakeEvent(new Set()),
  });
  await load.promise;
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(destroyed, 'the late model is destroyed');
});

test('the credits leave even when the viewer fails to destroy', async (t) => {
  const doc = fakeDocument();
  withDocument(t, doc);
  const plugin = createCesiumRendererPlugin({
    createViewer: () => fakeViewer([], { failDestroy: true }),
  });
  const renderer = await plugin.create({
    container: {},
    signal: new AbortController().signal,
  });
  assert.throws(() => renderer.destroy(), /destroy failed/);
  assert.deepEqual(doc.children, []);
});

test('a viewer that fails to build leaves no credits behind', async (t) => {
  const doc = fakeDocument();
  withDocument(t, doc);
  const plugin = createCesiumRendererPlugin({
    createViewer() {
      throw new Error('no WebGL');
    },
  });
  await assert.rejects(
    plugin.create({ container: {}, signal: new AbortController().signal }),
    /no WebGL/,
  );
  assert.deepEqual(doc.children, []);
});

test('an aborted creation builds nothing', async (t) => {
  const doc = fakeDocument();
  withDocument(t, doc);
  let built = false;
  const plugin = createCesiumRendererPlugin({
    createViewer: () => {
      built = true;
      return fakeViewer([]);
    },
  });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    plugin.create({ container: {}, signal: controller.signal }),
    { name: 'AbortError' },
  );
  assert.equal(built, false);
  assert.deepEqual(doc.children, []);
});

test('the transitional renderer lacks exactly the members still to come', async (t) => {
  withDocument(t, fakeDocument());
  const renderer = await createCesiumRendererPlugin({
    createViewer: () => fakeViewer([]),
  }).create({ container: {}, signal: new AbortController().signal });
  // Each phase 2 port shrinks this list; nothing may be faked to shorten it.
  assert.deepEqual(checkRendererShape(renderer).sort(), EXPECTED_MISSING);
});

test('a read-only set keeps the values it was built with', () => {
  const set = new ReadonlySet(['models', 'terrain']);
  assert.deepEqual([...set], ['models', 'terrain']);
  assert.ok(set.has('terrain'));
  assert.throws(() => set.add('x'), TypeError);
  assert.equal(set.size, 2);
});

test('only renderers this plugin made reach a Cesium viewer', () => {
  assert.equal(cesiumViewerOf({ id: 'cesium' }), null);
  assert.equal(cesiumViewerOf({}), null);
});

const EXPECTED_MISSING = [];

test('the plugin makes its viewer with the creation options, and sets the sky, time and clock before the first frame', async (t) => {
  const doc = fakeDocument();
  withDocument(t, doc);
  const log = [];
  let given;
  let viewer;
  const plugin = createCesiumRendererPlugin({
    createViewer(options) {
      given = options;
      viewer = fakeViewer(log);
      for (const phase of [
        'preUpdate',
        'postUpdate',
        'preRender',
        'postRender',
      ])
        viewer.scene[phase] = new Cesium.Event();
      viewer.scene.skyAtmosphere = { show: true };
      viewer.scene.fog = { enabled: true };
      viewer.clock = { currentTime: Cesium.JulianDate.now() };
      return viewer;
    },
  });
  const time = Date.UTC(2030, 5, 21, 12);
  const clock = { now: () => 1234.5, date: () => time + 60_000 };
  const renderer = await plugin.create({
    container: { tag: 'container' },
    signal: new AbortController().signal,
    msaa: 2,
    sky: { atmosphere: false, fog: false },
    time,
    clock,
  });
  assert.equal(given.msaa, 2, 'multisampling');
  assert.equal(viewer.scene.skyAtmosphere.show, false, 'the sky, set');
  assert.equal(viewer.scene.fog.enabled, false);
  assert.equal(renderer.globe.sky.get().fog, false);
  assert.equal(
    Cesium.JulianDate.toDate(viewer.clock.currentTime).getTime(),
    time,
    'the scene time',
  );
  const ticks = [];
  renderer.frame.on('preUpdate', (tick) => ticks.push(tick.now));
  viewer.scene.preUpdate.raiseEvent(viewer.scene, viewer.clock.currentTime);
  assert.deepEqual(ticks, [1234.5], 'ticks read the clock given');
  renderer.destroy();

  // Not given, the viewer is made as it always was.
  await plugin
    .create({
      container: { tag: 'container' },
      signal: new AbortController().signal,
    })
    .then((r) => r.destroy());
  assert.equal(given.msaa, undefined);
});
