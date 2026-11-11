import { createWeatherFrameRendering } from '../../globe/cesium/weatherFrames.js';
// The weather layer on the fake and headless Cesium engines, and its display's frames there:
// staging, retained frames, the mosaic cache, prefetch and host switches.
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { createFakeViewer } from '../../globe/cesium/testing/fakeViewer.mjs';
import { createWeatherLayer } from './index.js';
import { createWeatherClock } from './clock.js';
import { createWeatherDisplay } from './render/display.js';
import { NO_IMAGERY_HOST } from '../shared/imageryHost.js';
import { imageryDisplayTests } from '../../testSupport/imageryDisplayEngines.mjs';
const { test, createEngine } = imageryDisplayTests();

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
// A rectangle in degrees as the engine camera's view rectangle (radians).
const view = (west, south, east, north) => ({
  west: (west * Math.PI) / 180,
  south: (south * Math.PI) / 180,
  east: (east * Math.PI) / 180,
  north: (north * Math.PI) / 180,
});

/**
 * The fake engine with its imagery surface set by the test and, while
 * `hold()` is on, staged sources held until the test finishes them:
 * `stages` lists them ({ source, signal, finish(ok = true) }).
 */
function fakeImagery() {
  const engine = createEngine();
  let surface = 'globe';
  engine.imagery.surface = () => surface;
  // A view over the radar product, too wide for a 3D Tiles detail window.
  engine.fake.script('viewRectangle', view(-120, 25, -100, 50));
  const stages = [];
  let holding = false;
  const createLayer = engine.imagery.createLayer;
  engine.imagery.createLayer = (input) => {
    const layer = createLayer(input);
    const setSource = layer.setSource;
    layer.setSource = (source, options = {}) => {
      if (!options.staged || !holding) return setSource(source, options);
      const task = deferred();
      stages.push({
        source,
        signal: options.signal,
        finish: (ok = true) =>
          task.resolve(ok ? setSource(source, options) : false),
      });
      return task.promise;
    };
    return layer;
  };
  const layers = () =>
    engine.fake.imageryLayers().map((id) => ({
      id,
      ...engine.fake.imageryLayer(id),
    }));
  return {
    engine,
    stages,
    layers,
    setSurface(next) {
      surface = next;
    },
    hold(value = true) {
      holding = value;
    },
    moveEnd: engine.camera.moveEnd,
  };
}

const displayOptions = {
  fetchImpl: async () => mockResponse(),
  decodeImage: async () => ({ width: 2048, height: 1024, close() {} }),
  createCanvas: mockCanvas,
};

/** The weather display on the fake and headless Cesium engines. */
function displayHarness(options = {}) {
  const imagery = fakeImagery();
  const display = createWeatherDisplay(imagery.engine, {
    ...displayOptions,
    ...options,
  });
  return { ...imagery, display };
}

test('a staged frame keeps the shown one until it draws, then replaces it in place', async () => {
  const h = displayHarness();
  h.hold();
  const first = h.display.setFrame(snapshot, times[0]);
  const [layer] = h.layers();
  assert.equal(
    layer.source.kind,
    'image',
    'nothing draws before the first frame',
  );
  assert.equal(h.display.getDiagnostics().time, null);
  assert.equal(h.display.getDiagnostics().loading, true);
  h.stages[0].finish();
  assert.equal(await first, true);
  assert.equal(h.layers()[0].alpha, 0.7);
  const second = h.display.setFrame(snapshot, times[1]);
  assert.equal(
    h.display.getDiagnostics().time,
    times[0],
    'displayed time remains old until the new frame draws',
  );
  assert.match(h.layers()[0].source.url, /20%3A00/);
  h.stages[1].finish();
  assert.equal(await second, true);
  assert.deepEqual(
    h.layers().map(({ id }) => id),
    [layer.id],
  );
  assert.match(h.layers()[0].source.url, /20%3A05/);
  assert.equal(h.display.getDiagnostics().time, times[1]);
  h.display.clear();
});

test('superseded stages are cancelled and cannot resurrect after a late draw', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = displayHarness();
  h.hold();
  const first = h.display.setFrame(snapshot, times[0]);
  const second = h.display.setFrame(snapshot, times[1]);
  assert.equal(await first, false);
  assert.equal(h.stages[0].signal.aborted, true);
  h.stages[0].finish();
  await flush();
  assert.equal(h.display.getDiagnostics().time, null);
  h.stages[1].finish();
  assert.equal(await second, true);
  assert.equal(h.display.getDiagnostics().time, times[1]);
  assert.match(h.layers()[0].source.url, /20%3A05/);
  h.display.clear();
  assert.deepEqual(h.layers(), []);
  t.mock.timers.tick(30_000);
  assert.deepEqual(h.layers(), []);
});

test('failed and timed-out stages retain the previous observation; a healthy replacement clears old errors', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = displayHarness();
  assert.equal(await h.display.setFrame(snapshot, times[0]), true);
  h.hold();
  const failed = h.display.setFrame(snapshot, times[1]);
  h.stages.at(-1).finish(false);
  assert.equal(await failed, false);
  assert.equal(h.display.getDiagnostics().time, times[0]);
  assert.equal(
    h.display.getDiagnostics().error,
    'Weather tiles unavailable · previous frame retained',
  );
  assert.equal(h.layers().length, 1);
  const timeout = h.display.setFrame(snapshot, times[1]);
  t.mock.timers.tick(25_000);
  assert.equal(await timeout, false);
  assert.equal(h.display.getDiagnostics().time, times[0]);
  assert.equal(h.stages.at(-1).signal.aborted, true);
  h.hold(false);
  assert.equal(await h.display.setFrame(snapshot, times[2]), true);
  assert.equal(h.display.getDiagnostics().error, null);
  assert.equal(h.display.getDiagnostics().time, times[2]);
  h.display.clear();
});

test('external abort cancels a staged request and releases its deadline', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = displayHarness();
  h.hold();
  const controller = new AbortController();
  const stage = h.display.setFrame(snapshot, times[0], {
    signal: controller.signal,
  });
  const before = h.engine.fake.renderRequests;
  controller.abort();
  assert.equal(await stage, false);
  assert.equal(h.stages[0].signal.aborted, true);
  assert.ok(
    h.engine.fake.renderRequests > before,
    'cancellation requests a render',
  );
  h.stages[0].finish();
  t.mock.timers.tick(30_000);
  await flush();
  assert.equal(h.display.getDiagnostics().time, null);
  assert.equal(h.display.getDiagnostics().loading, false);
  await assert.rejects(
    h.display.setFrame(snapshot, times[1], { signal: controller.signal }),
    { name: 'AbortError' },
  );
  assert.equal(h.stages.length, 1, 'already-aborted work stages nothing');
  h.display.clear();
});

test('global infrared is acquired before staging and drawn as one processed mosaic', async () => {
  let fetches = 0;
  const decode = deferred();
  const h = displayHarness({
    fetchImpl: async () => {
      fetches++;
      return mockResponse();
    },
    decodeImage: () => decode.promise,
  });
  const task = h.display.setFrame({ ...snapshot, product: 'clouds' }, times[0]);
  await flush();
  assert.deepEqual(h.layers(), []);
  assert.equal(h.display.getDiagnostics().loading, true);
  assert.deepEqual(h.display.getDiagnostics().mosaic, {
    fetched: true,
    decodeMs: null,
    cached: false,
  });
  decode.resolve({ width: 2048, height: 1024 });
  assert.equal(await task, true);
  const [layer] = h.layers();
  assert.equal(layer.source.kind, 'image');
  assert.deepEqual(
    layer.source.image.pixels,
    new Uint8ClampedArray([194, 100, 0, 98]),
  );
  assert.equal(fetches, 1);
  assert.equal(h.display.getDiagnostics().mosaic.fetched, true);
  assert.equal(typeof h.display.getDiagnostics().mosaic.decodeMs, 'number');
  h.display.clear();
});

test('no host cancels a globe stage and refuses work; a restored host clears the status', async () => {
  const h = displayHarness();
  assert.equal(await h.display.setFrame(snapshot, times[0]), true);
  const [radar] = h.layers();
  h.hold();
  const incoming = h.display.setFrame(snapshot, times[1]);
  h.setSurface('none');
  h.display.rehome();
  assert.equal(await incoming, false);
  assert.equal(h.stages[0].signal.aborted, true);
  assert.equal(await h.display.setFrame(snapshot, times[2]), false);
  assert.equal(h.display.getDiagnostics().error, NO_IMAGERY_HOST);
  assert.equal(h.display.getDiagnostics().time, times[0]);
  h.setSurface('globe');
  h.display.rehome();
  assert.deepEqual(
    h.layers().map(({ id }) => id),
    [radar.id],
  );
  assert.equal(h.display.getDiagnostics().error, null);
  h.display.clear();
  assert.deepEqual(h.layers(), []);
});

const shellDecode = async () => ({ width: 4096, height: 2048, close() {} });

test('on 3D tiles the frame is a raised shell and nothing drapes', async () => {
  const h = displayHarness({ decodeImage: shellDecode });
  h.setSurface('tiles');
  const stage = h.display.setFrame(snapshot, times[0]);
  assert.equal(h.display.getDiagnostics().loading, true);
  assert.equal(await stage, true);
  const [shell] = h.layers();
  assert.equal(h.layers().length, 1);
  assert.equal(shell.raise, 6_200);
  const diagnostics = h.display.getDiagnostics();
  assert.equal(diagnostics.host, 'shell');
  assert.equal(diagnostics.height, 6_200);
  assert.equal(diagnostics.time, times[0]);
  assert.equal(diagnostics.error, null);
  assert.equal(
    h.moveEnd.numberOfListeners,
    1,
    'one camera listener, for the detail window only',
  );
  assert.equal(await h.display.prefetch(snapshot, times[1]), true);
  assert.equal(h.display.getDiagnostics().cache.mosaics, 2);
  h.display.clear();
  assert.deepEqual(h.layers(), []);
  assert.equal(h.moveEnd.numberOfListeners, 0);
  assert.equal(h.display.getDiagnostics().cache.mosaics, 0);
});

test('a switch to 3D Tiles windows the current view; the globe host never requests a window', async () => {
  const urls = [];
  const h = displayHarness({
    decodeImage: shellDecode,
    fetchImpl: async (url) => {
      urls.push(url);
      return mockResponse();
    },
  });
  h.engine.fake.script('viewRectangle', view(-100, 35, -98, 36));
  assert.equal(await h.display.setFrame(snapshot, times[0]), true);
  assert.equal(await h.display.prefetch(snapshot, times[1]), true);
  h.moveEnd.raiseEvent();
  await flush();
  assert.equal(h.layers()[0].raise, null);
  assert.equal(h.moveEnd.numberOfListeners, 0);
  assert.equal(h.display.getDiagnostics().shell, undefined);
  assert.ok(urls.length > 0);
  assert.ok(urls.every((url) => !url.includes('bbox=')));

  h.setSurface('tiles');
  assert.equal(h.display.rehome(), true);
  await flush();
  await flush();
  const detail = urls.filter((url) => url.includes('bbox='));
  assert.deepEqual(
    detail.map((url) =>
      new URL(url, 'https://example.test').searchParams.get('bbox'),
    ),
    ['-102,34,-96,37'],
  );
  const diagnostics = h.display.getDiagnostics();
  assert.equal(diagnostics.time, times[0]);
  assert.equal(diagnostics.shell.detail.ready, true);
  assert.equal(h.layers().length, 1, 'the detail draws on the shell layer');
  assert.ok(h.layers()[0].detail);
  h.setSurface('globe');
  assert.equal(h.display.rehome(), true);
  assert.ok(
    h.layers().every(({ raise }) => raise === null),
    'the shell layer goes with the host',
  );
  await flush();
  assert.equal(h.display.getDiagnostics().host, 'globe');
  assert.equal(h.display.getDiagnostics().loading, false);
  assert.equal(h.moveEnd.numberOfListeners, 0);
  assert.equal(urls.filter((url) => url.includes('bbox=')).length, 1);
  h.display.clear();
});

test('host switches tear one renderer down and restage the retained frame on the other', async () => {
  const h = displayHarness();
  const clouds = { ...snapshot, product: 'clouds' };
  h.display.setAlpha(0.4);
  assert.equal(
    await h.display.setFrame(clouds, times[1], { infrared: 'full' }),
    true,
  );
  const [draped] = h.layers();
  h.setSurface('tiles');
  assert.equal(h.display.rehome(), true);
  assert.equal(h.engine.fake.imageryLayer(draped.id), undefined);
  assert.equal(
    h.display.getDiagnostics().time,
    times[1],
    'the retained time is reported while restaging',
  );
  assert.equal(h.display.getDiagnostics().loading, true);
  await flush();
  let diagnostics = h.display.getDiagnostics();
  assert.equal(diagnostics.host, 'shell');
  assert.equal(diagnostics.height, 5_500);
  assert.equal(diagnostics.loading, false);
  assert.equal(diagnostics.time, times[1]);
  assert.equal(diagnostics.infrared, 'full');
  const [shell] = h.layers();
  assert.equal(shell.raise, 5_500);
  assert.equal(shell.alpha, 0.4);
  h.setSurface('globe');
  assert.equal(h.display.rehome(), true);
  assert.equal(h.engine.fake.imageryLayer(shell.id), undefined);
  assert.equal(h.display.getDiagnostics().time, times[1]);
  await flush();
  diagnostics = h.display.getDiagnostics();
  assert.equal(diagnostics.host, 'globe');
  assert.equal(diagnostics.loading, false);
  assert.equal(diagnostics.time, times[1]);
  assert.equal(diagnostics.infrared, 'full');
  assert.equal(h.layers().length, 1);
  assert.equal(h.layers()[0].raise, null);
  assert.equal(h.layers()[0].alpha, 0.4);
  h.display.clear();
  assert.deepEqual(h.layers(), []);
});

test('a host without imagery keeps the active shell and its frame', async () => {
  let fetches = 0;
  const h = displayHarness({
    decodeImage: shellDecode,
    fetchImpl: async () => {
      fetches++;
      return mockResponse();
    },
  });
  h.setSurface('tiles');
  assert.equal(await h.display.setFrame(snapshot, times[0]), true);
  const [shell] = h.layers();
  h.setSurface('none');
  h.display.rehome();
  assert.equal(h.engine.fake.imageryLayer(shell.id).shown, false);
  assert.equal(h.display.getDiagnostics().time, times[0]);
  assert.equal(h.display.getDiagnostics().error, NO_IMAGERY_HOST);
  assert.equal(await h.display.setFrame(snapshot, times[1]), false);
  h.setSurface('tiles');
  h.display.rehome();
  assert.equal(h.engine.fake.imageryLayer(shell.id).shown, true);
  assert.deepEqual(
    h.layers().map(({ id }) => id),
    [shell.id],
  );
  assert.equal(fetches, 1);
  assert.equal(h.display.getDiagnostics().error, null);
  h.display.setHidden(true);
  assert.equal(h.engine.fake.imageryLayer(shell.id).shown, false);
  assert.equal(h.display.getDiagnostics().time, null);
  h.display.setHidden(false);
  assert.equal(h.engine.fake.imageryLayer(shell.id).shown, true);
  h.display.clear();
  assert.deepEqual(h.layers(), []);
});

test('each product owns its shell height; a product change replaces the shell', async () => {
  let width = 2048;
  const h = displayHarness({
    decodeImage: async () => ({ width, height: width / 2, close() {} }),
  });
  h.setSurface('tiles');
  assert.equal(
    await h.display.setFrame({ ...snapshot, product: 'clouds' }, times[0]),
    true,
  );
  const [first] = h.layers();
  assert.equal(h.display.getDiagnostics().height, 5_500);
  width = 4096;
  const lightning = h.display.setFrame(
    { ...snapshot, product: 'lightning' },
    times[0],
  );
  assert.equal(h.engine.fake.imageryLayer(first.id), undefined);
  assert.equal(await lightning, true);
  assert.equal(h.display.getDiagnostics().height, 6_600);
  assert.equal(h.display.getDiagnostics().product, 'lightning');
  assert.equal(h.layers().length, 1);
  assert.equal(h.layers()[0].raise, 6_600);
  h.display.clear();
});

test('a stage without a current frame is cancelled on host change and detached frames are destroyed', async () => {
  const h = displayHarness();
  h.setSurface('tiles');
  const first = h.display.setFrame(snapshot, times[0]);
  h.setSurface('globe');
  h.display.rehome();
  assert.equal(await first, false);
  assert.deepEqual(h.layers(), []);
  assert.equal(await h.display.setFrame(snapshot, times[1]), true);
  assert.equal(h.layers().length, 1);
  h.setSurface('none');
  h.display.rehome();
  h.display.clear();
  assert.deepEqual(h.layers(), []);
});

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
      closed = 0;
    const h = displayHarness({
      fetchImpl: async (_url, options) => {
        signal = options.signal;
        if (outcome === 'fetch failure') throw new Error('offline');
        return mockResponse();
      },
      decodeImage: () => decode.promise,
    });
    assert.equal(await h.display.setFrame(snapshot, times[0]), true);
    const [original] = h.layers();
    const controller = new AbortController();
    const pending = h.display.setFrame(
      { ...snapshot, product: 'clouds' },
      times[1],
      { signal: controller.signal },
    );
    await flush();
    assert.deepEqual(h.layers(), [original]);
    if (outcome === 'decode failure') decode.reject(new Error('bad png'));
    if (outcome === 'timeout') t.mock.timers.tick(25_000);
    if (outcome === 'abort') controller.abort();
    if (outcome === 'supersede')
      assert.equal(await h.display.setFrame(snapshot, times[0]), true);
    if (outcome === 'rehome') {
      h.setSurface('none');
      h.display.rehome();
    }
    assert.equal(await pending, false);
    assert.equal(signal.aborted, true);
    assert.equal(h.display.getDiagnostics().time, times[0]);
    assert.equal(h.engine.fake.imageryLayer(original.id).alpha, 0.7);
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
    assert.deepEqual(h.layers(), [original]);
    h.display.clear();
  });
}

test('the regional infrared transform masks each tile through the infrared key', async () => {
  const h = displayHarness();
  assert.equal(
    await h.display.setFrame(
      { ...snapshot, product: 'clouds-regional' },
      times[0],
    ),
    true,
  );
  const { transform } = h.layers()[0].source;
  const image = { width: 256, height: 256 };
  const processed = transform(image);
  assert.equal(processed.source, image);
  assert.deepEqual([...processed.pixels], [194, 100, 0, 98]);
  h.display.clear();
});

test('infrared mode restages the same time on the globe with its own mosaic', async () => {
  let fetches = 0;
  const h = displayHarness({
    fetchImpl: async () => {
      fetches++;
      return mockResponse();
    },
  });
  const clouds = { ...snapshot, product: 'clouds' };
  assert.equal(await h.display.setFrame(clouds, times[0]), true);
  const [layer] = h.layers();
  assert.equal(await h.display.setFrame(clouds, times[0]), true);
  assert.equal(fetches, 1, 'the same frame and mode is already shown');
  assert.equal(
    await h.display.setFrame(clouds, times[0], { infrared: 'full' }),
    true,
  );
  assert.equal(fetches, 2);
  const [full] = h.layers();
  assert.equal(full.id, layer.id);
  assert.deepEqual([...full.source.image.pixels], [194, 100, 0, 200]);
  assert.equal(full.alpha, 0.7);
  assert.equal(h.display.getDiagnostics().infrared, 'full');
  h.display.clear();
});

test('hidden renderer retains the frame without displaying it and rehome cannot reveal it', async () => {
  const h = displayHarness();
  assert.equal(await h.display.setFrame(snapshot, times[0]), true);
  const [layer] = h.layers();
  h.hold();
  const pending = h.display.setFrame(snapshot, times[1]);
  h.display.setHidden(true);
  assert.equal(await pending, false);
  assert.deepEqual(
    h.layers().map(({ id }) => id),
    [layer.id],
  );
  assert.equal(h.layers()[0].shown, false);
  assert.match(h.layers()[0].source.url, /20%3A00/);
  assert.equal(h.display.getDiagnostics().time, null);
  h.display.rehome();
  assert.equal(h.layers()[0].shown, false);
  h.display.setHidden(false);
  assert.equal(h.layers()[0].shown, true);
  assert.equal(h.display.getDiagnostics().time, times[0]);
  h.display.clear();
});

const globalSnapshot = { ...snapshot, product: 'clouds' };
async function showMosaic(h, time, infrared = 'filtered') {
  assert.equal(
    await h.display.setFrame(globalSnapshot, time, { infrared }),
    true,
  );
}

test('mosaic cache skips fetch and decode, separates modes, evicts LRU at 6 and clears per instance', async (t) => {
  let fetches = 0,
    decodes = 0;
  const h = displayHarness({
    fetchImpl: async () => {
      fetches++;
      return mockResponse();
    },
    decodeImage: async () => {
      decodes++;
      return { width: 2048, height: 1024 };
    },
  });
  t.after(() => h.display.clear());
  await showMosaic(h, times[0]);
  await showMosaic(h, times[1]);
  await showMosaic(h, times[0]);
  assert.equal(fetches, 2);
  assert.equal(decodes, 2);
  assert.deepEqual(h.display.getDiagnostics().mosaic, {
    fetched: false,
    cached: true,
    decodeMs: 0,
  });
  await showMosaic(h, times[0], 'full');
  assert.equal(fetches, 3);
  assert.equal(h.display.getDiagnostics().mosaic.cached, false);
  await showMosaic(h, times[0]);
  const extra = Array.from({ length: 4 }, (_, i) =>
    new Date(Date.parse(times[2]) + i * 3600_000).toISOString(),
  );
  for (const time of extra) await showMosaic(h, time);
  assert.deepEqual(h.display.getDiagnostics().cache, {
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
  h.display.clear();
  assert.deepEqual(h.display.getDiagnostics().cache, {
    mosaics: 0,
    prefetching: false,
  });
  await showMosaic(h, times[0]);
  assert.equal(fetches, 9);
  const other = displayHarness({
    fetchImpl: async () => {
      fetches++;
      return mockResponse();
    },
  });
  t.after(() => other.display.clear());
  await showMosaic(other, times[0]);
  assert.equal(fetches, 10, 'instances do not share canvases');
});

test('global prefetch warms a decoded frame without staging imagery and hits on selection', async (t) => {
  let fetches = 0;
  const h = displayHarness({
    fetchImpl: async () => {
      fetches++;
      return mockResponse();
    },
  });
  t.after(() => h.display.clear());
  await showMosaic(h, times[0]);
  const [layer] = h.layers();
  const warm = h.display.prefetch(globalSnapshot, times[1]);
  assert.equal(h.display.getDiagnostics().cache.prefetching, true);
  assert.equal(h.display.getDiagnostics().time, times[0]);
  assert.equal(await warm, true);
  assert.deepEqual(h.layers(), [layer], 'prefetch stages nothing');
  await showMosaic(h, times[1]);
  assert.equal(fetches, 2);
  assert.equal(h.display.getDiagnostics().mosaic.cached, true);
  assert.equal(h.display.getDiagnostics().mosaic.decodeMs, 0);
});

test('cancelled or cleared speculative decodes cannot repopulate the cache', async () => {
  for (const cancel of ['cancelPrefetch', 'clear', 'setHidden']) {
    const decoded = deferred();
    let signal,
      closes = 0;
    const h = displayHarness({
      fetchImpl: async (_url, options) => {
        signal = options.signal;
        return mockResponse();
      },
      decodeImage: () => decoded.promise,
    });
    const warm = h.display.prefetch(globalSnapshot, times[0]);
    await flush();
    h.display[cancel](true);
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
    assert.deepEqual(h.display.getDiagnostics().cache, {
      mosaics: 0,
      prefetching: false,
    });
    h.display.clear();
  }
});

test('tiled prefetch covers only visible product bounds at levels 0/1, caps eight requests and drains bodies', async (t) => {
  const calls = [];
  let bodies = 0;
  const h = displayHarness({
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
  t.after(() => h.display.clear());
  h.engine.fake.script('viewRectangle', view(-120, 25, -100, 50));
  assert.equal(await h.display.prefetch(snapshot, times[1]), true);
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
    await h.display.prefetch(snapshot, times[1]),
    false,
    'same completed work is not repeated',
  );
  h.engine.fake.script('viewRectangle', view(100, 25, 120, 50));
  await h.display.prefetch(snapshot, times[2]);
  assert.equal(calls.length, 2, 'view outside product bounds fetches nothing');
  h.engine.fake.script('viewRectangle', view(-180, -90, 180, 90));
  const world = {
    ...snapshot,
    bounds: { west: -180, south: -90, east: 180, north: 90 },
  };
  await h.display.prefetch(world, times[2]);
  assert.equal(
    calls.length,
    10,
    'world view is capped at eight additional requests',
  );
  assert.equal(bodies, 10);
  assert.equal(new Set(calls.slice(2).map(({ url }) => url.href)).size, 8);
});

test('prefetch is best effort, aborts on replacement or host suspension, and skips hidden frames', async (t) => {
  const signals = [];
  const h = displayHarness({
    fetchImpl: (_url, { signal }) =>
      new Promise((_, reject) => {
        signals.push(signal);
        signal.addEventListener('abort', () => reject(signal.reason), {
          once: true,
        });
      }),
  });
  t.after(() => h.display.clear());
  const first = h.display.prefetch(snapshot, times[1]);
  assert.ok(signals.length > 0);
  assert.equal(
    await h.display.setFrame(snapshot, times[0]),
    true,
    'current frame never waits for speculative work',
  );
  assert.equal(await first, false);
  assert.ok(signals.every((signal) => signal.aborted));
  const second = h.display.prefetch(snapshot, times[1]);
  h.setSurface('none');
  h.display.rehome();
  assert.equal(await second, false);
  const count = signals.length;
  assert.equal(await h.display.prefetch(snapshot, times[2]), false);
  h.setSurface('globe');
  h.display.setHidden(true);
  assert.equal(await h.display.prefetch(snapshot, times[2]), false);
  assert.equal(signals.length, count);
  assert.equal(h.display.getDiagnostics().cache.prefetching, false);
});

test('failed prefetch leaves the current frame and errors unchanged and releases its deadline', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = displayHarness({
    fetchImpl: async () => {
      throw new Error('offline');
    },
  });
  t.after(() => h.display.clear());
  assert.equal(await h.display.setFrame(snapshot, times[0]), true);
  const before = h.display.getDiagnostics();
  assert.equal(await h.display.prefetch(snapshot, times[1]), false);
  assert.deepEqual(h.display.getDiagnostics(), before);
  t.mock.timers.tick(30_000);
  assert.deepEqual(h.display.getDiagnostics(), before);
});

for (const product of ['clouds-regional', 'lightning']) {
  test(`${product} on the globe host uses 256 px tiles to level 6`, async () => {
    const h = displayHarness();
    h.hold();
    const pending = h.display.setFrame({ ...snapshot, product }, times[0]);
    const { source } = h.stages[0];
    assert.equal(source.kind, 'tiles');
    assert.equal(source.tileSize, 256);
    assert.equal(source.maxLevel, 6);
    assert.equal(
      new URL(source.url, 'https://example.test').searchParams.get('size'),
      '256',
    );
    assert.equal(h.display.getDiagnostics().host, 'globe');
    h.display.clear();
    assert.equal(await pending, false);
    assert.equal(h.moveEnd.numberOfListeners, 0);
  });
}

function layerHarness({
  clock,
  reducedMotion = false,
  feed,
  id,
  eventTarget = target(),
} = {}) {
  const stages = [];
  const motion = target({ matches: reducedMotion });
  const documentRef = target({ hidden: false });
  let time = null;
  let infraredMode = 'filtered';
  let active = null;
  let clearCount = 0;
  let hidden = false;
  let alpha = null;
  const rendering = {
    rehome() {
      active?.finish(false);
    },
    setAlpha(value) {
      alpha = value;
    },
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
  const imagery = fakeImagery();
  const layer = createWeatherLayer({
    clock,
    id,
    feed: feed ?? { getSnapshot: async () => snapshot },
    documentRef,
    eventTarget,
    matchMedia: () => motion,
    createNativeRendering: () => rendering,
  });
  layer.init(null, { engine: imagery.engine });
  layer.enable();
  return {
    layer,
    rendering,
    stages,
    eventTarget,
    motion,
    documentRef,
    moveEnd: imagery.moveEnd,
    setSurface: imagery.setSurface,
    clears: () => clearCount,
    getAlpha: () => alpha,
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
  assert.equal(h.moveEnd.numberOfListeners, 0);
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
  assert.equal(
    await old,
    true,
    'replacement is accepted by the enable lifecycle',
  );
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
  h.setSurface('tiles');
  h.eventTarget.emit('gev:map-stack-changed');
  const update = h.layer.update();
  await flush();
  h.stages[0].finish();
  await update;
  h.layer.setParams({ play: true });
  t.mock.timers.tick(2000);
  assert.equal(h.stages.length, 2);
  h.setSurface('none');
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
  h.setSurface('globe');
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
  h.setSurface('none');
  await h.layer.update();
  assert.equal(h.stages.length, 0);
  h.setSurface('tiles');
  const update = h.layer.update();
  await flush();
  assert.equal(h.stages[0].time, snapshot.latest);
  h.stages[0].finish();
  await update;
  assert.notEqual(h.layer.getRowControls().summary.status, NO_IMAGERY_HOST);
  h.layer.destroy();
});

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
  assert.equal(h.stages[2].infrared, 0);
  assert.equal(h.layer.getParams().infrared, 0);
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
  assert.equal(h.layer.getParams().infrared, 0);
  assert.equal(h.stages.length, 3);
  h.layer.destroy();
});

test('satellite cloud filter spans Full to Clouds only without changing layer opacity', () => {
  const h = layerHarness({ id: 'weather-satellite' });
  assert.equal(h.layer.getParams().infrared, 100);
  assert.equal(h.layer.getParams().opacity, 'strong');
  assert.equal(h.getAlpha(), 0.7);
  const setting = h.layer
    .getRowControls()
    .summary.settings.find(({ id }) => id === 'image');
  assert.equal(setting.range.param, 'infrared');
  assert.equal(setting.range.value, 100);
  assert.equal(setting.range.min, 0);
  assert.equal(setting.range.max, 100);
  assert.equal(setting.range.step, 1);
  assert.equal(setting.range.commitOnChange, true);

  const full = h.layer.getRowControls().chips.find(({ id }) => id === 'full');
  h.layer.setParams(full.params);
  assert.equal(h.layer.getParams().infrared, 0);
  assert.equal(h.getAlpha(), 0.7);
  assert.equal(
    h.layer.getRowControls().chips.find(({ id }) => id === 'full').active,
    true,
  );

  h.layer.setParams({ infrared: 53 });
  assert.equal(h.layer.getParams().infrared, 53);
  assert.equal(h.getAlpha(), 0.7, 'filter strength is not overall opacity');
  assert.equal(
    h.layer.getRowControls().summary.settings.find(({ id }) => id === 'image')
      .range.value,
    53,
  );
  h.layer.setParams({ opacity: 'light' });
  assert.equal(h.layer.getParams().opacity, 'light');
  assert.equal(
    h.getAlpha(),
    0.4,
    'Soft remains the independent opacity preset',
  );
  h.layer.setParams({ infrared: 101 });
  assert.equal(
    h.layer.getParams().infrared,
    53,
    'invalid filter values are ignored',
  );
  h.layer.destroy();
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
    { opacity: 'strong' },
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

test('observed descriptors keep configuration only and label satellite clouds by coverage', () => {
  for (const [id, coverage] of [
    ['weather-radar', 'CONUS'],
    ['weather-satellite', 'North America'],
    ['weather-lightning', 'Americas + Pacific'],
  ]) {
    const h = layerHarness({ id });
    const controls = h.layer.getRowControls();
    assert.equal(controls.readout, true);
    assert.equal(controls.summary.coverage, coverage);
    assert.equal(controls.summary.sections, undefined);
    assert.deepEqual(
      controls.summary.settings.map(({ label }) => label),
      id === 'weather-satellite' ? ['REGION', 'IMAGE', 'OPACITY'] : ['OPACITY'],
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
        'Apply the full cloud brightness key; 100% filter strength',
      );
      const imageSetting = controls.summary.settings.find(
        ({ id }) => id === 'image',
      );
      assert.equal(imageSetting.range.param, 'infrared');
      assert.equal(imageSetting.range.value, 100);
      assert.equal(imageSetting.range.commitOnChange, true);
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
  assert.deepEqual(warmed[0].options, { infrared: 100 });
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

test('a product replacement accepts supersession but never paints the obsolete first response', async () => {
  const pending = [];
  const h = layerHarness({
    id: 'weather-satellite',
    feed: {
      getSnapshot: (args) => {
        const task = deferred();
        pending.push({ ...args, ...task });
        return task.promise;
      },
    },
  });
  const first = h.layer.update();
  h.layer.setParams({ product: 'clouds' });
  assert.equal(pending.length, 2);
  pending[0].resolve({ ...snapshot, product: 'clouds-regional' });
  assert.equal(await first, true);
  assert.equal(h.stages.length, 0);
  pending[1].resolve({ ...snapshot, product: 'clouds' });
  await flush();
  h.stages.at(-1).finish();
  await flush();
  assert.equal(h.layer.getParams().product, 'clouds');
  h.layer.destroy();
});

test('disabled weather releases its camera listener and re-enabling binds only once', () => {
  const h = layerHarness();
  h.layer.disable();
  assert.equal(
    h.moveEnd.numberOfListeners,
    0,
    'disabled layers own no active camera work',
  );
  h.layer.enable();
  h.layer.enable();
  assert.equal(h.moveEnd.numberOfListeners, 1);
  h.layer.disable();
  assert.equal(h.moveEnd.numberOfListeners, 0);
  h.layer.enable();
  assert.equal(h.moveEnd.numberOfListeners, 1);
  h.layer.destroy();
  assert.equal(h.moveEnd.numberOfListeners, 0);
});

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
    const h = fakeImagery();
    h.setSurface('tiles');
    const events = target();
    const layer = createWeatherLayer({
      id,
      feed: { getSnapshot: async () => ({ ...snapshot, product }) },
      createNativeRendering: (engine, options) =>
        createWeatherDisplay(engine, {
          ...displayOptions,
          decodeImage: async () => ({ ...size, close() {} }),
          ...options,
        }),
      documentRef: target({ hidden: false }),
      eventTarget: events,
      matchMedia: () => target({ matches: false }),
    });
    layer.init(null, { engine: h.engine });
    layer.setParams({ product });
    layer.enable();
    await layer.update();
    await flush();
    assert.equal(layer.getDiagnostics().time, times[2]);
    assert.equal(layer.getDiagnostics().host, 'shell');
    assert.equal(layer.getRowControls().summary.status, null);
    assert.doesNotMatch(layer.getRowControls().info, /Hidden/);
    const [shell] = h.layers();
    assert.equal(shell.raise > 0, true);
    assert.equal(shell.shown, true);
    const shown = () => h.engine.fake.imageryLayer(shell.id)?.shown;

    layer.setParams({ play: true });
    t.mock.timers.tick(2000);
    await flush();
    assert.equal(
      layer.getDiagnostics().time,
      times[0],
      'history advances at street level',
    );
    h.moveEnd.raiseEvent();
    assert.equal(shown(), true, 'no height gate');
    assert.equal(layer.getDiagnostics().playing, true);
    assert.equal(layer.getDiagnostics().timerActive, true);

    h.setSurface('none');
    events.emit('gev:map-stack-changed');
    assert.equal(shown(), false);
    assert.equal(layer.getRowControls().summary.status, NO_IMAGERY_HOST);
    assert.equal(layer.getDiagnostics().timerActive, false);
    h.setSurface('globe');
    events.emit('gev:map-stack-changed');
    assert.equal(h.engine.fake.imageryLayer(shell.id), undefined);
    assert.equal(
      layer.getDiagnostics().time,
      times[0],
      'the switch restages the shown history frame',
    );
    await flush();
    assert.equal(layer.getDiagnostics().host, 'globe');
    assert.equal(layer.getDiagnostics().time, times[0]);
    assert.equal(layer.getDiagnostics().loading, false);
    layer.destroy();
    assert.equal(h.moveEnd.numberOfListeners, 0);
    assert.equal(events.size, 0);
    assert.deepEqual(h.layers(), []);
  });
}

function renderingHarness(options = {}) {
  const h = fakeImagery();
  const viewer = createFakeViewer();
  const layers = [];
  const providers = [];
  viewer.scene.globe.tilesLoaded = true;
  viewer.camera.computeViewRectangle = () => view(-120, 25, -100, 50);
  viewer.imageryLayers = {
    addImageryProvider(provider) {
      providers.push(provider);
      const layer = { imageryProvider: provider, alpha: 1, show: true };
      layers.push(layer);
      return layer;
    },
    contains: (layer) => layers.includes(layer),
    remove(layer) {
      const i = layers.indexOf(layer);
      if (i < 0) return false;
      layers.splice(i, 1);
      return true;
    },
    get length() {
      return layers.length;
    },
    get: (index) => layers[index],
    raiseToTop(layer) {
      const i = layers.indexOf(layer);
      if (i >= 0) layers.push(...layers.splice(i, 1));
    },
    isDestroyed: () => false,
  };
  h.engine.extensions = { cesium: { viewer } };
  const rendering = createWeatherDisplay(h.engine, {
    frameRendering: createWeatherFrameRendering,
    ...displayOptions,
    ...options,
  });
  return {
    ...h,
    viewer,
    layers,
    providers,
    rendering,
    settle() {
      viewer.scene.postRender.raiseEvent();
      viewer.scene.postRender.raiseEvent();
    },
  };
}

const suppliedTile = (size = 256) => ({
  width: size,
  height: size,
  closes: 0,
  close() {
    this.closes++;
  },
});

test('a frame source supplies regional tiles in place of the tile route, through the readiness wrapper', async () => {
  let now = 0;
  const requests = [];
  const supplied = [];
  const h = renderingHarness({
    now: () => now,
    fetchImpl: () => assert.fail('supplied tiles are not fetched'),
    frameSource: {
      getTile: async (request) => {
        requests.push(request);
        const tile = suppliedTile();
        supplied.push(tile);
        return tile;
      },
    },
  });
  h.viewer.scene.globe.tilesLoaded = false;
  const loaded = h.rendering.setFrame(snapshot, times[0]);
  assert.equal(h.providers.length, 1);
  const [provider] = h.providers;
  assert.equal(provider.options, undefined, 'no URL template provider');
  assert.equal(provider.maximumLevel, 6);
  const tile = await provider.requestImage(1, 0, 1, {});
  assert.equal(tile.width, 256);
  assert.equal(tile.source, supplied[0]);
  assert.equal(supplied[0].closes, 1);
  assert.equal(requests[0].product, 'radar');
  assert.equal(requests[0].time, times[0]);
  assert.deepEqual(
    [requests[0].z, requests[0].x, requests[0].y, requests[0].size],
    [1, 1, 0, 256],
  );
  assert.equal(h.rendering.getDiagnostics().loadedTiles, 1);
  now = 500;
  h.settle();
  assert.equal(await loaded, true);

  const gate = deferred();
  let signal;
  const next = renderingHarness({
    frameSource: {
      getTile: (request) => {
        signal = request.signal;
        return gate.promise;
      },
    },
  });
  const staged = next.rendering.setFrame(snapshot, times[1]);
  const pending = next.providers[0].requestImage(0, 0, 0, {});
  next.rendering.clear();
  assert.equal(signal.aborted, true, 'clearing a frame aborts its tiles');
  const late = suppliedTile();
  gate.resolve(late);
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(late.closes, 1);
  assert.equal(await staged, false);
  h.rendering.clear();
});

test('a failed supplied tile fails the staged frame through errorEvent', async () => {
  const h = renderingHarness({
    frameSource: {
      getTile: async () => {
        throw new Error('frame unavailable');
      },
    },
  });
  const staged = h.rendering.setFrame(snapshot, times[0]);
  const [provider] = h.providers;
  await assert.rejects(provider.requestImage(0, 0, 0, {}));
  provider.errorEvent.raiseEvent({ x: 0, y: 0, level: 0, error: {} });
  h.settle();
  assert.equal(await staged, false);
  assert.match(h.rendering.getDiagnostics().error, /Weather tiles unavailable/);
  h.rendering.clear();
});

test('supplied regional infrared tiles are canvases, so they get the transfer without a flip', async () => {
  const hadBitmap = Object.hasOwn(globalThis, 'ImageBitmap');
  const previous = globalThis.ImageBitmap;
  globalThis.ImageBitmap = class ImageBitmap {
    width = 256;
    height = 256;
    close() {}
  };
  try {
    const h = renderingHarness({
      frameSource: { getTile: async () => new globalThis.ImageBitmap() },
    });
    void h.rendering.setFrame(
      { ...snapshot, product: 'clouds-regional' },
      times[0],
    );
    const tile = await h.providers[0].requestImage(0, 0, 0, {});
    assert.equal(tile.drawnWith, null, 'drawn upright, not flipped');
    assert.ok(tile.pixels, 'the infrared transfer ran');
    const empty = renderingHarness({
      frameSource: { getTile: async () => null },
    });
    void empty.rendering.setFrame(
      { ...snapshot, product: 'clouds-regional' },
      times[0],
    );
    const transparent = await empty.providers[0].requestImage(0, 0, 0, {});
    assert.equal(transparent.width, 256, 'a null tile is still a canvas');
    h.rendering.clear();
    empty.rendering.clear();
  } finally {
    if (hadBitmap) globalThis.ImageBitmap = previous;
    else delete globalThis.ImageBitmap;
  }
});

test('tiled prefetch asks the frame source for the same level 0/1 tiles and releases them', async (t) => {
  const requests = [];
  const supplied = [];
  const h = renderingHarness({
    fetchImpl: () => assert.fail('supplied tiles are not fetched'),
    frameSource: {
      getTile: async (request) => {
        requests.push(request);
        if (request.z === 0) return null;
        const tile = suppliedTile();
        supplied.push(tile);
        return tile;
      },
    },
  });
  t.after(() => h.rendering.clear());
  h.viewer.camera = {
    computeViewRectangle: () =>
      Cesium.Rectangle.fromDegrees(-120, 25, -100, 50),
  };
  assert.equal(await h.rendering.prefetch(snapshot, times[1]), true);
  assert.deepEqual(
    requests.map(({ product, time, z, x, y, size }) => [
      product,
      time,
      z,
      x,
      y,
      size,
    ]),
    [
      ['radar', times[1], 0, 0, 0, 256],
      ['radar', times[1], 1, 0, 0, 256],
    ],
  );
  assert.ok(requests.every(({ signal }) => signal instanceof AbortSignal));
  assert.equal(supplied[0].closes, 1);
  assert.equal(
    await h.rendering.prefetch(snapshot, times[1]),
    false,
    'same completed work is not repeated',
  );
  assert.equal(requests.length, 2);

  const gate = deferred();
  let signal;
  const slow = renderingHarness({
    frameSource: {
      getTile: ({ signal: value }) => {
        signal = value;
        return gate.promise;
      },
    },
  });
  t.after(() => slow.rendering.clear());
  slow.viewer.camera = h.viewer.camera;
  const warm = slow.rendering.prefetch(snapshot, times[1]);
  slow.rendering.cancelPrefetch();
  assert.equal(signal.aborted, true, 'cancelling a prefetch aborts its tiles');
  gate.resolve(null);
  assert.equal(await warm, false);
});

test('the global mosaic comes from the frame source image when present', async (t) => {
  const requests = [];
  const h = displayHarness({
    fetchImpl: () => assert.fail('a supplied mosaic is not fetched'),
    decodeImage: () => assert.fail('a supplied mosaic is not decoded'),
    frameSource: {
      getImage: async (request) => {
        requests.push(request);
        return { width: 2048, height: 1024, close() {} };
      },
    },
  });
  t.after(() => h.display.clear());
  await showMosaic(h, times[0]);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].product, 'clouds');
  assert.deepEqual(requests[0].size, { width: 2048, height: 1024 });
  assert.equal(requests[0].bbox, null);
  assert.equal(h.display.getDiagnostics().mosaic.fetched, true);
});

test('the layer hands rendering a frame source only when its feed is one', () => {
  const seen = [];
  const createNativeRendering = (engine, args) => {
    seen.push(args.frameSource);
    return {
      setAlpha() {},
      rehome() {},
      clear() {},
      getDiagnostics: () => ({}),
    };
  };
  const options = {
    documentRef: target({ hidden: false }),
    eventTarget: target(),
    matchMedia: () => target({ matches: false }),
    createNativeRendering,
  };
  createWeatherLayer({
    ...options,
    feed: { getSnapshot: async () => snapshot },
  }).init(null, { engine: createEngine() });
  const getFrameTile = async () => null;
  createWeatherLayer({
    ...options,
    feed: { getSnapshot: async () => snapshot, getFrameTile },
  }).init(null, { engine: createEngine() });
  assert.equal(seen[0], null);
  assert.equal(typeof seen[1].getTile, 'function');
  assert.equal(seen[1].getImage, undefined);
});

test('supplied tiles are inert without the native provider and their row controls are hidden', async () => {
  const h = fakeImagery();
  const layer = createWeatherLayer({
    feed: {
      getSnapshot: async () => snapshot,
      getFrameTile: () => assert.fail('unsupported tiles are never requested'),
    },
    createNativeRendering: (engine, options) =>
      createWeatherDisplay(engine, {
        ...displayOptions,
        ...options,
        fetchImpl: () =>
          assert.fail('a supplied tile never falls back to the route'),
      }),
    documentRef: target({ hidden: false }),
    eventTarget: target(),
    matchMedia: () => target({ matches: false }),
  });
  layer.init(null, { engine: h.engine });
  layer.enable();
  await layer.update();
  assert.equal(layer.getRowControls(), null);
  assert.equal(layer.getDiagnostics().time, null);
  assert.deepEqual(h.layers(), []);
  layer.destroy();
});

test('clearing before a supplied prefetch finishes aborts and releases the late tile', async () => {
  const gate = deferred();
  const signals = [];
  const h = renderingHarness({
    frameSource: {
      getTile: ({ signal }) => {
        signals.push(signal);
        return gate.promise;
      },
    },
  });
  const pending = h.rendering.prefetch(snapshot, times[1]);
  h.rendering.clear();
  assert.ok(signals.length > 0);
  assert.ok(signals.every((signal) => signal.aborted));
  const tile = suppliedTile();
  gate.resolve(tile);
  assert.equal(await pending, false);
  assert.equal(tile.closes, signals.length);
  assert.equal(h.layers.length, 0);
});
