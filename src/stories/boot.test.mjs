// Stories loads its controller, catalog and engine on first use, not with GEV.
import '../testSupport/registerDom.mjs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { createPinia, setActivePinia } from 'pinia';

// Every module Node loads, to see when the Stories chunk arrives.
const loaded = new Set();
registerHooks({
  load(url, context, next) {
    loaded.add(url);
    if (url.endsWith('.css'))
      return {
        format: 'module',
        source: 'export default "";',
        shortCircuit: true,
      };
    if (url.endsWith('.webp'))
      return {
        format: 'module',
        source: `export default ${JSON.stringify(url)};`,
        shortCircuit: true,
      };
    return next(url, context);
  },
});
const context = new Proxy(
  {},
  { get: (target, name) => target[name] ?? (() => context), set: () => true },
);
globalThis.HTMLCanvasElement.prototype.getContext = (kind) =>
  kind === 'webgl' ? null : context;
globalThis.requestAnimationFrame = () => 0;
globalThis.cancelAnimationFrame = () => {};

const { bootStories } = await import('./boot.js');
const { useStoriesStore } = await import('../ui/stores/stories.js');

const viewer = {
  scene: {
    canvas: document.createElement('canvas'),
    postRender: { addEventListener: () => () => {} },
  },
  camera: {
    positionWC: new Cesium.Cartesian3(1, 2, 3),
    positionCartographic: { latitude: 0, longitude: 0, height: 2e6 },
    heading: 0,
    pitch: -1,
    roll: 0,
    setView() {},
    flyTo() {},
    flyToBoundingSphere() {},
    cancelFlight() {},
  },
  clock: { currentTime: Cesium.JulianDate.now(), shouldAnimate: false },
};
const director = {
  running: false,
  stopScene() {},
  whenIdle: async () => {},
  listShots: () => [],
  subscribeSceneClock: () => () => {},
  seekScene() {},
  styleManager: { runImmediateNavigation: () => true },
};

test('the shell loads the controller on first open, then steps aside', async () => {
  setActivePinia(createPinia());
  history.replaceState(null, '', '/');
  const store = useStoriesStore();
  const entries = [];
  const shell = bootStories({
    viewer,
    director,
    store,
    onEnter: () =>
      entries.push(document.body.classList.contains('stories-mode')),
  });
  assert.equal(store.controller, shell);
  assert.equal(store.stories.length, 0, 'no catalog until Stories is used');
  const engineLoaded = () =>
    [...loaded].some((u) =>
      /stories\/(controller|catalog|protoEngine)\.js$/.test(u),
    );
  assert.equal(engineLoaded(), false, 'GEV starts without the Stories chunk');
  let current = true;
  const staleOpen = shell.open({ isCurrent: () => current });
  current = false;
  assert.equal(await staleOpen, false);
  assert.equal(store.mode, 'closed');
  assert.deepEqual(entries, []);
  assert.equal(await shell.open(), true);
  assert.deepEqual(entries, [true]);
  assert.equal(engineLoaded(), true);
  assert.notEqual(store.controller, shell);
  assert.ok(store.stories.length > 0);
  assert.equal(store.mode, 'explore');
  shell.destroy();
  assert.equal(store.mode, 'closed');
});

test('a Stories link loads the controller straight away', async () => {
  setActivePinia(createPinia());
  history.replaceState(null, '', '/?stories=explore');
  const store = useStoriesStore();
  const shell = bootStories({ viewer, director, store });
  const real = await shell.load();
  assert.equal(store.controller, real);
  shell.destroy();
  history.replaceState(null, '', '/');
});

test('a failed load is reported and the next open tries again', async () => {
  setActivePinia(createPinia());
  history.replaceState(null, '', '/');
  const store = useStoriesStore();
  let failures = 0;
  let attempts = 0;
  const shell = bootStories({
    viewer,
    director,
    store,
    onLoadFailed: () => (failures += 1),
    // The Stories chunk is unreachable on the first try only.
    loadModules: () =>
      ++attempts === 1
        ? Promise.reject(new Error('offline'))
        : Promise.all([import('./controller.js'), import('./catalog.js')]),
  });
  assert.equal(await shell.open(), undefined);
  assert.equal(failures, 1);
  assert.equal(store.mode, 'closed');
  assert.equal(await shell.open(), true);
  assert.equal(attempts, 2, 'the failure was not kept');
  assert.equal(store.mode, 'explore');
  shell.destroy();
});

test('a Stories link that cannot load is reported too', async () => {
  setActivePinia(createPinia());
  history.replaceState(null, '', '/?story=worldfx%3Afire-tracker');
  const store = useStoriesStore();
  let failures = 0;
  bootStories({
    viewer,
    director,
    store,
    onLoadFailed: () => (failures += 1),
    loadModules: () => Promise.reject(new Error('offline')),
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(failures, 1);
  history.replaceState(null, '', '/');
});
