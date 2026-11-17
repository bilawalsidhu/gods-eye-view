// Stories loads its controller, catalog and engine on first use, not with GEV.
import '../testSupport/registerDom.mjs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';
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

const { bootStories, stopVoiceForStories, storiesOpener } =
  await import('./boot.js');
const { useStoriesStore } = await import('../ui/stores/stories.js');

const { bindRenderer } = await import('../render/rendererOf.js');

// The scene object, bound to a renderer double with the ports Stories uses.
const viewer = { isDestroyed: () => false };
bindRenderer(viewer, {
  canvas: document.createElement('canvas'),
  camera: {
    pose: () => ({
      position: { x: 1, y: 2, z: 3 },
      heading: 0,
      pitch: -1,
      roll: 0,
      lon: 0,
      lat: 0,
      height: 2e6,
    }),
    setView() {},
    flyTo() {},
    flyToBounds() {},
    cancelFlight() {},
  },
  frame: {
    on: () => () => {},
    requestRender() {},
    holdContinuous: () => () => {},
  },
  query: { project: () => null, isOccluded: () => true },
  globe: { isSettled: () => true },
});
const director = {
  running: false,
  stopScene() {},
  whenIdle: async () => {},
  listShots: () => [],
  subscribeSceneClock: () => () => {},
  seekScene() {},
  styleManager: { runImmediateNavigation: () => true },
};

test('open_stories runs the app’s own openStories when it supplies one', async () => {
  const calls = [];
  const opened = [];
  const own = async (options) => {
    calls.push(options);
    return true;
  };
  const open = storiesOpener({
    openStories: own,
    store: { available: true, mode: 'closed' },
    stories: { open: (options) => opened.push(options) },
  });
  assert.equal(open, own);
  const isCurrent = () => true;
  assert.equal(await open({ isCurrent }), true);
  assert.deepEqual(calls, [{ isCurrent }]);
  assert.deepEqual(opened, [], 'the Stories page is not opened');
});

test('open_stories opens the Stories page by default', () => {
  const opened = [];
  const store = { available: true, mode: 'closed' };
  const stories = {
    open: (options) => {
      opened.push(options);
      return true;
    },
  };
  const open = storiesOpener({ store, stories });
  const isCurrent = () => true;
  assert.equal(open({ isCurrent }), true);
  assert.deepEqual(opened, [{ isCurrent }]);
  store.mode = 'explore';
  assert.equal(open({ isCurrent }), 'already-open');
  assert.equal(opened.length, 1);
  // Where Stories is not offered, there is nothing to open.
  assert.equal(
    storiesOpener({ store: { available: false, mode: 'closed' }, stories }),
    null,
  );
});

test('entering Stories stops microphone sessions and preserves typed chat', () => {
  let textOnly = false;
  let active = true;
  let stops = 0;
  const session = {
    adapter: { getStartOptions: () => ({ textOnly }) },
    isActive: () => active,
    stop: () => {
      stops += 1;
    },
  };
  assert.equal(stopVoiceForStories(session), true);
  active = false;
  assert.equal(stopVoiceForStories(session), false);
  assert.equal(stops, 2);
  textOnly = true;
  active = true;
  assert.equal(stopVoiceForStories(session), false);
  assert.equal(stops, 2);
});

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
  history.replaceState(null, '', '/?story=other%3Afire-tracker');
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
