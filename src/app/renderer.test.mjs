import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CONTRACT_VERSION,
  checkRendererShape,
} from '../render/contract/index.js';
import {
  ReadonlySet,
  cesiumRenderer,
  cesiumViewerOf,
  createCesiumRendererPlugin,
} from './renderer.js';

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
  };
}

function fakeViewer(log, { failDestroy = false } = {}) {
  let destroyed = false;
  return {
    canvas: { tag: 'canvas' },
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
  const plugin = createCesiumRendererPlugin({
    createViewer(options) {
      given = options;
      return fakeViewer(log);
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

  renderer.resize();
  renderer.destroy();
  assert.deepEqual(log, ['resize', 'destroy']);
  assert.deepEqual(doc.children, [], 'credits leave with the renderer');
  renderer.destroy();
  assert.deepEqual(log, ['resize', 'destroy'], 'destroying twice is safe');
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

test('the transitional renderer lacks exactly the ports still to come', async (t) => {
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

test('the application refuses a renderer it cannot run on, and destroys it', async (t) => {
  const { createApplicationScene } = await import('./scene.js');
  const { createApplicationRequestServices } =
    await import('../services/requests.js');
  const destroyed = [];
  const deferred = [];
  const plugin = {
    id: 'other',
    async create(options) {
      assert.ok(options.signal, 'the scene passes its signal');
      return {
        id: 'other',
        destroy: () => {
          destroyed.push('other');
          throw new Error('and it fails to go');
        },
      };
    },
  };
  const saved = { document: globalThis.document, window: globalThis.window };
  globalThis.document = fakeDocument();
  globalThis.window = new EventTarget();
  const warn = console.warn;
  console.warn = () => {};
  t.after(() => {
    for (const fn of deferred.reverse()) fn();
    console.warn = warn;
    globalThis.document = saved.document;
    globalThis.window = saved.window;
  });
  await assert.rejects(
    createApplicationScene({
      renderer: plugin,
      requestServices: createApplicationRequestServices(),
      loaderStatus: { textContent: '' },
      signal: new AbortController().signal,
      defer: (fn) => deferred.push(fn),
    }),
    /other renderer cannot run the application yet/,
    'the refusal is not hidden by the failed destroy',
  );
  assert.deepEqual(destroyed, ['other']);
});

const EXPECTED_MISSING = [
  'camera',
  'capture',
  'credits',
  'draw',
  'effects',
  'frame',
  'globe',
  'input',
  'on',
  'quality',
  'query',
  'readPixels',
  'releaseUnused',
  'whenSettled',
].map((member) => `renderer.${member} is missing`);
