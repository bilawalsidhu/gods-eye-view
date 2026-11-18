// The Stories controller: what it leaves behind in history and on GEV's
// globe when Stories opens and closes.
import '../testSupport/registerDom.mjs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPinia, setActivePinia } from 'pinia';
import { createStateChannel } from '../app/stateChannel.js';
import { bindRenderer } from '../render/rendererOf.js';
import { getRenderGovernorDiagnostics } from '../renderGovernor.js';
import { ShareLinkManager } from '../sharelink.js';
const holds = () => getRenderGovernorDiagnostics().holds;

registerHooks({
  load(url, context, next) {
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

const { createStoriesController } = await import('./controller.js');
const { COCKPIT_REFUSAL_NOUNS } = await import('../navigationPolicy.js');
const { useStoriesStore } = await import('../ui/stores/stories.js');
const { listStories } = await import('./catalog.js');

/**
 * The scene object Stories is handed, bound to a renderer double with the
 * ports Stories uses: the camera, the frame loop (postRender listeners run
 * on `draw()`), screen projection with the horizon test, and the globe's
 * settling. The doubles are returned beside it for the tests to drive.
 */
function fakeScene() {
  const canvas = document.createElement('canvas');
  const camera = {
    position: { x: 1, y: 2, z: 3 },
    views: [],
    flights: [],
    cancels: 0,
    pose() {
      return {
        position: { ...this.position },
        heading: 0,
        pitch: -1,
        roll: 0,
        lon: 11.46,
        lat: 28.65,
        height: 2e6,
      };
    },
    setView(v) {
      this.views.push(v);
    },
    cancelFlight() {
      this.cancels += 1;
    },
    flyTo(destination, options) {
      this.flights.push({ destination, ...options });
    },
    flyToBounds(sphere, options) {
      this.flights.push({ sphere, ...options });
    },
  };
  const frame = {
    listeners: new Set(),
    requests: [],
    on(phase, fn) {
      assert.equal(phase, 'postRender');
      this.listeners.add(fn);
      return () => this.listeners.delete(fn);
    },
    draw() {
      for (const fn of [...this.listeners]) fn({});
    },
    requestRender(reason) {
      this.requests.push(reason);
    },
    holdContinuous: () => () => {},
  };
  const query = {
    hidden: new Set(),
    project: ({ x, y }) => ({ x: x / 1e5, y: y / 1e5 }),
    isOccluded(at) {
      return this.hidden.has(at);
    },
  };
  const globe = { settled: false, isSettled: () => globe.settled };
  const viewer = { isDestroyed: () => false };
  bindRenderer(viewer, { canvas, camera, frame, query, globe });
  return { viewer, camera, frame, query, globe, canvas };
}

/** A world clock double: its state, and the calls made on it. */
function fakeClock(state = {}) {
  const calls = [];
  const clock = {
    calls,
    state: {
      live: true,
      timeMs: Date.UTC(2026, 0, 1),
      playing: false,
      rate: 1,
      stepping: false,
      jumps: 0,
      ...state,
    },
    getState: () => ({ ...clock.state }),
    goLive() {
      calls.push(['goLive']);
      Object.assign(clock.state, { live: true, playing: false });
      clock.state.jumps += 1;
    },
    seek(ms) {
      calls.push(['seek', ms]);
      Object.assign(clock.state, { live: false, timeMs: ms });
      clock.state.jumps += 1;
    },
    pause() {
      calls.push(['pause']);
      clock.state.playing = false;
    },
    play(options) {
      calls.push(['play', options]);
      clock.state.playing = true;
    },
  };
  return clock;
}

function fakeDirector({ refuse = false } = {}) {
  const claims = [];
  return {
    claims,
    running: false,
    stops: 0,
    stopScene() {
      this.stops += 1;
    },
    whenIdle() {
      return new Promise((resolve) => {
        const check = () => (this.running ? setTimeout(check, 10) : resolve());
        check();
      });
    },

    listShots: () => [],
    subscribeSceneClock: () => () => {},
    seekScene() {},
    startScene: async () => ({ started: true }),
    selected: [],
    selectShot(sceneId, shotId) {
      this.selected.push([sceneId, shotId]);
      return true;
    },
    styleManager: {
      runImmediateNavigation: (noun) => {
        claims.push(noun);
        return !refuse;
      },
      panels: [],
      setPanelCollapsed(id, collapsed) {
        this.panels.push([id, collapsed]);
      },
      shareLinkManager: {
        restored: [],
        restore(hash) {
          this.restored.push(hash);
          return true;
        },
      },
    },
  };
}

function setup(options = {}) {
  setActivePinia(createPinia());
  history.replaceState(null, '', '/?x=1#v=2&lat=1');
  const store = useStoriesStore();
  const scene = fakeScene();
  const clock = options.clock ?? fakeClock();
  const director = fakeDirector(options);
  const controller = createStoriesController({
    viewer: scene.viewer,
    director,
    store,
    onEnter: options.onEnter,
    clock,
  });
  store.connect(controller, listStories());
  return { ...scene, clock, store, director, controller };
}

test('Close steps back over every entry Stories pushed', async () => {
  const entered = [];
  const { controller } = setup({
    onEnter: () =>
      entered.push(document.body.classList.contains('stories-mode')),
  });
  const steps = [];
  const go = history.go;
  history.go = (n) => steps.push(n);
  try {
    assert.equal(controller.open(), true);
    assert.equal(history.state.gevStories.depth, 1);
    controller.openStory('gev:flights-radar');
    assert.equal(history.state.gevStories.depth, 2);
    assert.deepEqual(entered, [true]);
    await controller.close();
    // Back after Close would otherwise land on ?story=… and reopen it.
    assert.deepEqual(steps, [-2]);
  } finally {
    history.go = go;
    controller.destroy();
  }
});

test('Close from a Stories link clears Stories from the URL in place', async () => {
  const { controller } = setup();
  history.replaceState(null, '', '/?stories=explore#v=2');
  controller.open({ fromHistory: true });
  await controller.close();
  assert.equal(new URL(location.href).searchParams.has('stories'), false);
  assert.equal(location.hash, '#v=2');
  controller.destroy();
});

test('Cockpit keeps the camera: Stories does not open', () => {
  const { controller, store, director } = setup({
    refuse: true,
    onEnter: () => assert.fail('refused entry should not stop voice'),
  });
  assert.equal(controller.open({ isCurrent: () => false }), false);
  assert.deepEqual(director.claims, []);
  assert.equal(controller.open(), false);
  assert.equal(store.mode, 'closed');
  assert.equal(director.stops, 0);
  // The navigation policy shows the refusal; it needs a sentence for the noun.
  assert.deepEqual(director.claims, ['stories']);
  assert.ok(COCKPIT_REFUSAL_NOUNS.includes('stories'));
  controller.destroy();
});

test('reopening while a scene tears down keeps the view from before Stories', async () => {
  const { controller, director, store, camera } = setup();
  const before = { ...camera.position };
  controller.open();
  controller.openStory('gev:bhote-koshi-nepal-scene');
  director.running = true;
  const toast = store.openedToast;
  const closing = controller.openInGev();
  // The scene has moved the camera; the person opens Stories again at once.
  camera.position = { x: 9, y: 9, z: 9 };
  controller.open();
  director.running = false;
  await closing;
  assert.deepEqual(director.selected, []);
  assert.deepEqual(director.styleManager.panels, []);
  assert.equal(store.openedToast, toast);
  assert.equal(camera.views.length, 0, 'no restore under the reopened Stories');
  await controller.close();
  const { x, y, z } = camera.views.at(-1).destination;
  assert.deepEqual({ x, y, z }, { x: before.x, y: before.y, z: before.z });
  controller.destroy();
});

test('after a GEV scene, the person’s view comes back once the scene has torn down', async () => {
  const { controller, director, camera } = setup();
  controller.open();
  controller.openStory('gev:bhote-koshi-nepal-scene');
  director.running = true;
  const closing = controller.close();
  assert.equal(camera.views.length, 0, 'not under the stopping scene');
  setTimeout(() => (director.running = false), 120);
  await closing;
  assert.equal(camera.views.length, 1);
  controller.destroy();
});

test('Share links to the selection and captures the playing story’s timeline', () => {
  const { controller, store } = setup();
  controller.open();
  assert.equal(new URL(controller.shareLink()).search, '?stories=explore');
  controller.pick('gev:orbital-watch');
  assert.equal(
    new URL(controller.shareLink()).search,
    '?stories=explore&selectedStory=gev%3Aorbital-watch',
  );
  controller.openStory('gev:flights-radar');
  store.playback = { ...store.playback, playing: true, wallMs: 1250.6 };
  const link = new URL(controller.shareLink());
  assert.deepEqual(
    [...link.searchParams],
    [
      ['story', 'gev:flights-radar'],
      ['storyTime', '1251'],
    ],
  );
  assert.equal(link.hash, '');
  store.playback.wallMs = 1850;
  assert.equal(
    new URL(controller.shareLink()).searchParams.get('storyTime'),
    '1850',
  );
  controller.backToExplore({ fromHistory: true });
  assert.equal(
    new URL(controller.shareLink()).search,
    '?stories=explore&selectedStory=gev%3Aflights-radar',
  );
  controller.destroy();
});

/** Record history.go calls instead of traversing. */
function recordGo(t) {
  const steps = [];
  const go = history.go;
  history.go = (n) => steps.push(n);
  t.after(() => {
    history.go = go;
  });
  return steps;
}

test('Back to Explore after a related story steps past both stories', (t) => {
  const { controller, store } = setup();
  const steps = recordGo(t);
  controller.open();
  controller.openStory('gev:flights-radar');
  controller.openStory('gev:orbital-watch'); // a related story
  assert.equal(history.state.gevStories.depth, 3);
  assert.equal(history.state.gevStories.explore, 1);
  controller.backToExplore();
  controller.openStory('gev:flights-radar'); // queued behind Back
  // The latest Back cancels that queued story without another traversal.
  controller.backToExplore();
  assert.deepEqual(steps, [-2]);
  history.replaceState(
    { gevStories: { stories: 'explore', depth: 1, explore: 1 } },
    '',
    '/?stories=explore',
  );
  dispatchEvent(new PopStateEvent('popstate'));
  assert.equal(store.mode, 'explore');
  assert.equal(store.storyId, null);
  assert.equal(history.state.gevStories.depth, 1, 'no queued story pushed');
  controller.destroy();
});

test('Back to Explore keeps the returned story and finishes a queued Open in GEV', async (t) => {
  const { controller, director, store } = setup();
  t.after(() => controller.destroy());
  const steps = recordGo(t);
  const explore = '/?stories=explore&selectedStory=gev%3Aorbital-watch';
  const entry = { gevStories: { stories: 'explore', depth: 1, explore: 1 } };
  history.replaceState(entry, '', explore);
  controller.open({ fromHistory: true });
  controller.openStory('gev:flights-radar');
  controller.backToExplore();
  history.replaceState(entry, '', explore);
  dispatchEvent(new PopStateEvent('popstate'));
  assert.equal(store.picked, 'gev:flights-radar');
  assert.equal(
    new URL(location.href).searchParams.get('selectedStory'),
    'gev:flights-radar',
  );

  controller.openStory('gev:flights-radar');
  controller.backToExplore();
  await controller.openInGev();
  assert.deepEqual(director.selected, []);
  history.replaceState(entry, '', explore);
  dispatchEvent(new PopStateEvent('popstate'));
  await tick();
  assert.equal(store.mode, 'closed');
  assert.deepEqual(steps, [-1, -1, -1]);
  assert.equal(director.selected.at(-1)?.[0], 'flights-radar');
});

test('Stories waits for a stopped Authoring load before framing and saving the view', async (t) => {
  const { controller, director, camera } = setup();
  t.after(() => controller.destroy());
  recordGo(t);
  let resolveIdle;
  director.busy = true;
  director.whenIdle = () =>
    new Promise((resolve) => {
      resolveIdle = resolve;
    });
  const share = director.styleManager.shareLinkManager;
  const snapshots = [];
  share.snapshotHash = () => {
    snapshots.push(director.busy);
    return 'v=2&lat=25';
  };
  assert.equal(controller.open(), true);
  assert.equal(director.stops, 1);
  assert.deepEqual(snapshots, []);
  assert.equal(camera.flights.length, 0);
  await Promise.resolve();
  director.busy = false;
  resolveIdle();
  await tick();
  assert.deepEqual(snapshots, [false]);
  assert.equal(camera.flights.length, 1);

  director.whenIdle = async () => {};
  await controller.close();
  land();
  assert.deepEqual(share.restored, ['v=2&lat=25']);
});

test('a second Close after a quick reopen still waits for the scene to tear down', async () => {
  const { controller, director, camera } = setup();
  controller.open();
  controller.openStory('gev:bhote-koshi-nepal-scene');
  director.running = true;
  const first = controller.close({ keepCamera: true });
  controller.open(); // reopened while the scene is still stopping
  const closing = controller.close(); // Explore: no GEV story on screen
  assert.ok(closing, 'this Close waits too');
  assert.equal(camera.views.length, 0, 'nothing restored yet');
  setTimeout(() => (director.running = false), 120);
  await Promise.all([first, closing]);
  assert.equal(camera.views.length, 1);
  controller.destroy();
});

test('a reload of a Stories entry keeps its history; Close steps all of it back', async (t) => {
  setActivePinia(createPinia());
  history.replaceState(
    { gevStories: { story: 'gev:flights-radar', depth: 2, explore: 1 } },
    '',
    '/?story=gev%3Aflights-radar&storyTime=1250',
  );
  const steps = recordGo(t);
  const store = useStoriesStore();
  const controller = createStoriesController({
    viewer: fakeScene().viewer,
    director: fakeDirector(),
    store,
  });
  store.connect(controller, listStories());
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(store.storyId, 'gev:flights-radar');
  assert.equal(store.playback.wallMs, 1250);
  assert.equal(store.playback.playing, false);
  assert.equal(history.state.gevStories.depth, 2, 'no extra entry pushed');
  await controller.close();
  assert.deepEqual(steps, [-2]);
  controller.destroy();
});

test('a new story link puts Explore under the story', async (t) => {
  setActivePinia(createPinia());
  history.replaceState(null, '', '/?story=gev%3Aflights-radar&storyTime=1250');
  const steps = recordGo(t);
  const store = useStoriesStore();
  const controller = createStoriesController({
    viewer: fakeScene().viewer,
    director: fakeDirector(),
    store,
  });
  store.connect(controller, listStories());
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(store.storyId, 'gev:flights-radar');
  assert.equal(store.playback.wallMs, 1250);
  assert.equal(store.playback.playing, false);
  assert.deepEqual(history.state.gevStories, {
    story: 'gev:flights-radar',
    storyTime: 1250,
    depth: 1,
    explore: 0,
  });
  controller.backToExplore();
  assert.deepEqual(steps, [-1]);
  controller.destroy();
});

test('Open in GEV hands a GEV scene to the Scenes panel at its current shot', async () => {
  const { controller, store, director, camera } = setup();
  controller.open();
  controller.openStory('gev:bhote-koshi-nepal-scene');
  store.playback = { ...store.playback, chapterIndex: 0 };
  const shotId =
    store.byId('gev:bhote-koshi-nepal-scene').chapters[0]?.id ?? null;
  await controller.openInGev();
  assert.equal(store.mode, 'closed');
  assert.equal(camera.views.length, 0, 'the globe stays where the story was');
  assert.deepEqual(director.selected, [['bhote-koshi-nepal-scene', shotId]]);
  assert.deepEqual(director.styleManager.panels, [['scene-panel', false]]);
  controller.destroy();
});

const tick = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

test('Close while Back to Explore is landing steps back only the rest of the way', async (t) => {
  const { controller } = setup();
  const steps = recordGo(t);
  controller.open();
  controller.openStory('gev:flights-radar');
  controller.backToExplore();
  controller.close(); // before the Back has landed
  assert.deepEqual(steps, [-1], 'Close waits for the Back to land');
  // The Back lands on the Explore entry.
  history.replaceState(
    { gevStories: { stories: 'explore', depth: 1, explore: 1 } },
    '',
    '/?stories=explore',
  );
  dispatchEvent(new PopStateEvent('popstate'));
  await tick();
  assert.deepEqual(steps, [-1, -1], 'two entries in all, as Stories pushed');
  controller.destroy();
});

test('history steps back only after the scene has torn down', async (t) => {
  const { controller, director } = setup();
  const steps = recordGo(t);
  controller.open();
  controller.openStory('gev:bhote-koshi-nepal-scene');
  director.running = true;
  const closing = controller.close();
  await tick(60);
  assert.deepEqual(steps, [], 'no traversal while the scene is stopping');
  director.running = false;
  await closing;
  assert.deepEqual(steps, [-2]);
  controller.destroy();
});

test('Back out of Stories after a scene puts the share state back directly', async () => {
  const { controller, director } = setup();
  controller.open();
  controller.openStory('gev:bhote-koshi-nepal-scene');
  // Back has already landed on the page Stories opened from.
  await controller.close({ fromHistory: true });
  assert.deepEqual(director.styleManager.shareLinkManager.restored, [
    'v=2&lat=1',
  ]);
  controller.destroy();
});

/** Land a recorded traversal: the page Stories opened from becomes current. */
function land(hash = '#v=2&lat=1') {
  history.replaceState(null, '', `/?x=1${hash}`);
  dispatchEvent(new PopStateEvent('popstate'));
}

test('a second browser Back during scene teardown supersedes the Stories restore', async () => {
  const { controller, director, store, camera } = setup();
  const share = director.styleManager.shareLinkManager;
  const holds = [];
  share.holdWrites = (held) => holds.push(held);
  director.selection = () => ({ sceneId: 'previous', shotId: 'shot-1' });
  controller.open();
  controller.openStory('gev:bhote-koshi-nepal-scene');
  director.running = true;
  land();
  assert.equal(store.mode, 'closed');
  land('#v=2&lat=2');
  director.running = false;
  await tick(0);
  assert.equal(location.hash, '#v=2&lat=2');
  assert.equal(camera.views.length, 0);
  assert.deepEqual(share.restored, []);
  assert.deepEqual(director.selected, []);
  assert.deepEqual(holds, [true, false]);
  assert.equal(document.body.classList.contains('stories-mode'), false);
  controller.destroy();
});

test('Close after a GEV scene puts the share state back once the step back lands', async (t) => {
  const { controller, director } = setup();
  const steps = recordGo(t);
  const restored = director.styleManager.shareLinkManager.restored;
  controller.open();
  controller.openStory('gev:bhote-koshi-nepal-scene');
  await controller.close();
  assert.deepEqual(steps, [-2]);
  assert.deepEqual(restored, [], 'not before the landing');
  assert.equal(document.body.classList.contains('stories-mode'), true);
  land();
  assert.deepEqual(restored, ['v=2&lat=1']);
  assert.equal(document.body.classList.contains('stories-mode'), false);
  controller.destroy();
});

test('Open in GEV steps back over Stories without putting the old view back', async (t) => {
  const share = new ShareLinkManager(
    {},
    {
      camera: {
        on: () => () => {},
        pose: () => ({ lat: 7, lon: 8, height: 1000 }),
      },
    },
  );
  t.after(() => share.destroy());
  const restored = [];
  // The share listener starts before Stories lazy-loads.
  share.watchNavigation((state) => restored.push(state.lat));
  const { controller, director, camera } = setup();
  t.after(() => controller.destroy());
  director.styleManager.shareLinkManager = share;
  const steps = recordGo(t);
  controller.open();
  controller.openStory('gev:bhote-koshi-nepal-scene');
  // Forward into a Stories entry has already let the share listener see
  // its empty hash.
  dispatchEvent(new HashChangeEvent('hashchange'));
  await controller.openInGev();
  assert.deepEqual(steps, [-2], 'Back never reopens Stories');
  land('#v=2&lat=1&lon=2');
  dispatchEvent(new HashChangeEvent('hashchange'));
  assert.deepEqual(restored, []);
  assert.equal(camera.views.length, 0);
  land('#v=2&lat=3&lon=4');
  assert.deepEqual(restored, [3], 'ordinary navigation still restores');
});

test('a drag on the globe while a scene tears down keeps the camera where it went', async () => {
  const { controller, director, camera, canvas } = setup();
  controller.open();
  controller.openStory('gev:bhote-koshi-nepal-scene');
  director.running = true;
  const closing = controller.close();
  canvas.dispatchEvent(new Event('pointerdown'));
  director.running = false;
  await closing;
  assert.equal(camera.views.length, 0, 'no snap back');
  controller.destroy();
});

test('a step back that never lands gives up and runs what was waiting', async (t) => {
  const { controller, store } = setup();
  recordGo(t);
  controller.open();
  controller.openStory('gev:flights-radar');
  await controller.close(); // no popstate will come
  controller.open(); // queued behind the traversal
  assert.equal(store.mode, 'closed');
  await new Promise((resolve) => setTimeout(resolve, 2200));
  assert.equal(store.mode, 'explore', 'opened once the traversal gave up');
  controller.destroy();
});

test('a reloaded Stories entry drops the share hash GEV wrote on boot', async () => {
  setActivePinia(createPinia());
  history.replaceState(
    { gevStories: { stories: 'explore', depth: 1, explore: 1 } },
    '',
    '/?stories=explore&selectedStory=gev%3Aorbital-watch#v=2&lat=7',
  );
  const store = useStoriesStore();
  const controller = createStoriesController({
    viewer: fakeScene().viewer,
    director: fakeDirector(),
    store,
  });
  store.connect(controller, listStories());
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(store.mode, 'explore');
  assert.equal(location.hash, '');
  assert.equal(store.picked, 'gev:orbital-watch');
  assert.equal(
    location.search,
    '?stories=explore&selectedStory=gev%3Aorbital-watch',
  );
  const exploreState = history.state;
  const exploreUrl = location.href;
  controller.openStory('gev:flights-radar');
  assert.equal(location.search, '?story=gev%3Aflights-radar');
  history.replaceState(exploreState, '', exploreUrl);
  dispatchEvent(new PopStateEvent('popstate'));
  assert.equal(store.mode, 'explore');
  assert.equal(store.picked, 'gev:orbital-watch');
  controller.destroy();
});

test('a scene saved to Stories from AUTHORING joins the list at once', () => {
  setActivePinia(createPinia());
  history.replaceState(null, '', '/');
  const store = useStoriesStore();
  const director = fakeDirector();
  let listener = null;
  let mine = [];
  director.subscribe = (fn) => {
    listener = fn;
    return () => (listener = null);
  };
  director.storyScenes = () => mine;
  const controller = createStoriesController({
    viewer: fakeScene().viewer,
    director,
    store,
  });
  store.connect(controller, listStories());
  assert.equal(store.byId('gev:my-scene'), null);
  mine = [
    {
      id: 'my-scene',
      title: 'Harbour at dawn',
      camera: { lat: 51.5, lon: -0.1, alt: 2000, heading: 0, pitch: -30 },
      shotCount: 2,
    },
  ];
  listener({ change: { type: 'stories-changed' } });
  const story = store.byId('gev:my-scene');
  assert.equal(story?.title, 'Harbour at dawn');
  assert.equal(story.mine, true);
  assert.equal(store.stories[0].id, 'gev:my-scene', 'the person’s own first');
  mine = [];
  listener({ change: { type: 'stories-changed' } });
  assert.equal(store.byId('gev:my-scene'), null, 'removed from Stories');
  controller.destroy();
  assert.equal(listener, null, 'unsubscribed');
});

test('Back to Explore after a scene puts the look back once the scene has torn down, then frames Explore', async () => {
  const { controller, director, camera } = setup();
  history.replaceState(null, '', '/');
  const flights = [];
  camera.flyTo = (f) => flights.push(f);
  camera.flyToBounds = (f) => flights.push(f);
  const share = director.styleManager.shareLinkManager;
  const original = 'v=2&lat=1&style=normal';
  share.snapshotHash = () => original;
  // GEV's restore writes the hash it applies; Explore's address drops it.
  share.restore = function (hash) {
    this.restored.push(hash);
    history.replaceState(history.state, '', `${location.search}#${hash}`);
    return true;
  };
  controller.open();
  controller.openStory('gev:bhote-koshi-nepal-scene');
  director.running = true;
  flights.length = 0;
  history.replaceState(
    { gevStories: { stories: 'explore', depth: 1, explore: 1 } },
    '',
    '/?stories=explore',
  );
  dispatchEvent(new PopStateEvent('popstate'));
  await tick(30);
  assert.deepEqual(share.restored, [], 'not under the stopping scene');
  assert.equal(flights.length, 0, 'Explore waits for the scene');
  director.running = false;
  await tick(40);
  assert.deepEqual(share.restored, [original]);
  assert.equal(location.hash, '', 'the address names only Stories');
  assert.equal(flights.length, 1, 'then Explore frames the globe');
  // A later Back to Explore with no scene in between restores nothing more.
  controller.openStory('gev:bhote-koshi-nepal-scene');
  controller.pause();
  controller.backToExplore({ fromHistory: true });
  await tick(40);
  assert.equal(share.restored.length, 2, 'each scene is undone once');
  controller.destroy();
});

test('a story opened while the scene tears down is not undone by the late restore', async () => {
  const { controller, director } = setup();
  controller.open();
  controller.openStory('gev:bhote-koshi-nepal-scene');
  director.running = true;
  controller.backToExplore({ fromHistory: true });
  controller.openStory('gev:flights-radar');
  director.running = false;
  await tick(40);
  assert.deepEqual(director.styleManager.shareLinkManager.restored, []);
  controller.destroy();
});

test('a tap pauses a story whose camera move stopped on the press', async () => {
  setActivePinia(createPinia());
  history.replaceState(null, '', '/?x=1#v=2&lat=1');
  const store = useStoriesStore();
  const scene = fakeScene();
  const { canvas } = scene;
  // As in the app, the director listens for the press before Stories does,
  // and stopping its run publishes a stopped clock at once.
  canvas.addEventListener('pointerdown', () => {
    store.playback = { ...store.playback, playing: false };
  });
  const director = fakeDirector();
  const controller = createStoriesController({
    viewer: scene.viewer,
    director,
    store,
    clock: fakeClock(),
  });
  store.connect(controller, listStories());
  controller.openStory('gev:flights-radar');
  await tick(20);
  let starts = 0;
  director.startScene = async () => {
    starts += 1;
    return { started: true };
  };
  store.playback = { ...store.playback, playing: true };
  canvas.dispatchEvent(new Event('pointerdown'));
  assert.equal(store.playback.playing, false, 'the press stopped the run');
  canvas.dispatchEvent(new Event('pointerup'));
  await tick(20);
  assert.equal(starts, 0, 'the tap does not play it again');
  assert.equal(store.bigPlay, true, 'it pauses');
  // A tap on a paused story plays it.
  canvas.dispatchEvent(new Event('pointerdown'));
  canvas.dispatchEvent(new Event('pointerup'));
  await tick(20);
  assert.equal(starts, 1);
  controller.destroy();
});

test('Explore tours from story to story once idle, stops on a pick or a touch, and on Close', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { controller, store, camera, canvas } = setup();
  const flights = [];
  camera.flyTo = (f) => flights.push(f);
  camera.flyToBounds = (f) => flights.push(f);
  controller.open();
  assert.equal(flights.length, 1, 'the fly-in to the first story');
  t.mock.timers.tick(7000);
  assert.equal(flights.length, 1, 'a moment on the first story');
  t.mock.timers.tick(1000);
  assert.equal(flights.length, 2, 'then on to the next');
  t.mock.timers.tick(8500);
  assert.equal(flights.length, 3, 'and the next');
  // A press holds the tour however long the drag lasts; letting go starts
  // the wait again.
  canvas.dispatchEvent(new Event('pointerdown'));
  t.mock.timers.tick(20000);
  assert.equal(flights.length, 3, 'nothing flies under a drag');
  canvas.dispatchEvent(new Event('pointerup'));
  t.mock.timers.tick(5000);
  assert.equal(flights.length, 3);
  t.mock.timers.tick(1500);
  assert.equal(flights.length, 4);
  // A picked story stops it.
  controller.pick(store.stories[0].id);
  const picked = flights.length;
  t.mock.timers.tick(30000);
  assert.equal(flights.length, picked);
  // Unpicked, it tours again, for a minute at most.
  controller.pick(null);
  for (let i = 0; i < 24; i++) t.mock.timers.tick(5000);
  const after = flights.length;
  assert.ok(after > picked + 3, 'touring again');
  for (let i = 0; i < 12; i++) t.mock.timers.tick(5000);
  assert.equal(flights.length, after, 'stopped on its own');
  controller.pick(null);
  controller.destroy();
});

test('a new Explore link keeps the address free of the share hash GEV writes as Stories opens', async () => {
  setActivePinia(createPinia());
  history.replaceState(
    null,
    '',
    '/?stories=explore&selectedStory=gev%3Aorbital-watch',
  );
  const store = useStoriesStore();
  const director = fakeDirector();
  const playbackCalls = [];
  director.startScene = () => playbackCalls.push('start');
  director.seekScene = () => playbackCalls.push('seek');
  // Holding writes first writes the view change still waiting.
  director.styleManager.shareLinkManager.holdWrites = (held) => {
    if (held) history.replaceState(history.state, '', `${location.search}#v=2`);
  };
  const controller = createStoriesController({
    viewer: fakeScene().viewer,
    director,
    store,
  });
  store.connect(controller, listStories());
  await tick(400);
  assert.equal(store.mode, 'explore');
  assert.equal(location.hash, '');
  assert.equal(
    location.search,
    '?stories=explore&selectedStory=gev%3Aorbital-watch',
  );
  assert.equal(store.picked, 'gev:orbital-watch');
  assert.equal(store.storyId, null);
  assert.deepEqual(playbackCalls, []);
  controller.destroy();
});

test('a saved scene’s topics become Explore chips, and its captured card image is used', async () => {
  const { metaFor, topicsOf } = await import('./storyMeta.js');
  setActivePinia(createPinia());
  history.replaceState(null, '', '/');
  const store = useStoriesStore();
  const director = fakeDirector();
  director.subscribe = () => () => {};
  director.storyScenes = () => [
    {
      id: 'harbour',
      title: 'Harbour at dawn',
      camera: { lat: 51.5, lon: -0.1, alt: 2000 },
      shotCount: 1,
      thumb: 'data:image/jpeg;base64,BBBB',
      tags: ['Maritime', 'Floods'],
    },
  ];
  const controller = createStoriesController({
    viewer: fakeScene().viewer,
    director,
    store,
  });
  store.connect(controller, listStories());
  const story = store.byId('gev:harbour');
  assert.deepEqual(metaFor(story).topics, ['Maritime', 'Floods']);
  const chips = topicsOf(store.stories);
  assert.ok(chips.includes('Maritime') && chips.includes('Floods'));
  assert.ok(
    chips.indexOf('Floods') < chips.indexOf('Maritime'),
    'in AUTHORING’s tag order',
  );
  controller.open();
  await tick(20);
  assert.equal(store.thumbs['gev:harbour'], 'data:image/jpeg;base64,BBBB');
  controller.destroy();
});

test('Close after a story puts AUTHORING’s own selection back; Open in GEV keeps the story’s', async () => {
  const { controller, director } = setup();
  director.selection = () => ({ sceneId: null, shotId: null });
  controller.open();
  controller.openStory('gev:flights-radar');
  await controller.close({ fromHistory: true });
  assert.deepEqual(director.selected.at(-1), [null, null], 'back to none');
  director.selected.length = 0;
  controller.open();
  controller.openStory('gev:flights-radar');
  await controller.openInGev();
  assert.deepEqual(
    director.selected.map(([sceneId]) => sceneId),
    ['flights-radar'],
    'the story’s scene, nothing put back',
  );
  controller.destroy();
});

test('a built-in scene no longer in the project does not list; an unknown story link says so', async () => {
  setActivePinia(createPinia());
  history.replaceState(null, '', '/?story=gev%3Asomeone-elses');
  const store = useStoriesStore();
  const director = fakeDirector();
  director.hasScene = (id) => id !== 'flights-radar';
  const toasts = [];
  store.flashToast = (text) => toasts.push(text);
  const controller = createStoriesController({
    viewer: fakeScene().viewer,
    director,
    store,
  });
  store.connect(controller, listStories());
  assert.equal(store.byId('gev:flights-radar'), null);
  assert.ok(store.byId('gev:orbital-watch'));
  await tick(400);
  assert.equal(store.mode, 'explore');
  assert.equal(toasts.length, 1, 'the person is told');
  controller.destroy();
  assert.equal(document.body.classList.contains('stories-mode'), false);
});

test('Close after Back to Explore still puts AUTHORING’s selection back', async () => {
  const { controller, director } = setup();
  director.selection = () => ({ sceneId: null, shotId: null });
  controller.open();
  controller.openStory('gev:flights-radar');
  controller.backToExplore({ fromHistory: true });
  await tick(40);
  await controller.close({ fromHistory: true });
  assert.deepEqual(director.selected.at(-1), [null, null]);
  controller.destroy();
});

test('Back into the entry of a deleted story, with Stories closed, clears ?story=', () => {
  const { controller, store } = setup();
  assert.equal(store.mode, 'closed');
  history.replaceState(
    { gevStories: { story: 'gev:gone', depth: 2, explore: 1 } },
    '',
    '/?story=gev%3Agone&storyTime=12#lat=1',
  );
  dispatchEvent(new PopStateEvent('popstate'));
  assert.equal(store.mode, 'closed', 'nothing opens');
  const url = new URL(location.href);
  assert.equal(url.searchParams.has('story'), false);
  assert.equal(url.searchParams.has('storyTime'), false);
  assert.equal(url.hash, '#lat=1', 'the globe state stays');
  assert.equal(history.state?.gevStories, undefined);
  controller.destroy();
});

for (const [from, enter] of [
  ['Explore', (controller) => controller.open()],
  ['an open story', (controller) => controller.openStory('gev:flights-radar')],
]) {
  test(`Back into the entry of a deleted story, from ${from}, clears ?story=`, () => {
    const { controller, store } = setup();
    enter(controller);
    assert.notEqual(store.mode, 'closed');
    history.replaceState(
      { gevStories: { story: 'gev:gone', depth: 2, explore: 1 } },
      '',
      '/?story=gev%3Agone&storyTime=12#lat=1',
    );
    dispatchEvent(new PopStateEvent('popstate'));
    const url = new URL(location.href);
    assert.equal(url.searchParams.has('story'), false);
    assert.equal(url.searchParams.has('storyTime'), false);
    assert.equal(url.hash, '#lat=1', 'the globe state stays');
    assert.equal(history.state?.gevStories?.story, undefined);
    controller.destroy();
  });
}

test('Back into an Explore entry naming a deleted story keeps Explore', () => {
  const { controller, store } = setup();
  controller.openStory('gev:flights-radar');
  history.replaceState(
    { gevStories: { story: 'gev:gone', depth: 1, explore: 1 } },
    '',
    '/?stories=explore&story=gev%3Agone#lat=1',
  );
  dispatchEvent(new PopStateEvent('popstate'));
  const url = new URL(location.href);
  assert.equal(url.searchParams.get('stories'), 'explore');
  assert.equal(url.searchParams.has('story'), false);
  assert.equal(url.hash, '#lat=1');
  assert.equal(history.state?.gevStories?.depth, 1);
  assert.equal(history.state?.gevStories?.story, undefined);
  assert.equal(store.mode, 'explore');
  controller.destroy();
});

test('unsaved scenes appear as local drafts and disappear when deleted', () => {
  setActivePinia(createPinia());
  history.replaceState(null, '', '/');
  const store = useStoriesStore();
  const director = fakeDirector();
  const drafts = [
    {
      id: 'sketch',
      title: 'Sketch',
      camera: { lat: 1, lon: 2, alt: 3000 },
      shotCount: 1,
      thumb: '',
      tags: [],
    },
  ];
  const channel = createStateChannel(() => ({ scenes: drafts }));
  director.subscribe = channel.subscribe;
  director.draftScenes = () => drafts;
  const controller = createStoriesController({
    viewer: fakeScene().viewer,
    director,
    store,
  });
  store.connect(controller, listStories());
  const draft = store.byId('gev:sketch');
  assert.equal(draft?.draft, true);
  assert.equal(draft.mine, true, 'local only: no Share');
  drafts.length = 0;
  channel.publish({ type: 'scene-deleted' });
  controller.open();
  assert.equal(store.byId('gev:sketch'), null);
  controller.destroy();
});

test('under imagery other than Esri, a card drawn from Esri earlier is dropped', async () => {
  const { controller, director, store } = setup();
  director.styleManager.mapStackController = { getActiveId: () => 'osm' };
  store.thumbs = { 'gev:flights-radar': 'data:image/jpeg;base64,ESRI' };
  controller.open();
  await tick(20);
  assert.equal(store.thumbs['gev:flights-radar'], undefined);
  controller.destroy();
});

test('the tour waits again after a wheel turn or a cancelled press, and a list change during a drag does not restart it', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { controller, viewer, director, camera, canvas } = setup();
  let listener = null;
  director.subscribe = (fn) => ((listener = fn), () => {});
  const flights = [];
  camera.flyTo = (f) => flights.push(f);
  camera.flyToBounds = (f) => flights.push(f);
  controller.destroy();
  const store = useStoriesStore();
  const again = createStoriesController({ viewer, director, store });
  store.connect(again, listStories());
  again.open();
  for (const type of ['wheel', 'pointercancel']) {
    const before = flights.length;
    canvas.dispatchEvent(new Event(type));
    t.mock.timers.tick(5900);
    assert.equal(flights.length, before, `${type}: waits`);
    t.mock.timers.tick(200);
    assert.equal(flights.length, before + 1, `${type}: then tours`);
  }
  canvas.dispatchEvent(new Event('pointerdown'));
  listener({ change: { type: 'stories-changed' } });
  const held = flights.length;
  t.mock.timers.tick(30000);
  assert.equal(flights.length, held, 'nothing flies under the drag');
  again.destroy();
});

test('teardown mid-close releases share writes and cancels a queued reopen', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { controller, director, store, camera } = setup();
  recordGo(t);
  const held = [];
  director.styleManager.shareLinkManager.holdWrites = (on) => held.push(on);
  let flights = 0;
  camera.flyTo = () => flights++;
  controller.open();
  await controller.close();
  controller.open(); // queued until the Close traversal lands
  controller.destroy();
  const before = flights;
  assert.equal(held.at(-1), false);
  t.mock.timers.tick(3000);
  assert.equal(store.mode, 'closed');
  assert.equal(held.at(-1), false, 'no late reopen holds writes again');
  assert.equal(flights, before, 'no late flight after teardown');
});

test('place names name only a shipped scene’s untitled shots', () => {
  const { controller, director, store } = setup();
  director.listShots = () => [
    { id: 'a', title: 'Shot 1', startSec: 0, durationSec: 5 },
    { id: 'b', title: 'Over the harbour', startSec: 5, durationSec: 5 },
  ];
  controller.openStory('gev:flights-radar');
  const story = store.byId('gev:flights-radar');
  assert.deepEqual(
    story.chapters.map((c) => c.title),
    ['The Atlantic', 'Over the harbour'],
  );
  controller.destroy();
});

test('new navigation cancels a delayed initial story link', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const action of ['back', 'open', 'close']) {
    setActivePinia(createPinia());
    history.replaceState(null, '', '/?story=gev%3Aflights-radar');
    const store = useStoriesStore();
    const controller = createStoriesController({
      viewer: fakeScene().viewer,
      director: fakeDirector(),
      store,
    });
    store.connect(controller, listStories());
    try {
      if (action === 'back') land();
      else if (action === 'open') controller.open();
      else controller.close();
      const url = location.href;
      t.mock.timers.tick(400);
      assert.equal(
        store.mode,
        action === 'open' ? 'explore' : 'closed',
        action,
      );
      assert.equal(store.storyId, null, action);
      assert.equal(
        location.href,
        url,
        'the old link does not rewrite navigation',
      );
    } finally {
      controller.destroy();
    }
  }
});

test('an earlier Back timeout cannot release a later traversal', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { controller, store } = setup();
  const steps = recordGo(t);
  const landExplore = () => {
    history.replaceState(
      { gevStories: { stories: 'explore', depth: 1, explore: 1 } },
      '',
      '/?stories=explore',
    );
    dispatchEvent(new PopStateEvent('popstate'));
  };
  try {
    controller.open();
    controller.openStory('gev:flights-radar');
    controller.backToExplore();
    landExplore();
    t.mock.timers.tick(1500);
    controller.openStory('gev:orbital-watch');
    controller.backToExplore();
    controller.close();
    t.mock.timers.tick(600);
    assert.equal(store.mode, 'story', 'Close still waits for the second Back');
    assert.deepEqual(steps, [-1, -1]);
    landExplore();
    // Drain the director's already-idle promise without advancing timers.
    for (let i = 0; i < 12; i++) await Promise.resolve();
    assert.equal(store.mode, 'closed');
    assert.deepEqual(
      steps,
      [-1, -1, -1],
      'queued Close runs once after landing',
    );
  } finally {
    controller.destroy();
  }
});

test('Explore’s pins follow the camera on every frame drawn, moved in place', () => {
  const { controller, store, frame, query } = setup();
  controller.open();
  assert.equal(frame.listeners.size, 1, 'one postRender listener');
  frame.draw();
  const pins = store.pins;
  assert.equal(pins.length, store.stories.length);
  assert.ok(pins.every((pin) => pin.visible));
  // Vue renders the pins once; a move alone writes each pin's transform.
  const layer = document.createElement('div');
  layer.id = 'pins';
  for (const pin of pins) {
    const el = document.createElement('div');
    el.className = 'pin';
    el.dataset.id = pin.id;
    layer.append(el);
  }
  document.body.append(layer);
  try {
    query.project = ({ x, y }) => ({ x: x / 1e5 + 40, y: y / 1e5 + 10 });
    frame.draw();
    assert.equal(store.pins, pins, 'the same pins: no Vue render');
    const first = layer.querySelector(`.pin[data-id="${pins[0].id}"]`);
    assert.match(first.style.transform, /^translate\(/);
    // A pin going behind the horizon changes the set: Vue renders it.
    let once = true;
    query.isOccluded = () => {
      const behind = once;
      once = false;
      return behind;
    };
    frame.draw();
    assert.notEqual(store.pins, pins);
    assert.equal(store.pins[0].visible, false);
  } finally {
    layer.remove();
    controller.close();
  }
  assert.equal(frame.listeners.size, 0, 'no frame work once Stories closes');
  controller.destroy();
});

test('Explore frames country level straight down, a picked story at −60°, and tiles settle for at most 10 s', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { controller, store, camera, frame, globe } = setup();
  controller.open();
  const open = camera.flights.at(-1);
  assert.equal(open.destination.height, 2.5e6);
  assert.deepEqual(open.orientation, {
    heading: 0,
    pitch: -Math.PI / 2,
    roll: 0,
  });
  controller.pick(store.stories[0].id);
  const picked = camera.flights.at(-1);
  assert.equal(picked.sphere.radius, 0);
  assert.equal(picked.offset.heading, 0);
  assert.ok(Math.abs(picked.offset.pitch + Math.PI / 3) < 1e-12);
  assert.ok(picked.offset.range >= 60000 && picked.offset.range <= 4e6);
  // Landing keeps frames coming until the globe has settled...
  picked.onComplete();
  assert.equal(frame.listeners.size, 2, 'pins and settling');
  frame.draw();
  assert.equal(frame.listeners.size, 2, 'not settled yet');
  globe.settled = true;
  frame.draw();
  assert.equal(frame.listeners.size, 1, 'settled: only the pins listen');
  assert.ok(!holds().includes('stories-tiles'), 'settled: the hold is let go');
  // ...and for 10 s at most.
  globe.settled = false;
  picked.onComplete();
  assert.equal(frame.listeners.size, 2);
  assert.ok(holds().includes('stories-tiles'), 'frames held while settling');
  t.mock.timers.tick(10000);
  assert.equal(frame.listeners.size, 1, 'given up after 10 s');
  assert.ok(!holds().includes('stories-tiles'), 'given up: the hold is let go');
  // Close lets go of a hold still waiting.
  picked.onComplete();
  assert.ok(holds().includes('stories-tiles'));
  controller.destroy();
  assert.ok(!holds().includes('stories-tiles'), 'closed: the hold is let go');
});

test('Close puts back the world clock the person had, and the camera readout follows a story', async () => {
  const clock = fakeClock({
    live: false,
    playing: false,
    timeMs: Date.UTC(2025, 5, 1),
  });
  const { controller, store, frame, camera } = setup({ clock });
  controller.open();
  controller.openStory('gev:bhote-koshi-nepal-scene');
  frame.draw();
  assert.deepEqual(store.camera, { lat: 28.65, lon: 11.46, altKm: 2000 });
  // A scene moved the world clock.
  clock.state = { ...clock.state, live: true, jumps: clock.state.jumps + 1 };
  await controller.close();
  assert.equal(camera.views.length, 1);
  assert.deepEqual(clock.calls, [['pause'], ['seek', Date.UTC(2025, 5, 1)]]);
  // A clock left where it was is not touched.
  clock.calls.length = 0;
  controller.open();
  await controller.close();
  assert.deepEqual(clock.calls, []);
  controller.destroy();
});

test('Close puts a live clock back live, and a playing clock plays on from where it would be', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  // Live: a scene seeked the clock; Close goes live again.
  const live = fakeClock({ live: true });
  const a = setup({ clock: live });
  a.controller.open();
  live.seek(Date.UTC(2020, 0, 1));
  live.calls.length = 0;
  const closingA = a.controller.close({ fromHistory: true });
  t.mock.timers.tick(100);
  await closingA;
  assert.deepEqual(live.calls, [['goLive']]);
  a.controller.destroy();
  // Playing at 2×: paused by a scene; Close seeks to where it would be
  // after the time Stories was open, and plays on at its rate.
  const playing = fakeClock({
    live: false,
    playing: true,
    rate: 2,
    timeMs: Date.UTC(2025, 0, 1),
  });
  const b = setup({ clock: playing });
  b.controller.open();
  playing.pause();
  playing.seek(Date.UTC(2019, 0, 1));
  playing.calls.length = 0;
  t.mock.timers.tick(5000);
  const closingB = b.controller.close({ fromHistory: true });
  t.mock.timers.tick(100);
  await closingB;
  const seek = playing.calls.find(([name]) => name === 'seek');
  assert.ok(
    Math.abs(seek[1] - (Date.UTC(2025, 0, 1) + 5100 * 2)) <= 200,
    'extrapolated by the time away at its rate',
  );
  assert.deepEqual(playing.calls.at(-1), [
    'play',
    { rate: 2, continuous: true },
  ]);
  b.controller.destroy();
});

test('a playing clock nothing moved is left alone on Close, even if it fell behind', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  const clock = fakeClock({
    live: false,
    playing: true,
    rate: 1,
    timeMs: Date.UTC(2025, 0, 1),
  });
  const { controller } = setup({ clock });
  controller.open();
  // Held by buffering: no jump, same mode and rate, but behind the wall.
  t.mock.timers.tick(30000);
  const closing = controller.close({ fromHistory: true });
  t.mock.timers.tick(100);
  await closing;
  assert.deepEqual(clock.calls, []);
  controller.destroy();
});

test('the clock comes back after the share state on Close, so a shared paused time does not stop a playing clock', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  const clock = fakeClock({
    live: false,
    playing: true,
    rate: 1,
    timeMs: Date.UTC(2025, 0, 1),
  });
  const { controller, director } = setup({ clock });
  // The share state arrives with its world time paused.
  director.styleManager.shareLinkManager.restore = () => {
    clock.pause();
    clock.seek(Date.UTC(2025, 0, 1));
    return true;
  };
  controller.open();
  controller.openStory('gev:bhote-koshi-nepal-scene');
  clock.pause();
  const closing = controller.close({ fromHistory: true });
  t.mock.timers.tick(100);
  await closing;
  assert.equal(clock.state.playing, true, 'playing again after the share');
  controller.destroy();
});

test('Explore aims a story at the middle of the visible map, not of the canvas', () => {
  const { controller, store, camera, canvas } = setup();
  canvas.getBoundingClientRect = () => ({
    left: 0,
    top: 0,
    width: 400,
    height: 800,
  });
  // Explore's map is the top half of an 800 px canvas (a phone's sheet
  // below it).
  const root = document.createElement('div');
  root.id = 'gev-stories';
  const map = document.createElement('div');
  map.className = 'ex-map';
  root.append(map);
  document.body.append(root);
  map.getBoundingClientRect = () => ({
    left: 0,
    top: 0,
    width: 400,
    height: 400,
  });
  controller.open();
  const story = store.stories[0];
  controller.pick(null);
  const flight = camera.flights.at(-1);
  const { lat } = story.area ?? story.cover;
  assert.ok(
    flight.destination.lat < lat,
    'aims south, so the story shows above the sheet',
  );
  root.remove();
  controller.destroy();
});
