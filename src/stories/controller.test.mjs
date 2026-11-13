// The Stories controller: what it leaves behind in history and on GEV's
// globe when Stories opens and closes.
import '../testSupport/registerDom.mjs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { createPinia, setActivePinia } from 'pinia';
import { createStateChannel } from '../app/stateChannel.js';

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

function fakeViewer() {
  const position = new Cesium.Cartesian3(1, 2, 3);
  return {
    scene: {
      canvas: document.createElement('canvas'),
      postRender: { addEventListener: () => () => {} },
      preRender: {
        listeners: new Set(),
        addEventListener(fn) {
          this.listeners.add(fn);
          return () => this.listeners.delete(fn);
        },
      },
    },
    camera: {
      positionWC: position,
      positionCartographic: { latitude: 0.5, longitude: 0.2, height: 2e6 },
      heading: 0,
      pitch: -1,
      roll: 0,
      views: [],
      setView(v) {
        this.views.push(v);
      },
      cancelFlight() {},
      flyTo() {},
      flyToBoundingSphere() {},
      rotations: 0,
      rotate() {
        this.rotations += 1;
      },
    },
    clock: {
      currentTime: Cesium.JulianDate.fromDate(new Date(Date.UTC(2026, 0, 1))),
      shouldAnimate: false,
    },
    trackedEntity: undefined,
  };
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
  const viewer = fakeViewer();
  const director = fakeDirector(options);
  const controller = createStoriesController({
    viewer,
    director,
    store,
    onEnter: options.onEnter,
  });
  store.connect(controller, listStories());
  return { store, viewer, director, controller };
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
  const { controller, viewer, director, store } = setup();
  const before = viewer.camera.positionWC;
  controller.open();
  controller.openStory('gev:bhote-koshi-nepal-scene');
  director.running = true;
  const toast = store.hostedToast;
  const closing = controller.openInGev();
  // The scene has moved the camera; the person opens Stories again at once.
  viewer.camera.positionWC = new Cesium.Cartesian3(9, 9, 9);
  controller.open();
  director.running = false;
  await closing;
  assert.deepEqual(director.selected, []);
  assert.deepEqual(director.styleManager.panels, []);
  assert.equal(store.hostedToast, toast);
  assert.equal(
    viewer.camera.views.length,
    0,
    'no restore under the reopened Stories',
  );
  await controller.close();
  const { x, y, z } = viewer.camera.views.at(-1).destination;
  assert.deepEqual({ x, y, z }, { x: before.x, y: before.y, z: before.z });
  controller.destroy();
});

test('after a GEV scene, the person’s view comes back once the scene has torn down', async () => {
  const { controller, viewer, director } = setup();
  controller.open();
  controller.openStory('gev:bhote-koshi-nepal-scene');
  director.running = true;
  const closing = controller.close();
  assert.equal(viewer.camera.views.length, 0, 'not under the stopping scene');
  setTimeout(() => (director.running = false), 120);
  await closing;
  assert.equal(viewer.camera.views.length, 1);
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

test('a second Close after a quick reopen still waits for the scene to tear down', async () => {
  const { controller, viewer, director } = setup();
  controller.open();
  controller.openStory('gev:bhote-koshi-nepal-scene');
  director.running = true;
  const first = controller.close({ keepCamera: true });
  controller.open(); // reopened while the scene is still stopping
  const closing = controller.close(); // Explore: no GEV story on screen
  assert.ok(closing, 'this Close waits too');
  assert.equal(viewer.camera.views.length, 0, 'nothing restored yet');
  setTimeout(() => (director.running = false), 120);
  await Promise.all([first, closing]);
  assert.equal(viewer.camera.views.length, 1);
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
    viewer: fakeViewer(),
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
    viewer: fakeViewer(),
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
  const { controller, store, director, viewer } = setup();
  controller.open();
  controller.openStory('gev:bhote-koshi-nepal-scene');
  store.playback = { ...store.playback, chapterIndex: 0 };
  const shotId =
    store.byId('gev:bhote-koshi-nepal-scene').chapters[0]?.id ?? null;
  await controller.openInGev();
  assert.equal(store.mode, 'closed');
  assert.equal(
    viewer.camera.views.length,
    0,
    'the globe stays where the story was',
  );
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
  const { controller, director, store, viewer } = setup();
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
  assert.equal(viewer.camera.views.length, 0);
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
  const { controller, director, viewer } = setup();
  const steps = recordGo(t);
  controller.open();
  controller.openStory('gev:bhote-koshi-nepal-scene');
  await controller.openInGev();
  assert.deepEqual(steps, [-2], 'Back never reopens Stories');
  land();
  assert.deepEqual(director.styleManager.shareLinkManager.restored, []);
  assert.equal(viewer.camera.views.length, 0);
  controller.destroy();
});

test('a drag on the globe while a scene tears down keeps the camera where it went', async () => {
  const { controller, viewer, director } = setup();
  controller.open();
  controller.openStory('gev:bhote-koshi-nepal-scene');
  director.running = true;
  const closing = controller.close();
  viewer.scene.canvas.dispatchEvent(new Event('pointerdown'));
  director.running = false;
  await closing;
  assert.equal(viewer.camera.views.length, 0, 'no snap back');
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
    viewer: fakeViewer(),
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
    viewer: fakeViewer(),
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
  const { controller, viewer, director } = setup();
  history.replaceState(null, '', '/');
  const flights = [];
  viewer.camera.flyTo = (f) => flights.push(f);
  viewer.camera.flyToBoundingSphere = (f) => flights.push(f);
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

test('Explore tours from story to story once idle, stops on a pick or a touch, and on Close', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { controller, viewer, store } = setup();
  const flights = [];
  viewer.camera.flyTo = (f) => flights.push(f);
  viewer.camera.flyToBoundingSphere = (f) => flights.push(f);
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
  viewer.scene.canvas.dispatchEvent(new Event('pointerdown'));
  t.mock.timers.tick(20000);
  assert.equal(flights.length, 3, 'nothing flies under a drag');
  viewer.scene.canvas.dispatchEvent(new Event('pointerup'));
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
    viewer: fakeViewer(),
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
    viewer: fakeViewer(),
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
    viewer: fakeViewer(),
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
    viewer: fakeViewer(),
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
  const { controller, viewer, store } = setup();
  viewer.imageryLayers = {
    get: () => ({
      imageryProvider: { url: 'https://tile.openstreetmap.org/' },
    }),
  };
  store.thumbs = { 'gev:flights-radar': 'data:image/jpeg;base64,ESRI' };
  controller.open();
  await tick(20);
  assert.equal(store.thumbs['gev:flights-radar'], undefined);
  controller.destroy();
});

test('the tour waits again after a wheel turn or a cancelled press, and a list change during a drag does not restart it', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { controller, viewer, director } = setup();
  let listener = null;
  director.subscribe = (fn) => ((listener = fn), () => {});
  const flights = [];
  viewer.camera.flyTo = (f) => flights.push(f);
  viewer.camera.flyToBoundingSphere = (f) => flights.push(f);
  controller.destroy();
  const store = useStoriesStore();
  const again = createStoriesController({ viewer, director, store });
  store.connect(again, listStories());
  again.open();
  const canvas = viewer.scene.canvas;
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
  const { controller, director, store, viewer } = setup();
  recordGo(t);
  const held = [];
  director.styleManager.shareLinkManager.holdWrites = (on) => held.push(on);
  let flights = 0;
  viewer.camera.flyTo = () => flights++;
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
      viewer: fakeViewer(),
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
