// The weather shell on the fake and headless Cesium engines: each surface is the display's raised
// imagery layer (render/display.js), whose staged image and detail draw on
// the next microtask. A surface's settle waits for `render()`, as a drawn
// frame waits for the engine to draw it.
import assert from 'node:assert/strict';
import * as geo from '../../geo/index.js';
import { imageryDisplayTests } from '../../testSupport/imageryDisplayEngines.mjs';
const { test, createEngine } = imageryDisplayTests();
import {
  createWeatherShell,
  detailWindow,
  WEATHER_SHELL_CACHE_BYTES,
  WEATHER_SHELL_HEIGHTS,
} from './shellRendering.js';
import { createRaisedWeatherSurface } from './render/display.js';
import { NO_IMAGERY_HOST } from '../shared/imageryHost.js';

const times = [
  '2026-09-15T20:00:00.000Z',
  '2026-09-15T20:05:00.000Z',
  '2026-09-15T20:10:00.000Z',
];
const bounds = { west: -130, south: 20, east: -60, north: 55 };
const snapshot = (product = 'radar', extra = {}) => ({
  product,
  times,
  latest: times[2],
  bounds,
  ...extra,
});
const flush = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
function canvas() {
  const output = { width: 0, height: 0 };
  output.getContext = () => ({
    drawImage(source) {
      output.source = source;
    },
    getImageData: () => ({ data: new Uint8ClampedArray([194, 0, 0, 200]) }),
    putImageData(pixels) {
      output.pixels = pixels.data;
    },
  });
  return output;
}
const response = () => ({
  ok: true,
  headers: new Headers(),
  arrayBuffer: async () => new ArrayBuffer(1),
});
const radians = ([west, south, east, north]) => ({
  west: geo.math.toRadians(west),
  south: geo.math.toRadians(south),
  east: geo.math.toRadians(east),
  north: geo.math.toRadians(north),
});
const box = (west, south, east, north) => ({ west, south, east, north });
/** A detail rectangle (degrees) equals `expected`, within radian round trips. */
function assertBox(actual, expected, message) {
  assert.ok(actual, message ?? 'a detail is drawn');
  for (const edge of ['west', 'south', 'east', 'north'])
    assert.ok(
      Math.abs(actual[edge] - expected[edge]) < 1e-9,
      `${message ?? 'detail'}: ${edge} ${actual[edge]} ≠ ${expected[edge]}`,
    );
}

/**
 * The shell over the fake and headless Cesium engines. `view` is the camera's footprint in
 * degrees (none: no footprint); `look(...)` moves it and ends the move.
 */
function harness({ product = 'radar', view = null, ...options } = {}) {
  const engine = createEngine();
  let footprint = view;
  engine.fake.script('viewRectangle', () =>
    footprint ? radians(footprint) : null,
  );
  const fetches = [];
  const decoded = [];
  const settles = [];
  let host = { collection: null, kind: 'tileset' };
  const shell = createWeatherShell({
    product,
    getHost: () => host,
    requestRender: () => engine.render.request('weather'),
    viewRectangle: () => engine.camera.viewRectangle(),
    moveEnd: engine.camera.moveEnd,
    createSurface: (frame) =>
      createRaisedWeatherSurface(engine, product, {
        ...frame,
        onSettled: () => settles.push(frame.onSettled),
      }),
    fetchImpl: async (url, init) => {
      fetches.push({ url, signal: init.signal });
      return response();
    },
    decodeImage: async () => {
      const size =
        product === 'clouds'
          ? { width: 2048, height: 1024 }
          : { width: 4096, height: 2048 };
      const image = {
        ...size,
        closed: false,
        close() {
          this.closed = true;
        },
      };
      decoded.push(image);
      return image;
    },
    createCanvas: canvas,
    ...options,
  });
  const ids = () => engine.fake.imageryLayers();
  const layer = (id = ids().at(-1)) =>
    id ? engine.fake.imageryLayer(id) : undefined;
  return {
    shell,
    engine,
    fetches,
    decoded,
    setHost(value) {
      host = value;
    },
    look(...edges) {
      footprint = edges;
      engine.camera.moveEnd.raiseEvent();
    },
    listeners: () => engine.camera.moveEnd.numberOfListeners,
    /** Draws what is staged and settles the surfaces that have drawn. */
    async render() {
      await flush();
      for (const settle of settles.splice(0)) settle();
      await flush();
    },
    ids,
    layer,
    image: (id) => layer(id)?.source.image,
    detail: (id) => layer(id)?.detail ?? null,
  };
}
async function show(h, time, options) {
  const pending = h.shell.setFrame(snapshot(h.shell.product), time, options);
  await flush();
  await h.render();
  return pending;
}

test('shell heights stack every product with lightning highest', () => {
  assert.deepEqual(WEATHER_SHELL_HEIGHTS, {
    wind: 5_000,
    clouds: 5_500,
    'clouds-regional': 5_800,
    radar: 6_200,
    lightning: 6_600,
  });
  assert.equal(WEATHER_SHELL_CACHE_BYTES, 128 * 1024 * 1024);
});

test('first frame stages invisibly, then commits once drawn', async () => {
  const h = harness();
  const pending = h.shell.setFrame(snapshot(), times[0]);
  assert.equal(h.shell.getDiagnostics().loading, true);
  await flush();
  assert.equal(h.ids().length, 1);
  const staged = h.layer();
  assert.equal(staged.alpha, 0, 'staging surface is invisible');
  assert.equal(staged.raise, 6_200);
  assert.equal(h.image().width, 4096);
  assert.equal(h.shell.getDiagnostics().time, null);
  await h.render();
  assert.equal(await pending, true);
  assert.equal(h.layer().alpha, 0.7);
  const diagnostics = h.shell.getDiagnostics();
  assert.equal(diagnostics.host, 'shell');
  assert.equal(diagnostics.height, 6_200);
  assert.deepEqual(diagnostics.imageSize, { width: 4096, height: 2048 });
  assert.equal(diagnostics.time, times[0]);
  assert.equal(diagnostics.product, 'radar');
  assert.equal(diagnostics.loading, false);
  assert.equal(diagnostics.imageryCount, 1);
  assert.deepEqual(diagnostics.shell, {
    height: 6_200,
    ready: true,
    uploaded: true,
    show: true,
    alpha: 0.7,
    rendering: false,
    detail: {
      bbox: null,
      size: { width: 4096, height: 2048 },
      ready: false,
      enabled: false,
    },
  });
  assert.equal(h.fetches.length, 1, 'no footprint, no detail window');
  assert.equal(
    new URL(h.fetches[0].url, 'https://example.test').search,
    `?product=radar&time=${encodeURIComponent(times[0])}`,
  );
  h.shell.clear();
});

test('a new frame keeps the previous image until decoded, then swaps it on the same surface', async () => {
  const decode = deferred();
  let first = true;
  const h = harness({
    decodeImage: async () =>
      first
        ? ((first = false), { width: 4096, height: 2048, close() {} })
        : decode.promise,
  });
  assert.equal(await show(h, times[0]), true);
  const [id] = h.ids();
  const previous = h.image();
  const pending = h.shell.setFrame(snapshot(), times[1]);
  await flush();
  assert.equal(h.image(), previous, 'previous image stays');
  assert.equal(h.shell.getDiagnostics().time, times[0]);
  assert.equal(h.shell.getDiagnostics().loading, true);
  let closed = false;
  decode.resolve({
    width: 4096,
    height: 2048,
    close() {
      closed = true;
    },
  });
  assert.equal(await pending, true);
  assert.equal(closed, true, 'decoded image is released');
  await flush();
  assert.notEqual(h.image(), previous);
  assert.equal(h.image().source.width, 4096, 'canvas copy');
  assert.deepEqual(h.ids(), [id], 'same extent reuses the surface');
  assert.equal(h.shell.getDiagnostics().time, times[1]);
  h.shell.clear();
});

for (const outcome of ['fetch', 'decode', 'dimensions', 'timeout']) {
  test(`${outcome} failure retains the previous frame and reports it`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let fail = false;
    const h = harness({
      fetchImpl: async () => {
        if (fail && outcome === 'fetch') throw new Error('offline');
        return response();
      },
      decodeImage: async () => {
        if (fail && outcome === 'decode') throw new Error('bad png');
        if (fail && outcome === 'timeout') return new Promise(() => {});
        return {
          width: fail && outcome === 'dimensions' ? 2048 : 4096,
          height: 2048,
          close() {},
        };
      },
    });
    assert.equal(await show(h, times[0]), true);
    const image = h.image();
    fail = true;
    const pending = h.shell.setFrame(snapshot(), times[1]);
    await flush();
    if (outcome === 'timeout') t.mock.timers.tick(25_000);
    assert.equal(await pending, false);
    assert.equal(h.image(), image);
    assert.equal(h.shell.getDiagnostics().time, times[0]);
    assert.equal(
      h.shell.getDiagnostics().error,
      'Weather tiles unavailable · previous frame retained',
    );
    fail = false;
    assert.equal(await show(h, times[2]), true);
    assert.equal(h.shell.getDiagnostics().error, null);
    h.shell.clear();
  });
}

test('alpha restyles the surface and hidden hides without losing the frame', async () => {
  const h = harness();
  h.shell.setAlpha(0.4);
  assert.equal(await show(h, times[0]), true);
  assert.equal(h.layer().alpha, 0.4);
  const renders = h.engine.fake.renderRequests;
  h.shell.setAlpha(0.8);
  assert.equal(h.layer().alpha, 0.8);
  assert.ok(h.engine.fake.renderRequests > renders);
  const pending = h.shell.setFrame(snapshot(), times[1]);
  h.shell.setHidden(true);
  assert.equal(await pending, false, 'hiding cancels a stage');
  assert.equal(h.layer().shown, false);
  assert.equal(h.shell.getDiagnostics().time, null);
  assert.equal(h.shell.getDiagnostics().hidden, true);
  assert.equal(
    await h.shell.prefetch(snapshot(), times[2]),
    false,
    'hidden frames do not prefetch',
  );
  h.shell.setHidden(false);
  assert.equal(h.layer().shown, true);
  assert.equal(h.shell.getDiagnostics().time, times[0]);
  h.shell.clear();
});

test('clear destroys the surface, listeners, timers and decoded images', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness({ view: [-100, 35, -98, 36] });
  assert.equal(await show(h, times[0]), true);
  assert.equal(h.listeners(), 1);
  const pending = h.shell.setFrame(snapshot(), times[1]);
  const signal = h.fetches.at(-1)?.signal;
  h.shell.clear();
  assert.equal(await pending, false);
  assert.deepEqual(h.ids(), [], 'the surface is destroyed');
  assert.equal(h.listeners(), 0);
  assert.equal(signal?.aborted ?? true, true);
  assert.deepEqual(h.shell.getDiagnostics().cache, {
    mosaics: 0,
    bytes: 0,
    prefetching: false,
  });
  assert.equal(h.shell.getDiagnostics().time, null);
  t.mock.timers.tick(30_000);
  assert.deepEqual(h.ids(), []);
});

test('a new extent stages a second surface and retires the first only once drawn', async () => {
  const h = harness();
  assert.equal(await show(h, times[0]), true);
  const [first] = h.ids();
  const pending = h.shell.setFrame(
    snapshot('radar', { bounds: { ...bounds, south: 21 } }),
    times[0],
  );
  await flush();
  assert.equal(h.ids().length, 2);
  const second = h.ids()[1];
  assert.equal(h.layer(second).alpha, 0);
  assert.equal(h.shell.getDiagnostics().imageryCount, 2);
  await h.render();
  assert.equal(await pending, true);
  assert.deepEqual(h.ids(), [second]);
  assert.equal(h.layer(first), undefined, 'the first is destroyed');
  assert.equal(h.layer(second).alpha, 0.7);
  h.shell.clear();
});

test('decoded frames are a byte-bounded LRU that never evicts the displayed frame', async () => {
  const clouds = harness({
    product: 'clouds',
    cacheBytes: 48 * 1024 * 1024,
  });
  const extra = Array.from({ length: 5 }, (_, i) =>
    new Date(Date.parse(times[2]) + (i + 1) * 60_000).toISOString(),
  );
  const all = [...times, ...extra];
  const sample = snapshot('clouds', { times: all, latest: all.at(-1) });
  for (const time of all.slice(0, 6)) {
    const pending = clouds.shell.setFrame(sample, time);
    await flush();
    await clouds.render();
    assert.equal(await pending, true);
  }
  assert.deepEqual(clouds.shell.getDiagnostics().cache, {
    mosaics: 6,
    bytes: 6 * 8 * 1024 * 1024,
    prefetching: false,
  });
  const pending = clouds.shell.setFrame(sample, all[6]);
  await flush();
  await clouds.render();
  assert.equal(await pending, true);
  assert.equal(clouds.shell.getDiagnostics().cache.mosaics, 6);
  const fetches = clouds.fetches.length;
  const again = clouds.shell.setFrame(sample, all[0]);
  await flush();
  assert.equal(await again, true);
  assert.equal(clouds.fetches.length, fetches + 1, 'oldest was evicted');
  const cached = clouds.shell.setFrame(sample, all[5]);
  assert.equal(await cached, true);
  assert.equal(clouds.fetches.length, fetches + 1);
  assert.deepEqual(clouds.shell.getDiagnostics().mosaic, {
    fetched: false,
    decodeMs: 0,
    cached: true,
  });
  clouds.shell.clear();

  const radar = harness({ cacheBytes: 48 * 1024 * 1024 });
  assert.equal(await show(radar, times[0]), true);
  assert.equal(await show(radar, times[1]), true);
  assert.deepEqual(radar.shell.getDiagnostics().cache, {
    mosaics: 1,
    bytes: 32 * 1024 * 1024,
    prefetching: false,
  });
  assert.equal(await radar.shell.prefetch(snapshot(), times[2]), true);
  assert.equal(
    radar.shell.getDiagnostics().cache.bytes,
    64 * 1024 * 1024,
    'the displayed frame and the newest decode stay',
  );
  assert.equal(await show(radar, times[2]), true);
  assert.equal(radar.shell.getDiagnostics().cache.mosaics, 1);
  assert.equal(radar.fetches.length, 3);
  radar.shell.clear();
});

test('prefetch warms a decoded frame without staging and cancels cleanly', async () => {
  const h = harness();
  assert.equal(await show(h, times[0]), true);
  const warm = h.shell.prefetch(snapshot(), times[1]);
  assert.equal(h.shell.getDiagnostics().cache.prefetching, true);
  assert.equal(await warm, true);
  assert.equal(h.ids().length, 1);
  assert.equal(h.shell.getDiagnostics().time, times[0]);
  assert.equal(
    await h.shell.prefetch(snapshot(), times[1]),
    false,
    'completed work is not repeated',
  );
  assert.equal(await h.shell.setFrame(snapshot(), times[1]), true);
  assert.equal(h.fetches.length, 2);
  assert.equal(h.shell.getDiagnostics().mosaic.cached, true);
  for (const cancel of ['cancelPrefetch', 'clear', 'setHidden']) {
    const decode = deferred();
    const other = harness({ decodeImage: () => decode.promise });
    const pending = other.shell.prefetch(snapshot(), times[2]);
    await flush();
    other.shell[cancel](true);
    assert.equal(other.fetches[0].signal.aborted, true);
    let closed = false;
    decode.resolve({
      width: 4096,
      height: 2048,
      close() {
        closed = true;
      },
    });
    assert.equal(await pending, false);
    assert.equal(closed, true);
    assert.equal(other.shell.getDiagnostics().cache.mosaics, 0);
    other.shell.clear();
  }
  h.shell.clear();
});

test('infrared frames get the display transfer; radar and lightning keep their pixels', async () => {
  for (const [product, transfer] of [
    ['clouds-regional', true],
    ['clouds', true],
    ['radar', false],
    ['lightning', false],
  ]) {
    const h = harness({ product });
    const pending = h.shell.setFrame(snapshot(product), times[0]);
    await flush();
    const image = h.image();
    assert.equal(image.source, h.decoded[0], 'drawn into a canvas');
    assert.equal(h.decoded[0].closed, true);
    assert.equal(image.pixels !== undefined, transfer, product);
    if (transfer)
      assert.deepEqual([...image.pixels], [194, 0, 0, 98], 'clouds only');
    await h.render();
    assert.equal(await pending, true);
    assert.equal(
      h.shell.getDiagnostics().height,
      WEATHER_SHELL_HEIGHTS[product],
    );
    assert.equal(h.layer().raise, WEATHER_SHELL_HEIGHTS[product]);
    h.shell.clear();
  }
});

test('an infrared mode change restages the same time with its own cached canvas', async () => {
  const h = harness({ product: 'clouds' });
  assert.equal(await show(h, times[0]), true);
  const filtered = h.image();
  assert.equal(await show(h, times[0]), true, 'same frame is a no-op');
  assert.equal(h.fetches.length, 1);
  assert.equal(await show(h, times[0], { infrared: 'full' }), true);
  const full = h.image();
  assert.notEqual(full, filtered);
  assert.deepEqual([...full.pixels], [194, 0, 0, 200]);
  assert.equal(h.shell.getDiagnostics().infrared, 'full');
  assert.equal(await show(h, times[0], { infrared: 'filtered' }), true);
  assert.equal(h.image(), filtered, 'cache hit');
  assert.equal(h.fetches.length, 2);
  h.shell.clear();
});

test('image size follows the product maximum', async () => {
  for (const [product, size] of [
    ['radar', [4096, 2048]],
    ['clouds-regional', [4096, 2048]],
    ['lightning', [4096, 2048]],
    ['clouds', [2048, 1024]],
  ]) {
    const h = harness({
      product,
      decodeImage: async () => ({
        width: size[0],
        height: size[1],
        close() {},
      }),
    });
    assert.deepEqual(h.shell.getDiagnostics().imageSize, {
      width: size[0],
      height: size[1],
    });
    assert.equal(await show(h, times[0]), true);
    const url = new URL(h.fetches[0].url, 'https://example.test');
    assert.equal(url.pathname, '/api/weather/image');
    assert.equal(url.searchParams.get('product'), product);
    assert.equal(url.searchParams.get('size'), null);
    h.shell.clear();
  }
});

test('a GPU with a 2048 px texture limit gets 2048 px images', async () => {
  const h = harness({
    maxTextureSize: 2048,
    decodeImage: async () => ({ width: 2048, height: 1024, close() {} }),
  });
  assert.deepEqual(h.shell.getDiagnostics().imageSize, {
    width: 2048,
    height: 1024,
  });
  assert.equal(await show(h, times[0]), true);
  const url = new URL(h.fetches[0].url, 'https://example.test');
  assert.equal(url.searchParams.get('size'), '2048x1024');
  h.shell.clear();
});

test('a host without imagery hides the shell, keeps the frame and refuses work', async () => {
  const h = harness();
  assert.equal(await show(h, times[0]), true);
  h.setHost({ collection: null, kind: 'none' });
  assert.equal(h.shell.rehome(), true);
  assert.equal(h.layer().shown, false);
  assert.equal(h.shell.getDiagnostics().time, times[0]);
  assert.equal(h.shell.getDiagnostics().error, NO_IMAGERY_HOST);
  assert.equal(await h.shell.setFrame(snapshot(), times[1]), false);
  assert.equal(await h.shell.prefetch(snapshot(), times[1]), false);
  h.setHost({ collection: null, kind: 'tileset' });
  h.shell.rehome();
  assert.equal(h.layer().shown, true);
  assert.equal(h.shell.getDiagnostics().error, null);
  h.shell.clear();
});

test('an unowned restage is joined by the next request for the same frame', async () => {
  const h = harness();
  const restage = h.shell.setFrame(snapshot(), times[0]);
  const controller = new AbortController();
  const joined = h.shell.setFrame(snapshot(), times[0], {
    signal: controller.signal,
  });
  await flush();
  assert.equal(h.fetches.length, 1, 'one acquisition');
  const other = h.shell.setFrame(snapshot(), times[0], {
    signal: new AbortController().signal,
  });
  assert.equal(await restage, false, 'an owned stage is not joined');
  assert.equal(await joined, false);
  await flush();
  await h.render();
  assert.equal(await other, true);
  const cancelled = h.shell.setFrame(snapshot(), times[1]);
  const abort = new AbortController();
  const owner = h.shell.setFrame(snapshot(), times[1], {
    signal: abort.signal,
  });
  abort.abort();
  assert.equal(await cancelled, false);
  assert.equal(await owner, false);
  assert.equal(h.shell.getDiagnostics().time, times[0]);
  h.shell.clear();
});

const footprint = (west, south, east, north) => ({ west, south, east, north });

test('detail windows are sized from the footprint, snapped to 0.5° and clamped inside the product', () => {
  // max(2 × the longitude span, 6°) wide, half as tall.
  assert.deepEqual(
    detailWindow(footprint(-100, 35, -98, 36), bounds),
    box(-102, 34, -96, 37),
  );
  assert.deepEqual(
    detailWindow(footprint(-100, 30, -95, 40), bounds),
    box(-102.5, 32.5, -92.5, 37.5),
  );
  assert.deepEqual(
    detailWindow(footprint(-100, 35, -95.8, 36), bounds),
    box(-102.5, 33.5, -93.5, 38),
    'whole-degree widths keep the half height on the grid',
  );
  assert.deepEqual(
    detailWindow(footprint(-98.3, 34.6, -96.3, 35.6), bounds),
    box(-100.5, 33.5, -94.5, 36.5),
  );
  assert.deepEqual(
    detailWindow(footprint(-131, 20, -129, 21), bounds),
    box(-130, 20, -124, 23),
  );
  assert.deepEqual(
    detailWindow(footprint(-61, 54, -59, 56), bounds),
    box(-66, 52, -60, 55),
  );
  const uneven = { west: -129.99, south: 20.01, east: -60.2, north: 54.9 };
  assert.deepEqual(
    detailWindow(footprint(-131, 20, -129, 21), uneven),
    box(-129.5, 20.5, -123.5, 23.5),
    'clamped to the grid inside uneven bounds',
  );
  // Enabled only while narrower than half the product extent (70° here).
  assert.deepEqual(
    detailWindow(footprint(-110, 30, -93, 40), bounds),
    box(-118.5, 26.5, -84.5, 43.5),
  );
  assert.equal(detailWindow(footprint(-110, 30, -92.5, 40), bounds), null);
  assert.equal(detailWindow(footprint(-180, -90, 180, 90), bounds), null);
  assert.equal(
    detailWindow(footprint(10, 45, 12, 46), bounds),
    null,
    'a view away from the product',
  );
  assert.equal(detailWindow(null, bounds), null);
  assert.equal(
    detailWindow(footprint(-100, 35, -98, 36), {
      west: -130,
      south: 30,
      east: -60,
      north: 32,
    }),
    null,
    'a window taller than the product',
  );
  const world = { west: -180, south: -60, east: 180, north: 60 };
  assert.deepEqual(
    detailWindow(footprint(170, 0, -170, 10), world),
    box(140, -5, 180, 15),
    'a footprint across the antimeridian',
  );
  for (const [west, south, east, north] of [
    [-100, 35, -98, 36],
    [-129.7, 20.2, -121.1, 24.4],
    [-75.3, 41.1, -61.2, 54.8],
    [-97.77, 30.03, -96.41, 30.9],
  ]) {
    const next = detailWindow(footprint(west, south, east, north), bounds);
    assert.equal(next.east - next.west, 2 * (next.north - next.south));
    assert.ok(Object.values(next).every((edge) => Number.isInteger(edge * 2)));
    assert.ok(
      next.west >= bounds.west &&
        next.east <= bounds.east &&
        next.south >= bounds.south &&
        next.north <= bounds.north,
    );
  }
});

test('detail windows hold while the view stays in their inner half and the span within 50 %', () => {
  const first = detailWindow(footprint(-100, 35, -98, 36), bounds);
  assert.equal(
    detailWindow(footprint(-98.6, 35.5, -96.6, 36.5), bounds, first),
    first,
    'panning inside the inner half costs nothing',
  );
  assert.deepEqual(
    detailWindow(footprint(-98.4, 35, -96.4, 36), bounds, first),
    box(-100.5, 34, -94.5, 37),
  );
  assert.deepEqual(
    detailWindow(footprint(-100, 36, -98, 37), bounds, first),
    box(-102, 35, -96, 38),
  );
  const wide = detailWindow(footprint(-100, 30, -95, 40), bounds);
  assert.equal(detailWindow(footprint(-101, 30, -94, 40), bounds, wide), wide);
  assert.equal(detailWindow(footprint(-99, 30, -96, 40), bounds, wide), wide);
  const out = detailWindow(footprint(-101.5, 30, -93.5, 40), bounds, wide);
  assert.deepEqual(out, box(-105.5, 31, -89.5, 39), 'zoomed out');
  assert.deepEqual(
    detailWindow(footprint(-99.25, 34.5, -95.75, 35.5), bounds, out),
    box(-101, 33.5, -94, 37),
    'zoomed in',
  );
  assert.equal(
    detailWindow(footprint(-106, 30, -88, 40), bounds, out),
    null,
    'zooming past half the product disables the window',
  );
  const edge = detailWindow(footprint(-131, 20, -129, 21), bounds);
  assert.equal(
    detailWindow(footprint(-131.2, 20, -129.2, 21), bounds, edge),
    edge,
    'a clamped window that would not move is kept',
  );
});

const query = (url) => new URL(url, 'https://example.test').searchParams;
const WINDOW = box(-102, 34, -96, 37);

test('a detail window follows the view after the full-extent frame, on the same surface', async () => {
  const h = harness({ view: [-100, 35, -98, 36] });
  const pending = h.shell.setFrame(snapshot(), times[0]);
  await flush();
  assert.equal(h.fetches.length, 1, 'the full-extent image comes first');
  assert.equal(h.detail(), null);
  await h.render();
  assert.equal(await pending, true);
  assert.equal(h.listeners(), 1);
  assert.equal(h.fetches.length, 2);
  assert.equal(query(h.fetches[1].url).get('bbox'), '-102,34,-96,37');
  assert.equal(query(h.fetches[1].url).get('time'), times[0]);
  assert.equal(query(h.fetches[1].url).get('size'), null);
  const [shell] = h.ids();
  assert.equal(h.ids().length, 1, 'no second surface');
  assert.equal(h.detail().image.source, h.decoded[1]);
  assertBox(h.detail().rectangle, WINDOW);
  assert.deepEqual(h.shell.getDiagnostics().shell.detail, {
    bbox: [-102, 34, -96, 37],
    size: { width: 4096, height: 2048 },
    ready: true,
    enabled: true,
  });
  assert.equal(h.shell.getDiagnostics().imageryCount, 1);

  h.look(-99.5, 35.2, -97.5, 36.2);
  await flush();
  assert.equal(
    h.fetches.length,
    2,
    'panning inside the window fetches nothing',
  );

  h.look(-90, 40, -88, 41);
  assert.equal(h.detail(), null, 'a moved window clears at once');
  assert.deepEqual(h.shell.getDiagnostics().shell.detail, {
    bbox: [-92, 39, -86, 42],
    size: { width: 4096, height: 2048 },
    ready: false,
    enabled: true,
  });
  await flush();
  assert.equal(query(h.fetches[2].url).get('bbox'), '-92,39,-86,42');
  assert.equal(h.detail().image.source, h.decoded[2]);
  assertBox(h.detail().rectangle, box(-92, 39, -86, 42));
  assert.equal(h.shell.getDiagnostics().shell.detail.ready, true);

  h.look(-120, 25, -100, 50);
  assert.equal(h.detail(), null, 'a wide view needs no window');
  assert.deepEqual(h.shell.getDiagnostics().shell.detail, {
    bbox: null,
    size: { width: 4096, height: 2048 },
    ready: false,
    enabled: false,
  });
  await flush();
  assert.equal(h.fetches.length, 3);
  assert.deepEqual(h.ids(), [shell]);
  assert.equal(h.shell.getDiagnostics().imageryCount, 1);
  h.shell.clear();
  assert.equal(h.listeners(), 0);
});

test('a new extent restages the surface and the detail follows onto it', async () => {
  const h = harness({ view: [-100, 35, -98, 36] });
  assert.equal(await show(h, times[0]), true);
  await h.render();
  const [first] = h.ids();
  const detail = h.detail().image;
  const wider = { ...bounds, west: -140 };
  const pending = h.shell.setFrame(
    snapshot('radar', { bounds: wider }),
    times[0],
  );
  await flush();
  const [, second] = h.ids();
  assert.equal(h.detail(second), null);
  assert.equal(h.shell.getDiagnostics().imageryCount, 2, 'staged, no detail');
  await h.render();
  assert.equal(await pending, true);
  assert.deepEqual(h.ids(), [second]);
  assert.equal(h.layer(first), undefined);
  assert.equal(h.detail(second).image, detail, 'the same detail image');
  assertBox(h.detail(second).rectangle, WINDOW);
  assert.equal(h.fetches.length, 2, 'nothing fetched again');
  assert.equal(h.shell.getDiagnostics().shell.detail.ready, true);
  h.shell.clear();
});

test('a new frame swaps the full-extent image first and keeps the detail until its own image decodes', async () => {
  const urls = [];
  let gate = null;
  let offline = false;
  const h = harness({
    view: [-100, 35, -98, 36],
    fetchImpl: async (url) => {
      urls.push(url);
      if (offline && url.includes('bbox=')) throw new Error('offline');
      return response();
    },
    decodeImage: async () => {
      if (gate && urls.at(-1).includes('bbox=')) await gate.promise;
      return { width: 4096, height: 2048, close() {} };
    },
  });
  assert.equal(await show(h, times[0]), true);
  await h.render();
  const previous = { image: h.image(), detail: h.detail().image };
  gate = deferred();
  assert.equal(await h.shell.setFrame(snapshot(), times[1]), true);
  await flush();
  assert.notEqual(h.image(), previous.image);
  assert.equal(h.shell.getDiagnostics().time, times[1]);
  assert.equal(query(urls.at(-1)).get('time'), times[1]);
  assert.equal(query(urls.at(-1)).get('bbox'), '-102,34,-96,37');
  assert.equal(h.detail().image, previous.detail, 'the previous detail stays');
  assertBox(h.detail().rectangle, WINDOW);
  assert.equal(h.shell.getDiagnostics().shell.detail.ready, false);
  gate.resolve();
  await flush();
  assert.notEqual(h.detail().image, previous.detail);
  assertBox(
    h.detail().rectangle,
    WINDOW,
    'the same window swaps only the image',
  );
  assert.equal(h.shell.getDiagnostics().shell.detail.ready, true);

  gate = null;
  offline = true;
  assert.equal(await h.shell.setFrame(snapshot(), times[2]), true);
  await flush();
  assert.equal(
    h.detail(),
    null,
    'a failed detail leaves no older one over the frame',
  );
  assert.equal(h.shell.getDiagnostics().time, times[2]);
  assert.equal(h.shell.getDiagnostics().error, null);
  h.shell.clear();
});

test('an older detail stays over at most one newer frame; a warmed detail follows every frame', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const all = Array.from({ length: 5 }, (_, i) =>
    new Date(Date.parse(times[0]) + i * 300_000).toISOString(),
  );
  const playback = snapshot('radar', { times: all, latest: all.at(-1) });
  const advance = async (h, time) => {
    const pending = h.shell.setFrame(playback, time);
    await flush();
    await h.render();
    assert.equal(await pending, true);
    await flush();
  };

  const requests = [];
  let slow = false;
  const h = harness({
    view: [-100, 35, -98, 36],
    fetchImpl: async (url, init) => {
      requests.push({ url, signal: init.signal });
      return response();
    },
    decodeImage: async () =>
      slow && requests.at(-1).url.includes('bbox=')
        ? new Promise(() => {})
        : { width: 4096, height: 2048, close() {} },
  });
  await advance(h, all[0]);
  const first = h.detail().image;
  assertBox(h.detail().rectangle, WINDOW);
  slow = true;
  await advance(h, all[1]);
  assert.equal(h.detail().image, first, 'over one newer frame');
  assertBox(h.detail().rectangle, WINDOW);
  assert.equal(h.shell.getDiagnostics().shell.detail.ready, false);
  await advance(h, all[2]);
  assert.equal(h.detail(), null, 'cleared at the second');
  for (const time of all.slice(3)) {
    await advance(h, time);
    assert.equal(h.detail(), null);
  }
  const details = requests.filter(({ url }) => url.includes('bbox='));
  assert.deepEqual(
    details.map(({ url }) => query(url).get('time')),
    all,
  );
  assert.ok(
    details.slice(1, -1).every(({ signal }) => signal.aborted),
    'each newer frame replaces the pending detail',
  );
  assert.equal(details.at(-1).signal.aborted, false);
  h.shell.clear();

  const warm = harness({ view: [-100, 35, -98, 36] });
  await advance(warm, all[0]);
  assertBox(warm.detail().rectangle, WINDOW);
  // The window never empties: every detail the surface is handed is an image.
  let emptied = 0;
  const id = warm.ids()[0];
  for (const time of all.slice(1)) {
    assert.equal(await warm.shell.prefetch(playback, time), true);
    const fetches = warm.fetches.length;
    const previous = warm.detail().image;
    const pending = warm.shell.setFrame(playback, time);
    for (let i = 0; i < 30; i++) {
      if (warm.detail(id) === null) emptied++;
      await Promise.resolve();
    }
    await warm.render();
    assert.equal(await pending, true);
    assert.equal(warm.fetches.length, fetches, 'both images from the cache');
    assert.notEqual(warm.detail().image, previous, time);
    assertBox(warm.detail().rectangle, WINDOW);
    assert.equal(warm.shell.getDiagnostics().shell.detail.ready, true);
  }
  assert.equal(emptied, 0, 'the window never empties');
  warm.shell.clear();
});

test('hiding, a host without imagery and clear hide or release the detail with its surface', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness({ view: [-100, 35, -98, 36] });
  assert.equal(await show(h, times[0]), true);
  await h.render();
  const [shell] = h.ids();
  h.shell.setHidden(true);
  assert.equal(h.layer().shown, false);
  assertBox(h.detail().rectangle, WINDOW, 'the detail hides with its surface');
  assert.equal(h.shell.getDiagnostics().shell.detail.ready, false);
  h.shell.setHidden(false);
  assert.equal(h.layer().shown, true);
  assertBox(h.detail().rectangle, WINDOW);
  assert.equal(h.shell.getDiagnostics().shell.detail.ready, true);
  h.shell.setAlpha(0.4);
  assert.equal(h.layer().alpha, 0.4);
  h.setHost({ collection: null, kind: 'none' });
  h.shell.rehome();
  assert.equal(h.layer().shown, false);
  h.look(-90, 40, -88, 41);
  await flush();
  assert.equal(h.fetches.length, 2, 'no window work without a host');
  assert.equal(h.detail(), null, 'the moved window is dropped');
  h.setHost({ collection: null, kind: 'tileset' });
  h.shell.rehome();
  await flush();
  assert.equal(query(h.fetches[2].url).get('bbox'), '-92,39,-86,42');
  assertBox(h.detail().rectangle, box(-92, 39, -86, 42));
  assert.deepEqual(h.ids(), [shell]);

  // Frames shown while hidden leave no older detail to reappear.
  h.shell.setHidden(true);
  for (const time of [times[1], times[2]])
    assert.equal(await h.shell.setFrame(snapshot(), time), true);
  h.shell.setHidden(false);
  assert.equal(h.detail(), null);
  await flush();
  assert.equal(query(h.fetches.at(-1).url).get('time'), times[2]);
  await h.render();
  assert.equal(h.shell.getDiagnostics().shell.detail.ready, true);

  h.shell.clear();
  assert.deepEqual(h.ids(), []);
  assert.equal(h.listeners(), 0);
  assert.deepEqual(h.shell.getDiagnostics().cache, {
    mosaics: 0,
    bytes: 0,
    prefetching: false,
  });

  // A detail image still decoding is abandoned, never installed.
  const gate = deferred();
  const requests = [];
  const late = harness({
    view: [-100, 35, -98, 36],
    fetchImpl: async (url, init) => {
      requests.push({ url, signal: init.signal });
      return response();
    },
    decodeImage: async () => {
      if (requests.at(-1).url.includes('bbox=')) await gate.promise;
      return { width: 4096, height: 2048, close() {} };
    },
  });
  assert.equal(await show(late, times[0]), true);
  await flush();
  assert.equal(requests.length, 2);
  late.shell.clear();
  assert.equal(requests[1].signal.aborted, true);
  gate.resolve();
  await flush();
  assert.deepEqual(late.ids(), []);
  assert.equal(late.shell.getDiagnostics().cache.mosaics, 0);
  t.mock.timers.tick(30_000);
  assert.deepEqual(h.ids(), []);
});

test('full-extent and detail images share one byte budget; prefetch warms both', async () => {
  const h = harness({ view: [-100, 35, -98, 36] });
  const MiB = 1024 * 1024;
  assert.equal(await show(h, times[0]), true);
  await h.render();
  assert.deepEqual(h.shell.getDiagnostics().cache, {
    mosaics: 2,
    bytes: 64 * MiB,
    prefetching: false,
  });
  assert.equal(await h.shell.prefetch(snapshot(), times[1]), true);
  assert.deepEqual(
    h.fetches
      .slice(2)
      .map(({ url }) => [query(url).get('time'), query(url).get('bbox')]),
    [
      [times[1], null],
      [times[1], '-102,34,-96,37'],
    ],
  );
  assert.equal(
    h.shell.getDiagnostics().cache.bytes,
    128 * MiB,
    'the shown pair and the warmed pair stay',
  );
  assert.equal(
    await h.shell.prefetch(snapshot(), times[1]),
    false,
    'completed work is not repeated',
  );
  assert.equal(await show(h, times[1]), true);
  await h.render();
  assert.equal(h.fetches.length, 4, 'both images came from the cache');
  assert.equal(h.shell.getDiagnostics().mosaic.cached, true);
  assert.equal(h.shell.getDiagnostics().shell.detail.ready, true);
  assert.deepEqual(h.shell.getDiagnostics().cache, {
    mosaics: 4,
    bytes: 128 * MiB,
    prefetching: false,
  });
  // After a prefetch the cache holds the shown pair and the warmed pair only.
  assert.equal(await h.shell.prefetch(snapshot(), times[2]), true);
  assert.equal(h.fetches.length, 6);
  assert.deepEqual(h.shell.getDiagnostics().cache, {
    mosaics: 4,
    bytes: 128 * MiB,
    prefetching: false,
  });
  for (const time of [times[2], times[1]]) {
    assert.equal(await show(h, time), true);
    await h.render();
    assert.equal(h.fetches.length, 6, `${time} full-extent and detail cached`);
    assert.equal(h.shell.getDiagnostics().shell.detail.ready, true);
  }
  assert.equal(await show(h, times[0]), true);
  await flush();
  assert.equal(h.fetches.length, 8, 'nothing older survived the prefetch');
  assert.equal(h.shell.getDiagnostics().cache.bytes, 128 * MiB);
  h.shell.clear();

  const wide = harness({ view: [-120, 25, -100, 50] });
  assert.equal(await show(wide, times[0]), true);
  assert.equal(await wide.shell.prefetch(snapshot(), times[1]), true);
  assert.equal(wide.fetches.length, 2, 'no window, no detail prefetch');
  assert.ok(wide.fetches.every(({ url }) => !url.includes('bbox=')));
  wide.shell.clear();
});

test('global infrared keeps one full-extent image and no detail window', async () => {
  const clouds = harness({ product: 'clouds', view: [-100, 35, -98, 36] });
  assert.equal(await show(clouds, times[0]), true);
  await flush();
  assert.equal(clouds.listeners(), 0);
  assert.equal(clouds.fetches.length, 1);
  assert.equal(clouds.shell.getDiagnostics().shell.detail.enabled, false);
  assert.equal(await clouds.shell.prefetch(snapshot('clouds'), times[1]), true);
  assert.ok(clouds.fetches.every(({ url }) => !url.includes('bbox=')));
  clouds.shell.clear();
});

test('the shell hands its surface the height and the extent in radians', async () => {
  const surfaces = [];
  const shell = createWeatherShell({
    product: 'radar',
    viewRectangle: () => ({ west: -1.8, south: 0.5, east: -1.6, north: 0.6 }),
    moveEnd: { addEventListener: () => () => {} },
    requestRender: () => {},
    fetchImpl: async () => response(),
    decodeImage: async () => ({
      width: 4096,
      height: 2048,
      close() {},
    }),
    createCanvas: canvas,
    createSurface: (options) => {
      surfaces.push(options);
      return {
        setAlpha() {},
        setImage() {},
        setDetail() {},
        setShow: () => false,
        destroy() {},
        getDiagnostics: () => null,
      };
    },
  });
  shell.setFrame(snapshot('radar'), times[0]);
  await flush();
  assert.equal(surfaces.length, 1);
  assert.deepEqual(Object.keys(surfaces[0]).sort(), [
    'height',
    'onSettled',
    'rectangle',
  ]);
  assert.equal(surfaces[0].height, WEATHER_SHELL_HEIGHTS.radar);
  for (const side of ['west', 'south', 'east', 'north'])
    assert.equal(surfaces[0].rectangle[side], geo.math.toRadians(bounds[side]));
  shell.clear();
});

test('a frame source supplies the full-extent and detail images, the detail through its bbox', async () => {
  const view = [-100, 35, -98, 36];
  const requests = [];
  const supplied = [];
  const h = harness({
    view,
    fetchImpl: () => assert.fail('supplied images are not fetched'),
    decodeImage: () => assert.fail('supplied images are not decoded'),
    frameSource: {
      getImage: async (request) => {
        requests.push(request);
        const image = {
          ...request.size,
          closed: 0,
          close() {
            this.closed++;
          },
        };
        supplied.push(image);
        return image;
      },
    },
  });
  const pending = h.shell.setFrame(snapshot(), times[0]);
  await flush();
  await h.render();
  assert.equal(await pending, true);
  await flush();
  assert.deepEqual(
    requests.map(({ product, time, size, bbox }) => ({
      product,
      time,
      size,
      bbox,
    })),
    [
      {
        product: 'radar',
        time: times[0],
        size: { width: 4096, height: 2048 },
        bbox: null,
      },
      {
        product: 'radar',
        time: times[0],
        size: { width: 4096, height: 2048 },
        bbox: box(-102, 34, -96, 37),
      },
    ],
  );
  assert.ok(supplied.every(({ closed }) => closed === 1));
  assert.equal(h.image().source, supplied[0]);
  assert.equal(h.detail().image.source, supplied[1]);
  await h.render();
  assertBox(h.detail().rectangle, box(-102, 34, -96, 37));
  h.shell.clear();
});

test('cancelling a supplied frame aborts the frame source request', async () => {
  const gate = deferred();
  let signal;
  const h = harness({
    frameSource: {
      getImage: (request) => {
        signal = request.signal;
        return gate.promise;
      },
    },
  });
  const abort = new AbortController();
  const pending = h.shell.setFrame(snapshot(), times[0], {
    signal: abort.signal,
  });
  await flush();
  abort.abort();
  assert.equal(signal.aborted, true);
  assert.equal(await pending, false);
  const late = {
    width: 4096,
    height: 2048,
    closed: 0,
    close() {
      this.closed++;
    },
  };
  gate.resolve(late);
  await flush();
  assert.equal(
    late.closed,
    1,
    'a frame arriving after cancellation is released',
  );
  assert.equal(h.ids().length, 0);
  h.shell.clear();
});
