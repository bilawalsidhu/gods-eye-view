import test from 'node:test';
import assert from 'node:assert/strict';
import { createWeatherRendering } from './rendering.js';
import { createWeatherLayer } from './index.js';
import { createWeatherClock } from './clock.js';
import { LayerLifecycle } from '../../data/lifecycle.js';
import * as Cesium from 'cesium';
import { Color, ImageryLayerCollection, GeographicTilingScheme } from 'cesium';
import { NO_IMAGERY_HOST } from './imageryHost.js';
import { orderWeatherImagery } from './imageryOrder.js';
import {
  createShellCesium,
  createShellScene,
  renderShells,
} from './shellFixture.mjs';

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
  for (let i = 0; i < 30; i++) await Promise.resolve();
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
function mockCanvas() {
  const canvas = { width: 0, height: 0 };
  canvas.getContext = () => ({
    setTransform(...matrix) {
      canvas.transforms = [...(canvas.transforms ?? []), matrix];
    },
    drawImage(source, ...crop) {
      canvas.source = source;
      canvas.crop = crop;
      canvas.drawnWith = canvas.transforms?.at(-1) ?? null;
    },
    getImageData: () => ({ data: new Uint8ClampedArray([194, 100, 0, 200]) }),
    putImageData(pixels) {
      canvas.pixels = pixels.data;
    },
  });
  return canvas;
}
const mockResponse = () => ({
  ok: true,
  headers: new Headers(),
  arrayBuffer: async () => new ArrayBuffer(1),
});
function renderingHarness(options = {}) {
  const layers = [];
  const providers = [];
  const postRender = event();
  let renderRequests = 0;
  class Provider {
    constructor(options) {
      this.options = options;
      this.tilingScheme = new GeographicTilingScheme();
      this.errorEvent = event();
      this.response = null;
      providers.push(this);
    }
    requestImage(...args) {
      this.requestArgs = args;
      return this.response?.promise;
    }
  }
  const collection = {
    add(layer) {
      layers.push(layer);
      return layer;
    },
    addImageryProvider(provider) {
      if (!providers.includes(provider)) providers.push(provider);
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
      primitives: createShellScene().primitives,
      globe: { tilesLoaded: true },
      requestRender() {
        renderRequests++;
      },
    },
  };
  const cesium = {
    ...createShellCesium(),
    Color,
    UrlTemplateImageryProvider: Provider,
    GeographicTilingScheme,
    Event: Cesium.Event,
    Credit: Cesium.Credit,
    Rectangle: Cesium.Rectangle,
  };
  const rendering = createWeatherRendering({
    viewer,
    cesium,
    fetchImpl: async () => mockResponse(),
    decodeImage: async () => ({ width: 2048, height: 1024, close() {} }),
    createCanvas: mockCanvas,
    ...options,
  });
  const settle = () => {
    postRender.emit();
    postRender.emit();
  };
  return {
    rendering,
    viewer,
    cesium,
    providers,
    layers,
    postRender,
    settle,
    shells: () => viewer.scene.primitives.items,
    renderShells: () => renderShells(cesium, viewer.scene),
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
  assert.equal(moveEnd.size, 0, 'committing releases the stage listener');
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
  assert.equal(h.layers.length, 2, 'old layer survives the admission render');
  assert.equal(
    h.layers[1].alpha,
    0.7,
    'new layer is visible before retirement',
  );
  assert.equal(layer.destroyed, undefined);
  h.postRender.emit();
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

function layerHarness({
  clock,
  reducedMotion = false,
  feed,
  id,
  eventTarget = target(),
  credits,
  // Leave init and enable to a LayerLifecycle, as the app does.
  managed = false,
} = {}) {
  const stages = [];
  const motion = target({ matches: reducedMotion });
  const documentRef = target({ hidden: false });
  const moveEnd = event();
  let time = null;
  let infraredMode = 'filtered';
  let active = null;
  let clearCount = 0;
  let hidden = false;
  const rendering = {
    rehome() {
      active?.finish(false);
    },
    setAlpha() {},
    setHidden(value) {
      hidden = value;
      if (value) active?.finish(false);
    },
    setFrame(value, selected, { signal, infrared = 'filtered' } = {}) {
      if (active) active.finish(false);
      const task = deferred();
      const abort = () => stage.finish(false);
      const stage = {
        ...task,
        time: selected,
        infrared,
        signal,
        finish(ok = true) {
          signal?.removeEventListener('abort', abort);
          if (active === stage) {
            if (ok) {
              time = selected;
              infraredMode = infrared;
            }
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
    getDiagnostics: () => ({
      time: hidden ? null : time,
      hidden,
      infrared: infraredMode,
      loading: Boolean(active),
      error: null,
    }),
  };
  const viewer = { camera: { moveEnd } };
  const layer = createWeatherLayer({
    clock,
    id,
    feed: feed ?? { getSnapshot: async () => snapshot },
    documentRef,
    eventTarget,
    matchMedia: () => motion,
    createRendering: () => rendering,
    credits,
  });
  if (!managed) {
    layer.init(viewer);
    layer.enable();
  }
  return {
    layer,
    viewer,
    rendering,
    stages,
    eventTarget,
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
    h.layer.getRowControls().chips.some((chip) => chip.id === 'play'),
    false,
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

test('global infrared is acquired before staging and cropped from one processed mosaic', async () => {
  let fetches = 0;
  const decode = deferred();
  const h = renderingHarness({
    fetchImpl: async () => {
      fetches++;
      return mockResponse();
    },
    decodeImage: () => decode.promise,
  });
  const task = h.rendering.setFrame(
    { ...snapshot, product: 'clouds' },
    times[0],
  );
  await flush();
  assert.equal(h.layers.length, 0);
  assert.equal(h.rendering.getDiagnostics().loading, true);
  assert.deepEqual(h.rendering.getDiagnostics().mosaic, {
    fetched: true,
    decodeMs: null,
    cached: false,
  });
  decode.resolve({ width: 2048, height: 1024 });
  await flush();
  const provider = h.layers[0].imageryProvider;
  assert.equal(provider.maximumLevel, 3);
  assert.equal(provider.tileWidth, 256);
  assert.equal(provider.tileHeight, 256);
  assert.equal(provider.tilingScheme.getNumberOfXTilesAtLevel(0), 2);
  assert.deepEqual(provider.tilingScheme.rectangle, provider.rectangle);
  const first = await provider.requestImage(0, 0, 0);
  const next = await provider.requestImage(1, 0, 0);
  assert.equal(first.source, next.source);
  assert.deepEqual(
    first.source.pixels,
    new Uint8ClampedArray([194, 100, 0, 98]),
  );
  assert.equal(fetches, 1);
  h.settle();
  assert.equal(await task, true);
  assert.equal(h.rendering.getDiagnostics().mosaic.fetched, true);
  assert.equal(typeof h.rendering.getDiagnostics().mosaic.decodeMs, 'number');
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
    h.layer.getRowControls().chips.some((chip) => chip.id === 'previous'),
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

test('history loading updates an existing info line and preserves summary status', async (t) => {
  t.mock.method(Date, 'now', () => Date.parse(times[2]));
  const h = layerHarness();
  const update = h.layer.update();
  await flush();
  h.stages[0].finish();
  await update;
  h.layer.setParams({ step: -1 });
  await flush();
  const loading = h.layer.getRowControls();
  assert.match(loading.info, /History: [^\n]+\n[^\n]+ · loading/);
  assert.equal(loading.summary.status, 'Loading next frame…');
  h.stages.at(-1).finish();
  await flush();
  const ready = h.layer.getRowControls();
  assert.equal(ready.info.split('\n').length, loading.info.split('\n').length);
  assert.doesNotMatch(ready.info, / · loading/);
  h.layer.destroy();
});

test('no host cancels a globe stage, detaches the layer and restores it in weather order', async () => {
  let host;
  const h = renderingHarness({ getHost: () => host });
  host = { collection: h.viewer.imageryLayers, kind: 'globe' };
  const stage = h.rendering.setFrame(snapshot, times[0]);
  h.settle();
  assert.equal(await stage, true);
  const radar = h.layers[0];
  const cloud = h.viewer.imageryLayers.add({ name: 'cloud' });
  const lightning = h.viewer.imageryLayers.add({ name: 'lightning' });
  orderWeatherImagery(h.viewer.imageryLayers, lightning, 3);
  orderWeatherImagery(h.viewer.imageryLayers, cloud, 1);
  const incoming = h.rendering.setFrame(snapshot, times[1]);
  host = { collection: null, kind: 'none' };
  assert.equal(h.rendering.rehome(), true);
  assert.equal(await incoming, false);
  assert.deepEqual(h.layers, [cloud, lightning]);
  assert.equal(await h.rendering.setFrame(snapshot, times[2]), false);
  assert.equal(h.rendering.getDiagnostics().error, NO_IMAGERY_HOST);
  assert.equal(h.rendering.getDiagnostics().time, times[0]);
  host = { collection: h.viewer.imageryLayers, kind: 'globe' };
  h.rendering.rehome();
  assert.deepEqual(h.layers, [cloud, radar, lightning]);
  assert.equal(h.rendering.getDiagnostics().error, null);
  h.rendering.clear();
  assert.deepEqual(h.layers, [cloud, lightning]);
  assert.equal(radar.destroyed, true);
});

const shellDecode = async () => ({ width: 4096, height: 2048, close() {} });

test('the tileset host draws a raised shell and drapes nothing, at any camera height', async () => {
  const tiles = new ImageryLayerCollection();
  const h = renderingHarness({
    getHost: () => ({ collection: tiles, kind: 'tileset' }),
    decodeImage: shellDecode,
  });
  h.viewer.camera = {
    moveEnd: event(),
    positionCartographic: { height: 1200 },
  };
  const stage = h.rendering.setFrame(snapshot, times[0]);
  await flush();
  assert.equal(tiles.length, 0);
  assert.equal(h.layers.length, 0);
  assert.equal(h.providers.length, 0);
  assert.equal(h.shells().length, 1);
  assert.equal(h.rendering.getDiagnostics().loading, true);
  h.renderShells();
  assert.equal(await stage, true);
  const diagnostics = h.rendering.getDiagnostics();
  assert.equal(diagnostics.host, 'shell');
  assert.equal(diagnostics.height, 6_200);
  assert.equal(diagnostics.time, times[0]);
  assert.equal(diagnostics.error, null);
  assert.equal(
    h.viewer.camera.moveEnd.size,
    1,
    'one camera listener, for the detail window only',
  );
  assert.equal(await h.rendering.prefetch(snapshot, times[1]), true);
  assert.equal(h.rendering.getDiagnostics().cache.mosaics, 2);
  h.rendering.clear();
  assert.equal(h.shells().length, 0);
  assert.equal(h.postRender.size, 0);
  assert.equal(h.viewer.camera.moveEnd.size, 0);
  assert.equal(h.rendering.getDiagnostics().cache.mosaics, 0);
});

test('a switch to 3D Tiles windows the current view; the globe host never requests a window', async () => {
  let host;
  const urls = [];
  const h = renderingHarness({
    getHost: () => host,
    decodeImage: shellDecode,
    fetchImpl: async (url) => {
      urls.push(url);
      return mockResponse();
    },
  });
  h.viewer.camera = {
    moveEnd: event(),
    computeViewRectangle: () => Cesium.Rectangle.fromDegrees(-100, 35, -98, 36),
  };
  host = { collection: h.viewer.imageryLayers, kind: 'globe' };
  const globe = h.rendering.setFrame(snapshot, times[0]);
  h.settle();
  assert.equal(await globe, true);
  assert.equal(await h.rendering.prefetch(snapshot, times[1]), true);
  h.viewer.camera.moveEnd.emit();
  await flush();
  assert.equal(h.shells().length, 0);
  assert.equal(h.viewer.camera.moveEnd.size, 0);
  assert.equal(h.rendering.getDiagnostics().shell, undefined);
  assert.ok(urls.length > 0);
  assert.ok(urls.every((url) => !url.includes('bbox=')));

  host = { collection: new ImageryLayerCollection(), kind: 'tileset' };
  assert.equal(h.rendering.rehome(), true);
  await flush();
  h.renderShells();
  await flush();
  h.renderShells();
  const detail = urls.filter((url) => url.includes('bbox='));
  assert.deepEqual(
    detail.map((url) =>
      new URL(url, 'https://example.test').searchParams.get('bbox'),
    ),
    ['-102,34,-96,37'],
  );
  const diagnostics = h.rendering.getDiagnostics();
  assert.equal(diagnostics.time, times[0]);
  assert.equal(diagnostics.shell.detail.ready, true);
  assert.equal(h.shells().length, 1, 'the detail draws on the shell surface');
  host = { collection: h.viewer.imageryLayers, kind: 'globe' };
  assert.equal(h.rendering.rehome(), true);
  assert.equal(h.shells().length, 0, 'the shell surface goes with the host');
  await flush();
  h.settle();
  await flush();
  assert.equal(h.rendering.getDiagnostics().host, 'globe');
  assert.equal(h.rendering.getDiagnostics().loading, false);
  assert.equal(h.viewer.camera.moveEnd.size, 0);
  assert.equal(urls.filter((url) => url.includes('bbox=')).length, 1);
  h.rendering.clear();
});

test('host switches tear one renderer down and restage the retained frame on the other', async () => {
  let host;
  const tiles = new ImageryLayerCollection();
  const h = renderingHarness({
    getHost: () => host,
    decodeImage: async () => ({ width: 2048, height: 1024, close() {} }),
  });
  const clouds = { ...snapshot, product: 'clouds' };
  host = { collection: h.viewer.imageryLayers, kind: 'globe' };
  h.rendering.setAlpha(0.4);
  const first = h.rendering.setFrame(clouds, times[1], { infrared: 'full' });
  await flush();
  h.settle();
  assert.equal(await first, true);
  const layer = h.layers[0];
  host = { collection: tiles, kind: 'tileset' };
  assert.equal(h.rendering.rehome(), true);
  assert.equal(h.layers.length, 0);
  assert.equal(layer.destroyed, true);
  assert.equal(tiles.length, 0);
  assert.equal(
    h.rendering.getDiagnostics().time,
    times[1],
    'the retained time is reported while restaging',
  );
  assert.equal(h.rendering.getDiagnostics().loading, true);
  await flush();
  const [shell] = h.shells();
  h.renderShells();
  await flush();
  let diagnostics = h.rendering.getDiagnostics();
  assert.equal(diagnostics.host, 'shell');
  assert.equal(diagnostics.height, 5_500);
  assert.equal(diagnostics.loading, false);
  assert.equal(diagnostics.time, times[1]);
  assert.equal(diagnostics.infrared, 'full');
  assert.equal(shell.appearance.material.uniforms.alpha, 0.4);
  host = { collection: h.viewer.imageryLayers, kind: 'globe' };
  assert.equal(h.rendering.rehome(), true);
  assert.equal(shell.destroyed, true);
  assert.equal(shell.appearance.material.destroyed, true);
  assert.equal(h.shells().length, 0);
  assert.equal(h.rendering.getDiagnostics().time, times[1]);
  await flush();
  assert.equal(h.layers.length, 1);
  h.settle();
  await flush();
  diagnostics = h.rendering.getDiagnostics();
  assert.equal(diagnostics.host, 'globe');
  assert.equal(diagnostics.loading, false);
  assert.equal(diagnostics.time, times[1]);
  assert.equal(diagnostics.infrared, 'full');
  assert.equal(h.layers[0].alpha, 0.4);
  assert.equal(h.layers[0].imageryProvider.tileWidth, 256);
  h.rendering.clear();
  assert.equal(h.layers.length, 0);
  assert.equal(h.postRender.size, 0);
});

test('a host without imagery keeps the active shell and its frame', async () => {
  let host = { collection: new ImageryLayerCollection(), kind: 'tileset' };
  let fetches = 0;
  const h = renderingHarness({
    getHost: () => host,
    decodeImage: shellDecode,
    fetchImpl: async () => {
      fetches++;
      return mockResponse();
    },
  });
  const stage = h.rendering.setFrame(snapshot, times[0]);
  await flush();
  h.renderShells();
  assert.equal(await stage, true);
  const [shell] = h.shells();
  host = { collection: null, kind: 'none' };
  h.rendering.rehome();
  assert.equal(shell.show, false);
  assert.equal(shell.destroyed, false);
  assert.equal(h.rendering.getDiagnostics().time, times[0]);
  assert.equal(h.rendering.getDiagnostics().error, NO_IMAGERY_HOST);
  assert.equal(await h.rendering.setFrame(snapshot, times[1]), false);
  host = { collection: new ImageryLayerCollection(), kind: 'tileset' };
  h.rendering.rehome();
  assert.equal(shell.show, true);
  assert.deepEqual(h.shells(), [shell]);
  assert.equal(fetches, 1);
  assert.equal(h.rendering.getDiagnostics().error, null);
  h.rendering.setHidden(true);
  assert.equal(shell.show, false);
  assert.equal(h.rendering.getDiagnostics().time, null);
  h.rendering.setHidden(false);
  assert.equal(shell.show, true);
  h.rendering.clear();
  assert.equal(h.shells().length, 0);
});

test('each product owns its shell height; a product change replaces the shell', async () => {
  let width = 2048;
  const h = renderingHarness({
    getHost: () => ({ collection: null, kind: 'tileset' }),
    decodeImage: async () => ({ width, height: width / 2, close() {} }),
  });
  const global = h.rendering.setFrame(
    { ...snapshot, product: 'clouds' },
    times[0],
  );
  await flush();
  h.renderShells();
  assert.equal(await global, true);
  const [first] = h.shells();
  assert.equal(h.rendering.getDiagnostics().height, 5_500);
  width = 4096;
  const lightning = h.rendering.setFrame(
    { ...snapshot, product: 'lightning' },
    times[0],
  );
  assert.equal(first.destroyed, true);
  await flush();
  h.renderShells();
  assert.equal(await lightning, true);
  assert.equal(h.rendering.getDiagnostics().height, 6_600);
  assert.equal(h.rendering.getDiagnostics().product, 'lightning');
  assert.equal(h.shells().length, 1);
  h.rendering.clear();
});

test('a stage without a current frame is cancelled on host change and detached frames are destroyed', async () => {
  const tiles = new ImageryLayerCollection();
  let host = { collection: tiles, kind: 'tileset' };
  const h = renderingHarness({ getHost: () => host });
  const first = h.rendering.setFrame(snapshot, times[0]);
  host = { collection: h.viewer.imageryLayers, kind: 'globe' };
  h.rendering.rehome();
  assert.equal(await first, false);
  assert.equal(tiles.length, 0);
  const ready = h.rendering.setFrame(snapshot, times[1]);
  h.settle();
  await ready;
  const layer = h.layers[0];
  let destroyed = false;
  layer.destroy = () => {
    destroyed = true;
  };
  host = { collection: null, kind: 'none' };
  h.rendering.rehome();
  h.rendering.clear();
  assert.equal(destroyed, true);
});

for (const product of ['clouds', 'clouds-regional', 'radar', 'lightning']) {
  test(`${product} does not use a hard layer alpha cut on the globe host`, async () => {
    const collection = new ImageryLayerCollection();
    const h = renderingHarness({
      getHost: () => ({ collection, kind: 'globe' }),
    });
    const stage = h.rendering.setFrame({ ...snapshot, product }, times[0]);
    await flush();
    const layer = collection.get(0);
    assert.equal(layer.colorToAlpha, undefined);
    assert.equal(layer.alpha, 0);
    h.rendering.clear();
    assert.equal(await stage, false);
  });
}

for (const statusCode of [429, 503]) {
  test(`${statusCode} retries up to three times without failing a healthy frame`, async () => {
    let now = 0;
    const h = renderingHarness({ now: () => now });
    h.viewer.scene.globe.tilesLoaded = false;
    const stage = h.rendering.setFrame(snapshot, times[0]);
    h.providers[0].response = deferred();
    const rejected = h.providers[0].requestImage(0, 0, 0, {});
    h.providers[0].response.reject(new Error('throttled'));
    await assert.rejects(rejected, /throttled/);
    for (let timesRetried = 0; timesRetried < 3; timesRetried++) {
      const error = {
        error: { statusCode },
        x: 0,
        y: 0,
        level: 0,
        timesRetried,
        retry: false,
      };
      h.providers[0].errorEvent.emit(error);
      assert.equal(error.retry, true);
      assert.equal(h.rendering.getDiagnostics().error, null);
    }
    h.settle();
    assert.equal(h.rendering.getDiagnostics().loading, true);
    h.providers[0].response = deferred();
    const retried = h.providers[0].requestImage(0, 0, 0, {});
    h.providers[0].response.resolve({});
    await retried;
    now = 250;
    h.settle();
    assert.equal(await stage, true);
    const exhausted = h.rendering.setFrame(snapshot, times[1]);
    const error = { error: { statusCode }, timesRetried: 3, retry: false };
    for (let i = 0; i < 4; i++) h.providers[1].errorEvent.emit(error);
    h.settle();
    assert.equal(error.retry, false);
    assert.equal(await exhausted, false);
    assert.equal(h.rendering.getDiagnostics().time, times[0]);
    h.rendering.clear();
  });
}

test('404 fails a frame without retry', async () => {
  const h = renderingHarness();
  const stage = h.rendering.setFrame(snapshot, times[0]);
  const error = { error: { statusCode: 404 }, timesRetried: 0, retry: false };
  h.providers[0].errorEvent.emit(error);
  h.settle();
  assert.equal(error.retry, false);
  assert.equal(await stage, false);
  h.rendering.clear();
});

test('no host pauses history, refreshes metadata, and restores retained time and playback', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let refreshes = 0;
  const h = layerHarness({
    feed: {
      getSnapshot: async () => {
        refreshes++;
        return snapshot;
      },
    },
  });
  let host = { collection: {}, kind: 'tileset' };
  h.layer.attachShellServices({ imageryHost: () => host });
  const update = h.layer.update();
  await flush();
  h.stages[0].finish();
  await update;
  h.layer.setParams({ play: true });
  t.mock.timers.tick(2000);
  assert.equal(h.stages.length, 2);
  host = { collection: null, kind: 'none' };
  h.eventTarget.emit('gev:map-stack-changed');
  await flush();
  assert.equal(h.layer.getDiagnostics().playing, false);
  assert.equal(h.layer.getDiagnostics().timerActive, false);
  assert.equal(h.layer.getRowControls().summary.status, NO_IMAGERY_HOST);
  assert.equal(h.layer.getRowControls().info, NO_IMAGERY_HOST);
  await h.layer.update();
  assert.equal(refreshes, 2);
  t.mock.timers.tick(10_000);
  assert.equal(h.stages.length, 2);
  assert.equal(h.layer.getDiagnostics().time, times[2]);
  host = { collection: {}, kind: 'globe' };
  h.eventTarget.emit('gev:map-stack-changed');
  assert.equal(h.layer.getDiagnostics().playing, true);
  assert.equal(h.layer.getDiagnostics().timerActive, true);
  t.mock.timers.tick(2000);
  assert.equal(h.stages.length, 3);
  assert.equal(h.stages[2].time, times[0]);
  h.layer.destroy();
  assert.equal(h.eventTarget.size, 0);
});

test('host restore through update stages latest after a no-host start', async () => {
  const h = layerHarness();
  let host = { collection: null, kind: 'none' };
  h.layer.attachShellServices({ imageryHost: () => host });
  await h.layer.update();
  assert.equal(h.stages.length, 0);
  host = { collection: {}, kind: 'tileset' };
  const update = h.layer.update();
  await flush();
  assert.equal(h.stages[0].time, snapshot.latest);
  h.stages[0].finish();
  await update;
  assert.notEqual(h.layer.getRowControls().summary.status, NO_IMAGERY_HOST);
  h.layer.destroy();
});

test('real Cesium global infrared provider supports the globe host', async () => {
  const collection = new Cesium.ImageryLayerCollection();
  const h = renderingHarness({
    cesium: Cesium,
    getHost: () => ({ collection, kind: 'globe' }),
  });
  const stage = h.rendering.setFrame(
    {
      ...snapshot,
      product: 'clouds',
      bounds: { west: -180, south: -60, east: 180, north: 60 },
    },
    times[0],
  );
  await flush();
  const layer = collection.get(0);
  const provider = layer.imageryProvider;
  assert.ok(provider.tilingScheme instanceof Cesium.GeographicTilingScheme);
  assert.equal(provider.maximumLevel, 3);
  assert.equal(provider.tileWidth, 256);
  assert.equal(provider.tileHeight, 256);
  assert.equal(provider.tilingScheme.getNumberOfXTilesAtLevel(0), 2);
  assert.equal(provider.tilingScheme.getNumberOfYTilesAtLevel(0), 1);
  assert.ok(
    Cesium.Rectangle.equals(
      provider.rectangle,
      Cesium.Rectangle.fromDegrees(-180, -60, 180, 60),
    ),
  );
  assert.equal(layer.colorToAlpha, undefined);
  assert.ok(provider.requestImage(0, 0, 0) instanceof Promise);
  h.rendering.clear();
  assert.equal(await stage, false);
});

for (const statusCode of [429, 503]) {
  test(`${statusCode} retries belong to tiles, regardless of the layer-wide counter`, async () => {
    const h = renderingHarness();
    const stage = h.rendering.setFrame(snapshot, times[0]);
    const provider = h.providers[0];
    const fail = (x, timesRetried = 0) => {
      const error = { x, y: 0, level: 2, timesRetried, error: { statusCode } };
      provider.errorEvent.emit(error);
      return error.retry;
    };
    // A shared counter may exceed three even though these are first failures.
    for (let x = 0; x < 4; x++) assert.equal(fail(x, x + 4), true);
    provider.response = { promise: Promise.resolve({}) };
    await provider.requestImage(0, 0, 2);
    for (let i = 0; i < 3; i++)
      assert.equal(fail(0), true, 'own success reset the count');
    for (let i = 0; i < 2; i++) {
      await provider.requestImage(2, 0, 2);
      assert.equal(fail(1), true);
    }
    await provider.requestImage(3, 0, 2);
    assert.equal(
      fail(1),
      false,
      'four failures exhaust this tile despite other successes',
    );
    h.settle();
    assert.equal(await stage, false);
    assert.equal(provider.errorEvent.size, 0);
    h.rendering.clear();
  });
}

for (const [id, product] of [
  ['weather-radar', 'radar'],
  ['weather-satellite', 'clouds-regional'],
  ['weather-satellite', 'clouds'],
  ['weather-lightning', 'lightning'],
]) {
  test(`${product} shows on 3D Tiles at street level and keeps its history through host changes`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    t.mock.method(Date, 'now', () => Date.parse(times[2]));
    const size =
      product === 'clouds'
        ? { width: 2048, height: 1024 }
        : { width: 4096, height: 2048 };
    let host;
    const h = renderingHarness({
      getHost: () => host,
      decodeImage: async () => ({ ...size, close() {} }),
    });
    host = { collection: new ImageryLayerCollection(), kind: 'tileset' };
    const camera = {
      moveEnd: event(),
      positionCartographic: { height: 1200 },
    };
    h.viewer.camera = camera;
    const events = target();
    const layer = createWeatherLayer({
      id,
      feed: { getSnapshot: async () => ({ ...snapshot, product }) },
      createRendering: () => h.rendering,
      documentRef: target({ hidden: false }),
      eventTarget: events,
      matchMedia: () => target({ matches: false }),
    });
    layer.init(h.viewer);
    layer.attachShellServices({ imageryHost: () => host });
    layer.setParams({ product });
    layer.enable();
    const update = layer.update();
    await flush();
    h.renderShells();
    await update;
    assert.equal(layer.getDiagnostics().time, times[2]);
    assert.equal(layer.getDiagnostics().host, 'shell');
    assert.equal(layer.getRowControls().summary.status, null);
    assert.doesNotMatch(layer.getRowControls().info, /Hidden/);
    const [shell] = h.shells();
    assert.equal(shell.show, true);

    layer.setParams({ play: true });
    t.mock.timers.tick(2000);
    await flush();
    assert.equal(
      layer.getDiagnostics().time,
      times[0],
      'history advances at street level',
    );
    camera.positionCartographic.height = 59_999;
    camera.moveEnd.emit();
    assert.equal(shell.show, true, 'no height gate');
    assert.equal(layer.getDiagnostics().playing, true);
    assert.equal(layer.getDiagnostics().timerActive, true);

    host = { collection: null, kind: 'none' };
    events.emit('gev:map-stack-changed');
    assert.equal(shell.show, false);
    assert.equal(layer.getRowControls().summary.status, NO_IMAGERY_HOST);
    assert.equal(layer.getDiagnostics().timerActive, false);
    host = { collection: h.viewer.imageryLayers, kind: 'globe' };
    events.emit('gev:map-stack-changed');
    assert.equal(shell.destroyed, true);
    assert.equal(
      layer.getDiagnostics().time,
      times[0],
      'the switch restages the shown history frame',
    );
    await flush();
    h.settle();
    await flush();
    assert.equal(layer.getDiagnostics().host, 'globe');
    assert.equal(layer.getDiagnostics().time, times[0]);
    assert.equal(layer.getDiagnostics().loading, false);
    layer.destroy();
    assert.equal(camera.moveEnd.size, 0);
    assert.equal(events.size, 0);
    assert.equal(h.shells().length, 0);
    assert.equal(h.postRender.size, 0);
  });
}

for (const outcome of [
  'fetch failure',
  'decode failure',
  'timeout',
  'abort',
  'supersede',
  'rehome',
]) {
  test(`mosaic ${outcome} retains the displayed frame and never installs a late decode`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const decode = deferred();
    let signal,
      closed = 0,
      host;
    const h = renderingHarness({
      getHost: () => host,
      fetchImpl: async (_url, options) => {
        signal = options.signal;
        if (outcome === 'fetch failure') throw new Error('offline');
        return mockResponse();
      },
      decodeImage: () => decode.promise,
    });
    host = { collection: h.viewer.imageryLayers, kind: 'globe' };
    const first = h.rendering.setFrame(snapshot, times[0]);
    h.settle();
    await first;
    const original = h.layers[0];
    const controller = new AbortController();
    const pending = h.rendering.setFrame(
      { ...snapshot, product: 'clouds' },
      times[1],
      { signal: controller.signal },
    );
    await flush();
    assert.deepEqual(h.layers, [original]);
    if (outcome === 'decode failure') decode.reject(new Error('bad png'));
    if (outcome === 'timeout') t.mock.timers.tick(25_000);
    if (outcome === 'abort') controller.abort();
    if (outcome === 'supersede')
      assert.equal(await h.rendering.setFrame(snapshot, times[0]), true);
    if (outcome === 'rehome') {
      host = {
        collection: renderingHarness().viewer.imageryLayers,
        kind: 'globe',
      };
      h.rendering.rehome();
    }
    assert.equal(await pending, false);
    assert.equal(signal.aborted, true);
    assert.equal(h.rendering.getDiagnostics().time, times[0]);
    assert.equal(original.alpha, 0.7);
    if (outcome !== 'decode failure') {
      decode.resolve({
        width: 2048,
        height: 1024,
        close() {
          closed++;
        },
      });
      await flush();
      if (outcome !== 'fetch failure') assert.equal(closed, 1);
    }
    assert.equal(host.collection.length, 1);
    h.rendering.clear();
    assert.equal(h.postRender.size, 0);
  });
}

test('regional transfer preserves deferrals, original Request, rejection and cancellation', async () => {
  const h = renderingHarness();
  const stage = h.rendering.setFrame(
    { ...snapshot, product: 'clouds-regional' },
    times[0],
  );
  const provider = h.providers[0];
  let cancelled = 0;
  const request = {
    cancel() {
      cancelled++;
    },
  };
  assert.equal(provider.requestImage(1, 2, 3, request), undefined);
  assert.deepEqual(provider.requestArgs, [1, 2, 3, request]);
  const image = { width: 256, height: 256 };
  provider.response = { promise: Promise.resolve(image) };
  const processed = await provider.requestImage(1, 2, 3, request);
  assert.equal(processed.source, image);
  assert.deepEqual([...processed.pixels], [194, 100, 0, 98]);
  const error = new Error('cancelled upstream');
  provider.response = { promise: Promise.reject(error) };
  await assert.rejects(
    provider.requestImage(0, 0, 0, request),
    (cause) => cause === error,
  );
  provider.response = deferred();
  const late = provider.requestImage(0, 0, 0, request);
  h.rendering.clear();
  assert.equal(cancelled, 1);
  provider.response.resolve(image);
  assert.equal(await late, image, 'closed frames do not process late images');
  assert.equal(await stage, false);
});

test('regional tiles decoded as flipped ImageBitmaps are drawn back upright', async () => {
  const hadBitmap = Object.hasOwn(globalThis, 'ImageBitmap');
  const previous = globalThis.ImageBitmap;
  globalThis.ImageBitmap = class ImageBitmap {
    width = 256;
    height = 256;
  };
  try {
    const h = renderingHarness();
    void h.rendering.setFrame(
      { ...snapshot, product: 'clouds-regional' },
      times[0],
    );
    const provider = h.providers[0];
    // Cesium decodes with imageOrientation 'flipY'; the canvas upload flips again.
    provider.response = { promise: Promise.resolve(new ImageBitmap()) };
    const bitmapTile = await provider.requestImage(0, 0, 0, {});
    assert.deepEqual(bitmapTile.drawnWith, [1, 0, 0, -1, 0, 256]);
    // An HTMLImageElement fallback is not pre-flipped.
    provider.response = {
      promise: Promise.resolve({ width: 256, height: 256 }),
    };
    const imageTile = await provider.requestImage(1, 0, 0, {});
    assert.equal(imageTile.drawnWith, null);
    h.rendering.clear();
  } finally {
    if (hadBitmap) globalThis.ImageBitmap = previous;
    else delete globalThis.ImageBitmap;
  }
});

for (const kind of ['globe']) {
  test(`infrared mode restages the same time on ${kind}, retaining the old layer for one rendered frame`, async () => {
    let host,
      now = 0;
    const h = renderingHarness({ getHost: () => host, now: () => now });
    host = { collection: h.viewer.imageryLayers, kind };
    const clouds = { ...snapshot, product: 'clouds' };
    const first = h.rendering.setFrame(clouds, times[0]);
    await flush();
    await h.providers[0].requestImage(0, 0, 0);
    now = 250;
    h.settle();
    await first;
    const previous = h.layers[0];
    assert.equal(await h.rendering.setFrame(clouds, times[0]), true);
    assert.equal(h.providers.length, 1);
    const full = h.rendering.setFrame(clouds, times[0], { infrared: 'full' });
    await flush();
    const tile = await h.providers[1].requestImage(0, 0, 0);
    assert.deepEqual([...tile.source.pixels], [194, 100, 0, 200]);
    now = 500;
    h.settle();
    assert.equal(await full, true);
    assert.equal(h.layers.length, 2);
    assert.equal(h.layers[1].alpha, 0.7);
    assert.equal(previous.destroyed, undefined);
    assert.equal(h.rendering.getDiagnostics().infrared, 'full');
    h.postRender.emit();
    assert.equal(h.layers.length, 1);
    assert.equal(previous.destroyed, true);
    h.rendering.clear();
    assert.equal(h.postRender.size, 0);
  });
}

test('satellite mode chips restage history without changing time or latest-follow intent', async () => {
  const h = layerHarness({ id: 'weather-satellite' });
  const update = h.layer.update();
  await flush();
  h.stages[0].finish();
  await update;
  h.layer.setParams({ step: -1 });
  h.stages[1].finish();
  await flush();
  h.layer.setParams({ infrared: 'full' });
  assert.equal(h.stages[2].time, times[1]);
  assert.equal(h.stages[2].infrared, 'full');
  assert.equal(h.layer.getParams().infrared, 'full');
  assert.deepEqual(
    h.layer
      .getRowControls()
      .chips.slice(0, 4)
      .map((chip) => chip.label),
    ['N. America', 'Global', 'Clouds only', 'Full'],
  );
  h.stages[2].finish();
  await flush();
  assert.equal(h.layer.getDiagnostics().followLatest, false);
  assert.equal(h.layer.getDiagnostics().time, times[1]);
  h.layer.setParams({ infrared: 'invalid' });
  assert.equal(h.layer.getParams().infrared, 'full');
  assert.equal(h.stages.length, 3);
  h.layer.destroy();
});

test('a rapid third selection waits for retirement before installing, and clear cancels that wait', async () => {
  for (const clear of [false, true]) {
    const h = renderingHarness();
    const first = h.rendering.setFrame(snapshot, times[0]);
    h.settle();
    await first;
    const second = h.rendering.setFrame(snapshot, times[1]);
    h.settle();
    await second;
    assert.equal(h.layers.length, 2);
    const third = h.rendering.setFrame(snapshot, times[2]);
    assert.equal(h.layers.length, 2);
    assert.equal(
      h.providers.length,
      2,
      'third provider waits for outgoing retirement',
    );
    if (clear) {
      h.rendering.clear();
      assert.equal(await third, false);
      h.postRender.emit();
      assert.equal(h.layers.length, 0);
      assert.equal(h.postRender.size, 0);
    } else {
      h.postRender.emit();
      assert.equal(h.layers.length, 2);
      assert.equal(h.providers.length, 3);
      h.settle();
      assert.equal(await third, true);
      h.postRender.emit();
      assert.equal(h.layers.length, 1);
      h.rendering.clear();
    }
  }
});

test('a delayed installation failure retains the replacement and does not throw from postRender', async () => {
  const h = renderingHarness();
  for (const time of times.slice(0, 2)) {
    const stage = h.rendering.setFrame(snapshot, time);
    h.settle();
    assert.equal(await stage, true);
  }
  const third = h.rendering.setFrame(snapshot, times[2]);
  h.viewer.imageryLayers.addImageryProvider = () => {
    throw new Error('upload unavailable');
  };
  assert.doesNotThrow(() => h.postRender.emit());
  assert.equal(await third, false);
  assert.equal(h.layers.length, 1);
  assert.equal(h.layers[0].alpha, 0.7);
  assert.equal(h.rendering.getDiagnostics().time, times[1]);
  h.rendering.clear();
});

test('one row steps every registered observation; missing frames hide and latest restores each product', async (t) => {
  const clock = createWeatherClock();
  const radar = layerHarness({ clock });
  const satellite = layerHarness({
    clock,
    id: 'weather-satellite',
    feed: {
      getSnapshot: async () => ({
        ...snapshot,
        product: 'clouds-regional',
        times: [times[1]],
        latest: times[1],
      }),
    },
  });
  t.after(() => {
    radar.layer.destroy();
    satellite.layer.destroy();
    clock.destroy();
  });
  const updates = [radar.layer.update(), satellite.layer.update()];
  await flush();
  radar.stages.at(-1).finish();
  satellite.stages.at(-1).finish();
  await Promise.all(updates);
  let satelliteChanges = 0;
  satellite.layer.setRowControlsListener(() => satelliteChanges++);
  const transport = (h) =>
    h.layer
      .getRowControls()
      .chips.filter(({ id }) =>
        ['previous', 'play', 'next', 'latest'].includes(id),
      );
  radar.layer.setParams({ step: -1 });
  await flush();
  assert.equal(clock.getState().target, times[1]);
  assert.equal(radar.stages.at(-1).time, times[1]);
  assert.equal(satellite.stages.at(-1).time, times[1]);
  radar.stages.at(-1).finish();
  satellite.stages.at(-1).finish();
  await flush();
  assert.match(satellite.layer.getRowControls().summary.detail, /synced/);
  assert.ok(satelliteChanges > 0);
  assert.deepEqual(transport(radar), []);
  assert.deepEqual(transport(satellite), []);
  satellite.layer.setParams({ step: -1 });
  await flush();
  radar.stages.at(-1).finish();
  await flush();
  assert.equal(clock.getState().target, times[0]);
  assert.equal(satellite.layer.getDiagnostics().hidden, true);
  assert.match(
    satellite.layer.getRowControls().summary.status,
    /No frame within 30 min of 09-15 20:00 UTC/,
  );
  radar.layer.setParams({ step: 1 });
  await flush();
  radar.stages.at(-1).finish();
  satellite.stages.at(-1).finish();
  await flush();
  assert.equal(satellite.layer.getDiagnostics().hidden, false);
  radar.layer.setParams({ latest: true });
  await flush();
  radar.stages.at(-1).finish();
  satellite.stages.at(-1).finish();
  await flush();
  assert.deepEqual(
    [radar.layer.getDiagnostics().time, satellite.layer.getDiagnostics().time],
    [times[2], times[1]],
  );
  assert.deepEqual(radar.layer.getDiagnostics().clock, {
    mode: 'latest',
    target: null,
    playing: false,
  });
  assert.deepEqual(
    radar.layer.getParams(),
    { source: 'nowcoast', opacity: 'strong' },
    'history is never serialized',
  );
  satellite.layer.disable();
  assert.equal(clock.getState().products.length, 1);
});

test('history manifest expiry hides imagery without jumping to latest; host resume keeps the target', async (t) => {
  const clock = createWeatherClock();
  let value = snapshot;
  const h = layerHarness({ clock, feed: { getSnapshot: async () => value } });
  t.after(() => {
    h.layer.destroy();
    clock.destroy();
  });
  let update = h.layer.update();
  await flush();
  h.stages.at(-1).finish();
  await update;
  const history = clock.setTarget(times[0]);
  await flush();
  h.stages.at(-1).finish();
  await history;
  value = { ...snapshot, times: [times[2]] };
  await h.layer.update();
  assert.equal(h.layer.getDiagnostics().hidden, true);
  assert.equal(clock.getState().target, times[0]);
  h.documentRef.hidden = true;
  h.documentRef.emit('visibilitychange');
  await flush();
  assert.deepEqual(clock.getTimeline(), []);
  h.documentRef.hidden = false;
  h.documentRef.emit('visibilitychange');
  await flush();
  assert.equal(clock.getState().target, times[0]);
  assert.equal(h.layer.getDiagnostics().hidden, true);
  value = snapshot;
  update = h.layer.update();
  await flush();
  h.stages.at(-1).finish();
  await update;
  assert.equal(h.layer.getDiagnostics().time, times[0]);
});

test('hidden renderer retains the frame without displaying it and rehome cannot reveal it', async () => {
  const h = renderingHarness();
  const first = h.rendering.setFrame(snapshot, times[0]);
  h.settle();
  await first;
  const layer = h.layers[0];
  const pending = h.rendering.setFrame(snapshot, times[1]);
  h.rendering.setHidden(true);
  assert.equal(await pending, false);
  assert.equal(h.layers.length, 1);
  assert.equal(h.layers[0], layer);
  assert.equal(layer.show, false);
  assert.equal(h.rendering.getDiagnostics().time, null);
  h.rendering.rehome();
  assert.equal(layer.show, false);
  h.rendering.setHidden(false);
  assert.equal(layer.show, true);
  assert.equal(h.rendering.getDiagnostics().time, times[0]);
  h.rendering.clear();
});

test('satellite global selection uses the three-hour gap and preserves the shared target on product changes', async (t) => {
  const clock = createWeatherClock();
  const earlier = '2026-09-15T18:00:00.000Z';
  const h = layerHarness({
    clock,
    id: 'weather-satellite',
    feed: {
      getSnapshot: async ({ product }) => ({
        ...snapshot,
        product,
        times: [earlier],
        latest: earlier,
      }),
    },
  });
  t.after(() => {
    h.layer.destroy();
    clock.destroy();
  });
  const update = h.layer.update();
  await flush();
  h.stages.at(-1).finish();
  await update;
  await clock.setTarget(times[0]);
  assert.equal(
    h.layer.getDiagnostics().hidden,
    true,
    'two-hour regional gap is ineligible',
  );
  h.layer.setParams({ product: 'clouds' });
  await flush();
  assert.equal(h.stages.at(-1).time, earlier);
  h.stages.at(-1).finish();
  await flush();
  assert.equal(clock.getState().target, times[0]);
  assert.equal(h.layer.getDiagnostics().hidden, false);
  assert.match(h.layer.getRowControls().summary.detail, /18:00 UTC.*nearest/);
  const params = h.layer.getParams();
  assert.equal(params.product, 'clouds');
  assert.equal(params.target, undefined);
});

test('switching to history cancels a still-loading latest refresh and a later target cancels the first history load', async (t) => {
  const clock = createWeatherClock();
  const h = layerHarness({ clock });
  t.after(() => {
    h.layer.destroy();
    clock.destroy();
  });
  const update = h.layer.update();
  await flush();
  const latest = h.stages.at(-1);
  const oldHistory = clock.setTarget(times[0]);
  await flush();
  assert.equal(latest.signal.aborted, true);
  const oldStage = h.stages.at(-1);
  const current = clock.setTarget(times[1]);
  await flush();
  assert.equal(oldStage.signal.aborted, true);
  h.stages.at(-1).finish();
  await current;
  latest.finish();
  oldStage.finish();
  await oldHistory;
  await update;
  assert.equal(h.layer.getDiagnostics().time, times[1]);
  assert.equal(h.layer.getDiagnostics().clock.target, times[1]);
});

test('observed descriptors keep configuration only and label satellite clouds by coverage', async () => {
  for (const [id, coverage, hasKey] of [
    ['weather-radar', 'CONUS', false],
    ['weather-radar', 'CONUS', true],
    ['weather-satellite', 'North America', false],
    ['weather-lightning', 'Americas + Pacific', false],
    ['weather-lightning', 'Americas + Pacific', true],
  ]) {
    const h = layerHarness({
      id,
      feed: xweatherFeed(xweatherStatus({ hasKey })).feed,
    });
    void h.layer.update();
    await flush();
    const controls = h.layer.getRowControls();
    assert.equal(controls.readout, true);
    assert.equal(controls.summary.coverage, coverage);
    assert.equal(controls.summary.sections, undefined);
    assert.deepEqual(
      controls.summary.settings.map(({ label }) => label),
      id === 'weather-satellite'
        ? ['REGION', 'IMAGE', 'OPACITY']
        : hasKey
          ? ['SOURCE', 'OPACITY']
          : ['OPACITY'],
    );
    assert.deepEqual(
      controls.summary.settings.flatMap(({ chips }) => chips),
      controls.chips.filter(({ id }) => id !== 'coverage'),
    );
    assert.deepEqual(controls.summary.actions, [
      controls.chips.find(({ id }) => id === 'coverage'),
    ]);
    assert.deepEqual(controls.summary.actions[0].params, { focus: true });
    assert.equal(
      controls.chips.some(({ id }) =>
        ['previous', 'play', 'next', 'latest'].includes(id),
      ),
      false,
    );
    if (id === 'weather-satellite') {
      assert.equal(h.layer.name, 'Satellite clouds');
      assert.equal(controls.summary.label, 'Satellite clouds');
      assert.match(
        controls.infoTitle,
        /GOES-19\/18 longwave infrared Band 14 regional; NESDIS global longwave mosaic/,
      );
      assert.equal(
        controls.chips.find(({ id }) => id === 'filtered').title,
        'Dim everything but the bright, cold cloud tops; a brightness filter, not a cloud mask',
      );
      h.layer.setParams({ product: 'clouds' });
      assert.equal(
        h.layer.getRowControls().summary.coverage,
        'Global · 60°S–60°N',
      );
      assert.equal(h.layer.getRowControls().summary.maxGapMinutes, 180);
    }
    h.layer.destroy();
  }
});

const xweatherStatus = (extra = {}) => ({
  hasKey: true,
  month: '2026-09',
  used: 0,
  allowance: 15_000,
  over: false,
  upstreamError: null,
  ...extra,
});
// Frames a few minutes old, so freshness warnings stay out of the way.
const recentTimes = () =>
  [10, 5, 1].map((minutes) =>
    new Date(
      Math.floor((Date.now() - minutes * 60_000) / 1000) * 1000,
    ).toISOString(),
  );
function xweatherFeed(status, timesFor) {
  const products = [];
  const recent = recentTimes();
  const feed = {
    status,
    statusCalls: 0,
    stale: false,
    getXweatherStatus: async ({ signal } = {}) => {
      feed.statusCalls++;
      return typeof feed.status === 'function'
        ? feed.status({ signal })
        : feed.status;
    },
    getSnapshot: async ({ product }) => {
      products.push(product);
      const advertised = timesFor?.(product) ?? recent;
      return {
        ...snapshot,
        product,
        times: advertised,
        latest: advertised.at(-1),
        ...(feed.stale ? { stale: true } : {}),
      };
    },
  };
  return { feed, products };
}
async function settle(h) {
  for (let i = 0; i < 4; i++) {
    await flush();
    for (const stage of h.stages) stage.finish();
  }
  await flush();
}
const later = (t, ms) => {
  const now = Date.now();
  t.mock.method(Date, 'now', () => now + ms);
};

test('the source setting appears only when an Xweather key is present', async () => {
  for (const hasKey of [false, true]) {
    const h = layerHarness({
      feed: xweatherFeed(xweatherStatus({ hasKey })).feed,
    });
    void h.layer.update();
    await settle(h);
    const { settings } = h.layer.getRowControls().summary;
    assert.deepEqual(
      settings.map(({ label }) => label),
      hasKey ? ['SOURCE', 'OPACITY'] : ['OPACITY'],
    );
    if (hasKey)
      assert.deepEqual(
        settings[0].chips.map(({ label, title }) => [label, title]),
        [
          ['NOAA', 'NOAA nowCOAST · keyless'],
          [
            'Global (Xweather)',
            "Vaisala Xweather · uses your key, counts toward your account's free monthly allowance",
          ],
        ],
      );
    h.layer.destroy();
  }
});

test('choosing Global (Xweather) restages the card on the xweather product and keeps the clock target', async (t) => {
  const clock = createWeatherClock();
  const credited = [];
  const { feed, products } = xweatherFeed(xweatherStatus(), () => times);
  const h = layerHarness({
    clock,
    feed,
    credits: {
      registerDynamicCredit: (_viewer, credit) => credited.push(credit.key),
      XWEATHER_CREDIT: { key: 'xweather', html: 'Vaisala Xweather' },
    },
  });
  t.after(() => {
    h.layer.destroy();
    clock.destroy();
  });
  void h.layer.update();
  await settle(h);
  const moved = clock.setTarget(times[1]);
  await settle(h);
  await moved;
  assert.deepEqual(credited, []);
  const before = products.length;
  h.layer.setParams({ source: 'xweather' });
  await settle(h);
  assert.equal(products[before], 'xweather-radar');
  assert.equal(clock.getState().target, times[1]);
  assert.equal(h.layer.getParams().source, 'xweather');
  assert.equal(h.layer.getRowControls().summary.label, 'Rain radar · Global');
  assert.equal(h.layer.getStats().source, 'Vaisala Xweather');
  assert.deepEqual(credited, ['xweather']);
});

test('losing the key falls back to NOAA with a status line and no Xweather request', async (t) => {
  const { feed, products } = xweatherFeed(xweatherStatus());
  const h = layerHarness({ feed });
  t.after(() => h.layer.destroy());
  void h.layer.update();
  await settle(h);
  h.layer.setParams({ source: 'xweather' });
  await settle(h);
  assert.equal(products.at(-1), 'xweather-radar');
  feed.status = xweatherStatus({ hasKey: false });
  later(t, 61_000);
  const before = products.length;
  void h.layer.update();
  await settle(h);
  assert.equal(h.layer.getParams().source, 'nowcoast');
  assert.equal(
    h.layer.getRowControls().summary.status,
    'Xweather key removed · showing NOAA',
  );
  assert.deepEqual(
    products.slice(before).filter((product) => product.startsWith('xweather')),
    [],
  );
  assert.equal(products.at(-1), 'radar');
});

test('the budget line shows free-month usage and warns past it', async (t) => {
  const { feed } = xweatherFeed(
    xweatherStatus({ used: 4210, allowance: 15000, over: false }),
  );
  const h = layerHarness({ id: 'weather-lightning', feed });
  t.after(() => h.layer.destroy());
  const budget = () =>
    h.layer
      .getRowControls()
      .summary.lines.find(({ id }) => id === 'xweather-budget');
  void h.layer.update();
  await settle(h);
  h.layer.setParams({ source: 'xweather' });
  await settle(h);
  assert.deepEqual(budget(), {
    id: 'xweather-budget',
    text: 'Xweather · 4,210 / 15,000 free this month',
    muted: true,
  });
  feed.status = xweatherStatus({ used: 15001, allowance: 15000, over: true });
  later(t, 61_000);
  void h.layer.update();
  await settle(h);
  assert.deepEqual(budget(), {
    id: 'xweather-budget',
    text: 'Xweather · past the free 15,000 this month · requests may fail',
    muted: false,
  });
  feed.status = xweatherStatus({ upstreamError: 'HTTP 401' });
  Date.now.mock.restore();
  later(t, 122_000);
  void h.layer.update();
  await settle(h);
  assert.equal(
    h.layer.getRowControls().summary.status,
    'Xweather refused the request · see Provider Settings',
  );
});

test('an Xweather refusal outranks the frame error it causes; without one the frame error shows', async (t) => {
  const { feed } = xweatherFeed(
    xweatherStatus({ upstreamError: 'xweather_upstream_error' }),
  );
  const noaa = feed.getSnapshot;
  feed.getSnapshot = async (options) =>
    options.product.startsWith('xweather')
      ? { ...snapshot, product: options.product, unavailable: true }
      : noaa(options);
  const h = layerHarness({ feed });
  t.after(() => h.layer.destroy());
  void h.layer.update();
  await settle(h);
  h.layer.setParams({ source: 'xweather' });
  await settle(h);
  assert.equal(
    h.layer.getRowControls().summary.status,
    'Xweather refused the request · see Provider Settings',
  );
  feed.status = xweatherStatus();
  later(t, 61_000);
  void h.layer.update();
  await settle(h);
  assert.equal(
    h.layer.getRowControls().summary.status,
    'Weather source unavailable; previous observation retained',
  );
});

test('a keyless s.x link over a stale NOAA feed reports the stale source, not the fallback', async (t) => {
  const { feed, products } = xweatherFeed(xweatherStatus({ hasKey: false }));
  feed.stale = true;
  const h = layerHarness({ feed });
  t.after(() => h.layer.destroy());
  h.layer.setParams({ source: 'xweather' });
  await settle(h);
  assert.deepEqual(products, ['radar']);
  assert.equal(h.layer.getParams().source, 'nowcoast');
  assert.equal(h.layer.getRowControls().summary.status, 'Stale source');
});

test('a keyless s.x share link enabled through the lifecycle ends on NOAA with the fallback notice', async (t) => {
  const { feed, products } = xweatherFeed(xweatherStatus({ hasKey: false }));
  const h = layerHarness({ feed, managed: true });
  const lifecycle = new LayerLifecycle(h.viewer);
  lifecycle.register(h.layer);
  lifecycle.finalizeRegistrations([
    { id: 'weather-radar', disposition: 'enabled+options' },
  ]);
  const errors = [];
  t.mock.method(console, 'error', (...args) => errors.push(args.join(' ')));
  t.mock.method(console, 'warn', (...args) => errors.push(args.join(' ')));
  t.after(() => lifecycle.destroyAll());
  let done = false;
  const restored = lifecycle
    .restoreLayerState(
      'weather-radar',
      { enabled: true, params: { source: 'xweather' } },
      { origin: 'restore' },
    )
    .finally(() => {
      done = true;
    });
  for (let i = 0; i < 20 && !done; i++) await settle(h);
  const result = await restored;
  assert.equal(result.succeeded, true);
  assert.equal(result.settledEnabled, true);
  assert.equal(lifecycle.isEnabled('weather-radar'), true);
  assert.deepEqual(errors, []);
  assert.deepEqual(products, ['radar']);
  assert.equal(h.layer.getParams().source, 'nowcoast');
  assert.ok(h.layer.getDiagnostics().time);
  assert.equal(
    h.layer.getRowControls().summary.status,
    'Xweather key removed · showing NOAA',
  );
});

test('the key-removed notice clears a poll interval after the first NOAA frame', async (t) => {
  const { feed } = xweatherFeed(xweatherStatus({ hasKey: false }));
  const h = layerHarness({ feed });
  t.after(() => h.layer.destroy());
  h.layer.setParams({ source: 'xweather' });
  await settle(h);
  assert.ok(h.layer.getDiagnostics().time);
  assert.equal(
    h.layer.getRowControls().summary.status,
    'Xweather key removed · showing NOAA',
  );
  later(t, 59_000);
  assert.equal(
    h.layer.getRowControls().summary.status,
    'Xweather key removed · showing NOAA',
  );
  Date.now.mock.restore();
  later(t, 61_000);
  assert.equal(h.layer.getRowControls().summary.status, null);
});

test('a failed or aborted status request keeps the last known status and retries next update', async (t) => {
  const { feed } = xweatherFeed(xweatherStatus({ used: 4210 }));
  const h = layerHarness({ feed });
  t.after(() => h.layer.destroy());
  const labels = () =>
    h.layer.getRowControls().summary.settings.map(({ label }) => label);
  void h.layer.update();
  await settle(h);
  h.layer.setParams({ source: 'xweather' });
  await settle(h);
  assert.deepEqual(labels(), ['SOURCE', 'OPACITY']);
  // An update superseded while its status request is in flight.
  feed.status = ({ signal }) =>
    new Promise((_resolve, reject) =>
      signal.addEventListener('abort', () => reject(signal.reason), {
        once: true,
      }),
    );
  later(t, 61_000);
  void h.layer.update();
  await flush();
  void h.layer.update();
  await settle(h);
  assert.deepEqual(labels(), ['SOURCE', 'OPACITY']);
  assert.equal(
    h.layer
      .getRowControls()
      .summary.lines.find(({ id }) => id === 'xweather-budget').text,
    'Xweather · 4,210 / 15,000 free this month',
  );
  // A thrown status is retried on the very next update, not a minute later.
  feed.status = async () => {
    throw new Error('Xweather status HTTP 502');
  };
  const calls = feed.statusCalls;
  void h.layer.update();
  await settle(h);
  void h.layer.update();
  await settle(h);
  assert.equal(feed.statusCalls, calls + 2);
  assert.equal(h.layer.getParams().source, 'xweather');
  assert.deepEqual(labels(), ['SOURCE', 'OPACITY']);
});

test('history target between Xweather frames selects the latest within the gap, else nothing', async (t) => {
  const clock = createWeatherClock();
  const radar = layerHarness({
    clock,
    feed: xweatherFeed(xweatherStatus(), (product) =>
      product === 'xweather-radar'
        ? ['2026-09-24T16:28:34.000Z', '2026-09-24T16:30:34.000Z']
        : ['2026-09-24T16:30:00.000Z'],
    ).feed,
  });
  const lightning = layerHarness({
    clock,
    id: 'weather-lightning',
    feed: xweatherFeed(xweatherStatus(), () => ['2026-09-24T16:30:00.000Z'])
      .feed,
  });
  t.after(() => {
    radar.layer.destroy();
    lightning.layer.destroy();
    clock.destroy();
  });
  radar.layer.setParams({ source: 'xweather' });
  void lightning.layer.update();
  await settle(radar);
  await settle(lightning);
  const selected = clock.setTarget('2026-09-24T16:29:00.000Z');
  await settle(radar);
  await settle(lightning);
  await selected;
  assert.equal(
    clock.selectFor('weather-radar', clock.getState().target),
    '2026-09-24T16:28:34.000Z',
  );
  assert.equal(
    clock.selectFor('weather-lightning', clock.getState().target),
    null,
  );
  assert.equal(
    clock.selectFor('weather-radar', '2026-09-24T17:01:35.000Z'),
    null,
  );
});

const globalSnapshot = { ...snapshot, product: 'clouds' };
async function showMosaic(h, time, infrared = 'filtered') {
  const pending = h.rendering.setFrame(globalSnapshot, time, { infrared });
  await flush();
  h.settle();
  assert.equal(await pending, true);
  h.settle();
}

test('mosaic cache skips fetch and decode, separates modes, evicts LRU at 6 and clears per instance', async (t) => {
  let fetches = 0,
    decodes = 0;
  const h = renderingHarness({
    fetchImpl: async () => {
      fetches++;
      return mockResponse();
    },
    decodeImage: async () => {
      decodes++;
      return { width: 2048, height: 1024 };
    },
  });
  t.after(() => h.rendering.clear());
  await showMosaic(h, times[0]);
  await showMosaic(h, times[1]);
  await showMosaic(h, times[0]);
  assert.equal(fetches, 2);
  assert.equal(decodes, 2);
  assert.deepEqual(h.rendering.getDiagnostics().mosaic, {
    fetched: false,
    cached: true,
    decodeMs: 0,
  });
  await showMosaic(h, times[0], 'full');
  assert.equal(fetches, 3);
  assert.equal(h.rendering.getDiagnostics().mosaic.cached, false);
  await showMosaic(h, times[0]);
  const extra = Array.from({ length: 4 }, (_, i) =>
    new Date(Date.parse(times[2]) + i * 3600_000).toISOString(),
  );
  for (const time of extra) await showMosaic(h, time);
  assert.deepEqual(h.rendering.getDiagnostics().cache, {
    mosaics: 6,
    prefetching: false,
  });
  await showMosaic(h, times[0]);
  assert.equal(
    fetches,
    7,
    'touching the oldest frame retained it ahead of the second frame',
  );
  await showMosaic(h, times[1]);
  assert.equal(fetches, 8, 'least recently used frame was evicted');
  h.rendering.clear();
  assert.deepEqual(h.rendering.getDiagnostics().cache, {
    mosaics: 0,
    prefetching: false,
  });
  await showMosaic(h, times[0]);
  assert.equal(fetches, 9);
  const other = renderingHarness({
    fetchImpl: async () => {
      fetches++;
      return mockResponse();
    },
  });
  t.after(() => other.rendering.clear());
  await showMosaic(other, times[0]);
  assert.equal(fetches, 10, 'instances do not share canvases');
});

test('global prefetch warms a decoded frame without staging imagery and hits on selection', async (t) => {
  let fetches = 0;
  const h = renderingHarness({
    fetchImpl: async () => {
      fetches++;
      return mockResponse();
    },
  });
  t.after(() => h.rendering.clear());
  await showMosaic(h, times[0]);
  const warm = h.rendering.prefetch(globalSnapshot, times[1]);
  assert.equal(h.rendering.getDiagnostics().cache.prefetching, true);
  assert.equal(h.rendering.getDiagnostics().time, times[0]);
  assert.equal(h.layers.length, 1);
  assert.equal(await warm, true);
  await showMosaic(h, times[1]);
  assert.equal(fetches, 2);
  assert.equal(h.rendering.getDiagnostics().mosaic.cached, true);
  assert.equal(h.rendering.getDiagnostics().mosaic.decodeMs, 0);
});

test('cancelled or cleared speculative decodes cannot repopulate the cache', async () => {
  for (const cancel of ['cancelPrefetch', 'clear', 'setHidden']) {
    const decoded = deferred();
    let signal,
      closes = 0;
    const h = renderingHarness({
      fetchImpl: async (_url, options) => {
        signal = options.signal;
        return mockResponse();
      },
      decodeImage: () => decoded.promise,
    });
    const warm = h.rendering.prefetch(globalSnapshot, times[0]);
    await flush();
    h.rendering[cancel](true);
    assert.equal(signal.aborted, true);
    decoded.resolve({
      width: 2048,
      height: 1024,
      close() {
        closes++;
      },
    });
    assert.equal(await warm, false);
    assert.equal(closes, 1);
    assert.deepEqual(h.rendering.getDiagnostics().cache, {
      mosaics: 0,
      prefetching: false,
    });
    h.rendering.clear();
  }
});

test('tiled prefetch covers only visible product bounds at levels 0/1, caps eight requests and drains bodies', async (t) => {
  const calls = [];
  let bodies = 0;
  const h = renderingHarness({
    fetchImpl: async (url, { signal }) => {
      calls.push({ url: new URL(url, 'http://localhost'), signal });
      return {
        ...mockResponse(),
        arrayBuffer: async () => {
          bodies++;
          return new ArrayBuffer(1);
        },
      };
    },
  });
  t.after(() => h.rendering.clear());
  h.viewer.camera = {
    computeViewRectangle: () =>
      Cesium.Rectangle.fromDegrees(-120, 25, -100, 50),
  };
  assert.equal(await h.rendering.prefetch(snapshot, times[1]), true);
  assert.equal(calls.length, 2);
  assert.equal(bodies, 2);
  assert.deepEqual(
    calls.map(({ url }) =>
      ['z', 'x', 'y'].map((key) => url.searchParams.get(key)),
    ),
    [
      ['0', '0', '0'],
      ['1', '0', '0'],
    ],
  );
  assert.ok(
    calls.every(({ url }) => url.searchParams.get('time') === times[1]),
  );
  assert.equal(
    await h.rendering.prefetch(snapshot, times[1]),
    false,
    'same completed work is not repeated',
  );
  h.viewer.camera.computeViewRectangle = () =>
    Cesium.Rectangle.fromDegrees(100, 25, 120, 50);
  await h.rendering.prefetch(snapshot, times[2]);
  assert.equal(calls.length, 2, 'view outside product bounds fetches nothing');
  h.viewer.camera.computeViewRectangle = () => Cesium.Rectangle.MAX_VALUE;
  const world = {
    ...snapshot,
    bounds: { west: -180, south: -90, east: 180, north: 90 },
  };
  await h.rendering.prefetch(world, times[2]);
  assert.equal(
    calls.length,
    10,
    'world view is capped at eight additional requests',
  );
  assert.equal(bodies, 10);
  assert.equal(new Set(calls.slice(2).map(({ url }) => url.href)).size, 8);
});

test('prefetch is best effort, aborts on replacement or host suspension, and skips hidden frames', async (t) => {
  let host = { collection: null, kind: 'globe' };
  const signals = [];
  const h = renderingHarness({
    getHost: () => host,
    fetchImpl: (_url, { signal }) =>
      new Promise((_, reject) => {
        signals.push(signal);
        signal.addEventListener('abort', () => reject(signal.reason), {
          once: true,
        });
      }),
  });
  host.collection = h.viewer.imageryLayers;
  t.after(() => h.rendering.clear());
  const first = h.rendering.prefetch(snapshot, times[1]);
  const shown = h.rendering.setFrame(snapshot, times[0]);
  h.settle();
  assert.equal(
    await shown,
    true,
    'current frame never waits for speculative work',
  );
  assert.equal(await first, false);
  assert.ok(signals.every((signal) => signal.aborted));
  const second = h.rendering.prefetch(snapshot, times[1]);
  host = { collection: null, kind: 'none' };
  h.rendering.rehome();
  assert.equal(await second, false);
  const count = signals.length;
  assert.equal(await h.rendering.prefetch(snapshot, times[2]), false);
  host = { collection: h.viewer.imageryLayers, kind: 'globe' };
  h.rendering.setHidden(true);
  assert.equal(await h.rendering.prefetch(snapshot, times[2]), false);
  assert.equal(signals.length, count);
  assert.equal(h.rendering.getDiagnostics().cache.prefetching, false);
});

test('failed prefetch leaves the current frame and errors unchanged and releases its deadline', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = renderingHarness({
    fetchImpl: async () => {
      throw new Error('offline');
    },
  });
  t.after(() => h.rendering.clear());
  const shown = h.rendering.setFrame(snapshot, times[0]);
  h.settle();
  await shown;
  const before = h.rendering.getDiagnostics();
  assert.equal(await h.rendering.prefetch(snapshot, times[1]), false);
  assert.deepEqual(h.rendering.getDiagnostics(), before);
  t.mock.timers.tick(30_000);
  assert.deepEqual(h.rendering.getDiagnostics(), before);
});

test('layer warms the next advertised observation only after a successful playing frame, wrapping at the end', async (t) => {
  const clock = createWeatherClock();
  const h = layerHarness({ clock });
  const warmed = [];
  let cancels = 0;
  h.rendering.prefetch = async (manifest, time, options) => {
    warmed.push({ manifest, time, options });
  };
  h.rendering.cancelPrefetch = () => {
    cancels++;
  };
  t.after(() => {
    h.layer.destroy();
    clock.destroy();
  });
  const updated = h.layer.update();
  await flush();
  h.stages.at(-1).finish();
  await updated;
  assert.equal(warmed.length, 0);
  const play = clock.play();
  await flush();
  assert.equal(warmed.length, 0, 'still staging');
  h.stages.at(-1).finish();
  await play;
  assert.deepEqual(
    warmed.map(({ time }) => time),
    [times[0]],
  );
  assert.deepEqual(warmed[0].options, { infrared: 'filtered' });
  const next = clock.setTarget(times[0]);
  await flush();
  h.stages.at(-1).finish();
  await next;
  assert.deepEqual(
    warmed.map(({ time }) => time),
    [times[0], times[1]],
  );
  const failed = clock.setTarget(times[1]);
  await flush();
  h.stages.at(-1).finish(false);
  await failed;
  assert.equal(warmed.length, 2);
  const priorCancels = cancels;
  clock.pause();
  assert.ok(cancels > priorCancels);
  const paused = clock.setTarget(times[2]);
  await flush();
  h.stages.at(-1).finish();
  await paused;
  assert.equal(warmed.length, 2);
  await clock.play();
  h.documentRef.hidden = true;
  h.documentRef.emit('visibilitychange');
  await flush();
  h.stages.at(-1).finish();
  await flush();
  assert.equal(warmed.length, 2, 'hidden products do not prefetch');
});

for (const product of ['radar', 'clouds-regional', 'lightning']) {
  test(`${product} on the globe host uses 256 px tiles to level 6`, async (t) => {
    const collection = new ImageryLayerCollection();
    const h = renderingHarness({
      getHost: () => ({ collection, kind: 'globe' }),
    });
    t.after(() => h.rendering.clear());
    h.viewer.camera = {
      moveEnd: event(),
      positionCartographic: { height: 60_000 },
    };
    const pending = h.rendering.setFrame({ ...snapshot, product }, times[0]);
    const options = h.providers[0].options;
    assert.equal(options.tileWidth, 256);
    assert.equal(options.tileHeight, 256);
    assert.equal(options.maximumLevel, 6);
    assert.equal(
      new URL(options.url, 'https://example.test').searchParams.get('size'),
      '256',
    );
    assert.equal(h.rendering.getDiagnostics().host, 'globe');
    h.rendering.clear();
    assert.equal(await pending, false);
    assert.equal(h.viewer.camera.moveEnd.size, 0);
  });
}
