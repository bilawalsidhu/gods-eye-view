import test from 'node:test';
import assert from 'node:assert/strict';
import { createWeatherRendering } from './rendering.js';
import { createWeatherLayer } from './index.js';

const times = [
  '2026-09-15T20:00:00.000Z',
  '2026-09-15T20:05:00.000Z',
  '2026-09-15T20:10:00.000Z',
];
const snapshot = {
  product: 'radar',
  times,
  latest: times[2],
  bounds: { west: -130, south: 20, east: -60, north: 55 },
};
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};
function event() {
  const listeners = new Set();
  return {
    addEventListener(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    emit(...args) {
      for (const fn of [...listeners]) fn(...args);
    },
    get size() {
      return listeners.size;
    },
  };
}
function target(extra = {}) {
  const listeners = new Map();
  return {
    ...extra,
    addEventListener(name, fn) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name).add(fn);
    },
    removeEventListener(name, fn) {
      listeners.get(name)?.delete(fn);
    },
    emit(name) {
      for (const fn of [...(listeners.get(name) || [])]) fn();
    },
    get size() {
      return [...listeners.values()].reduce(
        (sum, entries) => sum + entries.size,
        0,
      );
    },
  };
}
function renderingHarness(options = {}) {
  const layers = [];
  const providers = [];
  const postRender = event();
  let renderRequests = 0;
  class Provider {
    constructor(options) {
      this.options = options;
      this.errorEvent = event();
      this.response = null;
      providers.push(this);
    }
    requestImage() {
      return this.response?.promise;
    }
  }
  const collection = {
    addImageryProvider(provider) {
      const layer = { imageryProvider: provider, alpha: 1, show: true };
      layers.push(layer);
      return layer;
    },
    contains(layer) {
      return layers.includes(layer);
    },
    remove(layer, destroy) {
      const index = layers.indexOf(layer);
      if (index < 0) return false;
      layers.splice(index, 1);
      layer.destroyed = destroy;
      return true;
    },
    get length() {
      return layers.length;
    },
    get(index) {
      return layers[index];
    },
    lower(layer) {
      const i = layers.indexOf(layer);
      if (i > 0) [layers[i - 1], layers[i]] = [layers[i], layers[i - 1]];
    },
    raiseToTop(layer) {
      const i = layers.indexOf(layer);
      if (i >= 0) layers.push(...layers.splice(i, 1));
    },
    isDestroyed: () => false,
  };
  const viewer = {
    clock: { untouched: true },
    imageryLayers: collection,
    scene: {
      postRender,
      globe: { tilesLoaded: true },
      requestRender() {
        renderRequests++;
      },
    },
  };
  const cesium = {
    UrlTemplateImageryProvider: Provider,
    GeographicTilingScheme: class {
      constructor(options) {
        this.options = options;
      }
    },
    Credit: class {},
    Rectangle: { fromDegrees: (...values) => values },
  };
  const rendering = createWeatherRendering({ viewer, cesium, ...options });
  const settle = () => {
    postRender.emit();
    postRender.emit();
  };
  return {
    rendering,
    viewer,
    providers,
    layers,
    postRender,
    settle,
    renders: () => renderRequests,
  };
}

test('a ready weather frame does not wait for unrelated terrain, but requires successful quiet tiles', async () => {
  let now = 0;
  const h = renderingHarness({ now: () => now });
  h.viewer.scene.globe.tilesLoaded = false;
  const loaded = h.rendering.setFrame(snapshot, times[0]);
  h.settle();
  assert.equal(
    h.rendering.getDiagnostics().loading,
    true,
    'no successful tiles is not ready',
  );
  const tile = deferred();
  h.providers[0].response = tile;
  const request = h.providers[0].requestImage(0, 0, 0, {});
  tile.resolve({});
  await request;
  now = 199;
  h.settle();
  assert.equal(
    h.rendering.getDiagnostics().loading,
    true,
    'scheduler quiet interval is required',
  );
  h.providers[0].response = null;
  assert.equal(h.providers[0].requestImage(1, 0, 0, {}), undefined);
  now = 500;
  h.settle();
  assert.equal(
    h.rendering.getDiagnostics().loading,
    true,
    'a scheduler-deferred own tile prevents premature commit',
  );
  const delayed = deferred();
  h.providers[0].response = delayed;
  const admitted = h.providers[0].requestImage(1, 0, 0, {});
  delayed.resolve({});
  await admitted;
  now = 701;
  h.settle();
  assert.equal(await loaded, true);
  assert.equal(h.rendering.getDiagnostics().loadedTiles, 2);
  assert.equal(h.rendering.getDiagnostics().frameLoadMs, 701);
  h.rendering.clear();
});

test('camera movement drops abandoned deferred tiles but still waits for admitted requests', async () => {
  let now = 0;
  const h = renderingHarness({ now: () => now });
  const moveEnd = event();
  h.viewer.camera = { moveEnd };
  h.viewer.scene.globe.tilesLoaded = false;
  const stage = h.rendering.setFrame(snapshot, times[0]);
  assert.equal(moveEnd.size, 1);
  const provider = h.providers[0];
  const first = deferred();
  provider.response = first;
  const firstRequest = provider.requestImage(0, 0, 0, {});
  first.resolve({});
  await firstRequest;
  provider.response = null;
  assert.equal(provider.requestImage(1, 0, 0, {}), undefined);
  const pending = deferred();
  provider.response = pending;
  const admitted = provider.requestImage(2, 0, 0, {});
  assert.equal(h.rendering.getDiagnostics().deferredTiles, 1);
  assert.equal(h.rendering.getDiagnostics().pendingTiles, 1);
  now = 500;
  moveEnd.emit();
  assert.equal(
    h.rendering.getDiagnostics().deferredTiles,
    0,
    'an unadmitted tile abandoned by the old viewport no longer blocks the stage',
  );
  assert.equal(
    h.rendering.getDiagnostics().pendingTiles,
    1,
    'camera movement does not erase admitted request ownership',
  );
  now = 800;
  h.settle();
  assert.equal(h.rendering.getDiagnostics().loading, true);
  assert.equal(
    h.layers[0].alpha,
    0,
    'the new observation stays invisible while a request is pending',
  );
  pending.resolve({});
  await admitted;
  now = 999;
  h.settle();
  assert.equal(
    h.rendering.getDiagnostics().loading,
    true,
    'completion starts a new quiet interval',
  );
  now = 1000;
  h.postRender.emit();
  assert.equal(
    h.rendering.getDiagnostics().loading,
    true,
    'commit still requires two settled renders',
  );
  h.postRender.emit();
  assert.equal(await stage, true);
  assert.equal(h.rendering.getDiagnostics().loadedTiles, 2);
  assert.equal(h.rendering.getDiagnostics().time, times[0]);
  assert.equal(
    moveEnd.size,
    0,
    'committing releases the stage camera listener',
  );
  const abandoned = h.rendering.setFrame(snapshot, times[1]);
  assert.equal(moveEnd.size, 1);
  h.rendering.clear();
  assert.equal(await abandoned, false);
  assert.equal(
    moveEnd.size,
    0,
    'teardown also releases the stage camera listener',
  );
});

test('weather stages invisibly, waits for pending tiles and render readiness, and replaces atomically', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = renderingHarness();
  const first = h.rendering.setFrame(snapshot, times[0]);
  const layer = h.layers[0];
  assert.equal(layer.alpha, 0);
  assert.equal(layer.show, true);
  assert.equal(h.rendering.getDiagnostics().time, null);
  const tile = deferred();
  h.providers[0].response = tile;
  const requested = h.providers[0].requestImage(0, 0, 0, { cancel() {} });
  h.settle();
  assert.equal(h.rendering.getDiagnostics().loading, true);
  tile.resolve({});
  await requested;
  h.viewer.scene.globe.tilesLoaded = false;
  h.settle();
  assert.equal(h.rendering.getDiagnostics().loading, true);
  h.viewer.scene.globe.tilesLoaded = true;
  h.postRender.emit();
  assert.equal(
    h.rendering.getDiagnostics().time,
    null,
    'one settled frame is insufficient',
  );
  h.postRender.emit();
  assert.equal(await first, true);
  assert.equal(layer.alpha, 0.7);
  const second = h.rendering.setFrame(snapshot, times[1]);
  assert.equal(h.layers.length, 2);
  assert.equal(
    h.rendering.getDiagnostics().time,
    times[0],
    'displayed time remains old until commit',
  );
  h.settle();
  assert.equal(await second, true);
  assert.equal(h.layers.length, 1);
  assert.equal(layer.destroyed, true);
  assert.equal(h.providers[0].errorEvent.size, 0);
  assert.equal(h.rendering.getDiagnostics().time, times[1]);
  assert.deepEqual(h.viewer.clock, { untouched: true });
  h.rendering.clear();
});

test('superseded stages cancel requests and cannot resurrect after a late tile response', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = renderingHarness();
  const first = h.rendering.setFrame(snapshot, times[0]);
  const tile = deferred();
  const oldProvider = h.providers[0];
  oldProvider.response = tile;
  let cancellations = 0;
  const requested = oldProvider.requestImage(0, 0, 0, {
    cancel() {
      cancellations++;
    },
  });
  const second = h.rendering.setFrame(snapshot, times[1]);
  assert.equal(await first, false);
  assert.equal(cancellations, 1);
  assert.equal(h.layers.length, 1);
  assert.equal(oldProvider.errorEvent.size, 0);
  tile.resolve({});
  await requested;
  h.settle();
  assert.equal(await second, true);
  assert.equal(h.rendering.getDiagnostics().time, times[1]);
  assert.equal(oldProvider.requestImage(0, 0, 0, {}), undefined);
  h.rendering.clear();
  assert.equal(h.layers.length, 0);
  assert.equal(h.postRender.size, 0);
  assert.ok(h.providers.every((provider) => provider.errorEvent.size === 0));
  t.mock.timers.tick(30_000);
  assert.equal(h.layers.length, 0);
});

test('failed and timed-out stages retain the previous observation; a healthy replacement clears old errors', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = renderingHarness();
  const first = h.rendering.setFrame(snapshot, times[0]);
  h.settle();
  await first;
  const failed = h.rendering.setFrame(snapshot, times[1]);
  h.providers[1].errorEvent.emit(new Error('tile missing'));
  h.postRender.emit();
  assert.equal(await failed, false);
  assert.equal(h.rendering.getDiagnostics().time, times[0]);
  assert.equal(h.layers.length, 1);
  const timeout = h.rendering.setFrame(snapshot, times[1]);
  h.viewer.scene.globe.tilesLoaded = false;
  t.mock.timers.tick(25_000);
  assert.equal(await timeout, false);
  assert.equal(h.rendering.getDiagnostics().time, times[0]);
  const healthy = h.rendering.setFrame(snapshot, times[2]);
  h.providers[0].errorEvent.emit(
    new Error('old visible tile failed while replacement loaded'),
  );
  h.viewer.scene.globe.tilesLoaded = true;
  h.settle();
  assert.equal(await healthy, true);
  assert.equal(h.rendering.getDiagnostics().error, null);
  h.rendering.clear();
});

function layerHarness({ reducedMotion = false, feed, id } = {}) {
  const stages = [];
  const motion = target({ matches: reducedMotion });
  const documentRef = target({ hidden: false });
  const moveEnd = event();
  let time = null;
  let active = null;
  let clearCount = 0;
  const rendering = {
    setAlpha() {},
    setFrame(value, selected, { signal } = {}) {
      if (active) active.finish(false);
      const task = deferred();
      const abort = () => stage.finish(false);
      const stage = {
        ...task,
        time: selected,
        signal,
        finish(ok = true) {
          signal?.removeEventListener('abort', abort);
          if (active === stage) {
            if (ok) time = selected;
            active = null;
          }
          task.resolve(ok);
        },
      };
      signal?.addEventListener('abort', abort, { once: true });
      stages.push(stage);
      active = stage;
      return stage.promise;
    },
    clear() {
      clearCount++;
      active?.finish(false);
      active = null;
      time = null;
    },
    getDiagnostics: () => ({ time, loading: Boolean(active), error: null }),
  };
  const viewer = { camera: { moveEnd } };
  const layer = createWeatherLayer({
    id,
    feed: feed ?? { getSnapshot: async () => snapshot },
    documentRef,
    matchMedia: () => motion,
    createRendering: () => rendering,
  });
  layer.init(viewer);
  layer.enable();
  return {
    layer,
    stages,
    motion,
    documentRef,
    moveEnd,
    clears: () => clearCount,
  };
}

test('history has one owned timer, stops while hidden, and releases all work on disable/destroy', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = layerHarness();
  const update = h.layer.update();
  await flush();
  h.stages[0].finish();
  await update;
  h.layer.setParams({ play: true });
  assert.equal(h.layer.getDiagnostics().timerActive, true);
  t.mock.timers.tick(2000);
  assert.equal(h.stages.length, 2);
  assert.equal(
    h.layer.getDiagnostics().timerActive,
    false,
    'next timer waits for stage settlement',
  );
  h.stages[1].finish();
  await flush();
  assert.equal(h.layer.getDiagnostics().timerActive, true);
  h.documentRef.hidden = true;
  h.documentRef.emit('visibilitychange');
  assert.equal(h.layer.getDiagnostics().playing, false);
  assert.equal(h.layer.getDiagnostics().timerActive, false);
  t.mock.timers.tick(20_000);
  assert.equal(h.stages.length, 2);
  h.documentRef.hidden = false;
  h.documentRef.emit('visibilitychange');
  h.layer.setParams({ play: true });
  h.layer.disable();
  assert.equal(h.layer.getDiagnostics().timerActive, false);
  assert.equal(h.layer.getDiagnostics().historyFrames, 0);
  t.mock.timers.tick(20_000);
  assert.equal(h.stages.length, 2);
  h.layer.destroy();
  assert.equal(h.documentRef.size, 0);
  assert.equal(h.motion.size, 0);
  assert.equal(h.moveEnd.size, 0);
  assert.ok(h.clears() >= 1);
});

test('reduced motion blocks autoplay but permits manual history and stops newly suspended playback', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = layerHarness({ reducedMotion: true });
  const update = h.layer.update();
  await flush();
  h.stages[0].finish();
  await update;
  h.layer.setParams({ play: true });
  assert.equal(h.layer.getDiagnostics().timerActive, false);
  assert.equal(
    h.layer.getRowControls().chips.find((chip) => chip.id === 'play').disabled,
    true,
  );
  h.layer.setParams({ step: -1 });
  assert.equal(h.stages[1].time, times[1]);
  h.stages[1].finish();
  await flush();
  h.motion.matches = false;
  h.motion.emit('change');
  h.layer.setParams({ play: true });
  assert.equal(h.layer.getDiagnostics().playing, true);
  h.motion.matches = true;
  h.motion.emit('change');
  assert.equal(h.layer.getDiagnostics().playing, false);
  assert.equal(h.layer.getDiagnostics().timerActive, false);
  h.layer.destroy();
});

test('disable invalidates an abort-insensitive source result and an already staged frame', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const source = deferred();
  let signal;
  const h = layerHarness({
    feed: {
      getSnapshot(options) {
        signal = options.signal;
        return source.promise;
      },
    },
  });
  const update = h.layer.update();
  h.layer.disable();
  assert.equal(signal.aborted, true);
  source.resolve(snapshot);
  assert.equal(await update, false);
  assert.equal(h.stages.length, 0);
  h.layer.enable();
  const next = h.layer.update();
  await flush();
  assert.equal(h.stages.length, 1);
  h.layer.disable();
  await next;
  await flush();
  assert.equal(h.layer.getStats().count, 0);
  assert.equal(h.layer.getDiagnostics().timerActive, false);
  assert.equal(h.layer.getStats().loading, false);
  h.layer.destroy();
});

test('external abort cancels a staged renderer request and releases its observer and deadline', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = renderingHarness();
  const controller = new AbortController();
  const stage = h.rendering.setFrame(snapshot, times[0], {
    signal: controller.signal,
  });
  const tile = deferred();
  h.providers[0].response = tile;
  let cancellations = 0;
  const requested = h.providers[0].requestImage(0, 0, 0, {
    cancel() {
      cancellations++;
    },
  });
  const before = h.renders();
  controller.abort();
  assert.equal(await stage, false);
  assert.equal(cancellations, 1);
  assert.equal(h.layers.length, 0);
  assert.equal(h.postRender.size, 0);
  assert.equal(h.providers[0].errorEvent.size, 0);
  assert.ok(
    h.renders() > before,
    'cancellation requests a Cesium scheduler update',
  );
  tile.resolve({});
  await requested;
  t.mock.timers.tick(30_000);
  assert.equal(h.rendering.getDiagnostics().time, null);
  await assert.rejects(
    h.rendering.setFrame(snapshot, times[1], { signal: controller.signal }),
    { name: 'AbortError' },
  );
  assert.equal(
    h.providers.length,
    1,
    'already-aborted work creates no provider',
  );
  h.rendering.clear();
});

test('update cancellation reaches imagery after source acquisition has completed', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = layerHarness();
  const controller = new AbortController();
  const update = h.layer.update(null, { signal: controller.signal });
  await flush();
  assert.equal(h.stages.length, 1);
  assert.equal(h.stages[0].signal.aborted, false);
  controller.abort();
  assert.equal(await update, false);
  assert.equal(h.stages[0].signal.aborted, true);
  assert.equal(h.layer.getStats().count, 0);
  assert.equal(h.layer.getStats().loading, false);
  assert.equal(h.layer.getDiagnostics().timerActive, false);
  h.layer.destroy();
});

test('superseding a pending stage preserves the newer manifest loading state', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const later = deferred();
  let fetches = 0;
  const h = layerHarness({
    feed: {
      getSnapshot() {
        return ++fetches === 1 ? Promise.resolve(snapshot) : later.promise;
      },
    },
  });
  const old = h.layer.update();
  await flush();
  const newer = h.layer.update();
  await flush();
  assert.equal(await old, false);
  assert.equal(
    h.layer.getStats().loading,
    true,
    'old stage finally must not clear a newer source loading state',
  );
  later.resolve(snapshot);
  await flush();
  h.stages.at(-1).finish();
  assert.equal(await newer, true);
  assert.equal(h.layer.getStats().loading, false);
  h.layer.destroy();
});

test('global infrared is one bounded geographic mosaic with no per-tile contrast seams', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = renderingHarness();
  const task = h.rendering.setFrame(
    { ...snapshot, product: 'clouds' },
    times[0],
  );
  const options = h.providers[0].options;
  assert.match(options.url, /^\/api\/weather\/image\?product=clouds&time=/);
  assert.equal(options.maximumLevel, 0);
  assert.equal(options.tileWidth, 2048);
  assert.equal(options.tileHeight, 1024);
  assert.equal(options.tilingScheme.options.numberOfLevelZeroTilesX, 1);
  assert.deepEqual(options.tilingScheme.options.rectangle, options.rectangle);
  h.settle();
  assert.equal(await task, true);
  h.rendering.clear();
});

test('coverage navigation requires the shared shell handoff and detaches cleanly', async () => {
  const h = layerHarness();
  const update = h.layer.update();
  await flush();
  h.stages[0].finish();
  await update;
  assert.equal(
    h.layer.getRowControls().chips.find((chip) => chip.id === 'coverage')
      .disabled,
    true,
  );
  let handoffs = 0;
  h.layer.attachShellServices({
    runNavigation(navigate) {
      handoffs++;
      assert.equal(typeof navigate, 'function');
    },
  });
  h.layer.setParams({ focus: true });
  assert.equal(handoffs, 1);
  h.layer.attachShellServices(null);
  h.layer.setParams({ focus: true });
  assert.equal(handoffs, 1);
  h.layer.destroy();
});

test('manifest refresh during a manual history stage does not strand loading controls', async () => {
  const h = layerHarness();
  const first = h.layer.update();
  await flush();
  h.stages[0].finish();
  await first;
  h.layer.setParams({ step: -1 });
  assert.equal(h.layer.getStats().loading, true);
  await h.layer.update();
  assert.equal(
    h.stages.length,
    2,
    'metadata refresh preserves the staged manual selection',
  );
  h.stages[1].finish();
  await flush();
  assert.equal(h.layer.getStats().loading, false);
  assert.equal(h.layer.getStats().observedAt, times[1]);
  assert.equal(
    h.layer.getRowControls().chips.find((chip) => chip.id === 'previous')
      .disabled,
    false,
  );
  h.layer.destroy();
});

test('historical observations do not relabel a fresh lightning feed as stale', async () => {
  const now = Date.now();
  const old = new Date(now - 90 * 60_000).toISOString();
  const recent = new Date(now - 5 * 60_000).toISOString();
  const h = layerHarness({
    id: 'weather-lightning',
    feed: {
      getSnapshot: async () => ({
        ...snapshot,
        product: 'lightning',
        times: [old, recent],
        latest: recent,
      }),
    },
  });
  const first = h.layer.update();
  await flush();
  h.stages[0].finish();
  await first;
  h.layer.setParams({ step: -1 });
  h.stages[1].finish();
  await flush();
  assert.equal(h.layer.getStats().stale, false);
  assert.match(h.layer.getRowControls().summary.detail, /History/);
  h.layer.destroy();
});
