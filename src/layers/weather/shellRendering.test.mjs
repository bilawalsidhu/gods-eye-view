import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import {
  createShellSurface,
  createWeatherShell,
  orderWeatherShells,
  WEATHER_SHELL_CACHE_BYTES,
  WEATHER_SHELL_HEIGHTS,
} from './shellRendering.js';
import { NO_IMAGERY_HOST } from './imageryHost.js';
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

function harness({ product = 'radar', ...options } = {}) {
  const cesium = options.cesium ?? createShellCesium();
  const scene = createShellScene();
  const fetches = [];
  const decoded = [];
  let host = { collection: null, kind: 'tileset' };
  const shell = createWeatherShell({
    viewer: { scene },
    cesium,
    product,
    getHost: () => host,
    fetchImpl: async (url, init) => {
      fetches.push({ url, signal: init.signal });
      return response();
    },
    decodeImage: async () => {
      const size = product.match(/radar|regional/)
        ? { width: 4096, height: 2048 }
        : { width: 2048, height: 1024 };
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
  return {
    shell,
    cesium,
    scene,
    fetches,
    decoded,
    setHost(value) {
      host = value;
    },
    render: (count) => renderShells(cesium, scene, count),
    primitives: () => scene.primitives.items,
    material: () => scene.primitives.items.at(-1)?.appearance.material,
  };
}
async function show(h, time, options) {
  const pending = h.shell.setFrame(snapshot(h.shell.product), time, options);
  await flush();
  h.render();
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
  assert.equal(WEATHER_SHELL_CACHE_BYTES, 48 * 1024 * 1024);
});

test('surface builds a flat raised rectangle drawn in primitive order without depth writes', () => {
  const cesium = createShellCesium();
  const scene = createShellScene();
  const rectangle = Cesium.Rectangle.fromDegrees(-130, 20, -60, 55);
  const surface = createShellSurface({
    viewer: { scene },
    cesium,
    rectangle,
    height: 6_200,
  });
  const template = cesium.templates.get('WeatherFrame');
  assert.ok(!(template instanceof cesium.Material), 'plain template');
  assert.deepEqual(template.fabric.uniforms, {
    image: Cesium.Material.DefaultImageId,
    alpha: 1,
  });
  assert.match(template.fabric.components.alpha, /\* alpha \*/);
  assert.match(
    template.fabric.components.alpha,
    /step\(1\.5, float\(imageDimensions\.x\)\)/,
  );
  const [primitive] = scene.primitives.items;
  const appearance = primitive.appearance;
  assert.equal(appearance.material.options.translucent, false);
  assert.deepEqual(
    { ...appearance.options, material: undefined },
    {
      aboveGround: true,
      flat: true,
      translucent: false,
      material: undefined,
    },
  );
  assert.deepEqual(appearance.getRenderState(), {
    depthTest: { enabled: true },
    depthMask: false,
    blending: Cesium.BlendingState.ALPHA_BLEND,
  });
  const geometry = primitive.options.geometryInstances.geometry.options;
  assert.equal(geometry.rectangle, rectangle);
  assert.equal(geometry.height, 6_200);
  assert.equal(geometry.granularity, Cesium.Math.toRadians(0.5));
  assert.equal(
    geometry.vertexFormat,
    Cesium.EllipsoidSurfaceAppearance.VERTEX_FORMAT,
  );
  assert.equal(primitive.options.asynchronous, true);
  assert.equal(primitive.options.allowPicking, false);
  createShellSurface({ viewer: { scene }, cesium, rectangle, height: 5_000 });
  assert.equal(cesium.templates.size, 1, 'the template registers once');
  surface.destroy();
});

test('real Cesium accepts the template, the opaque-pass appearance and the rectangle primitive', () => {
  const scene = {
    primitives: new Cesium.PrimitiveCollection(),
    postRender: new Cesium.Event(),
    requestRender() {},
  };
  const surface = createShellSurface({
    viewer: { scene },
    cesium: Cesium,
    rectangle: Cesium.Rectangle.fromDegrees(-130, 20, -60, 55),
    height: 6_600,
  });
  const cached = Cesium.Material._materialCache.getMaterial('WeatherFrame');
  assert.ok(cached && !(cached instanceof Cesium.Material));
  const primitive = scene.primitives.get(0);
  const material = primitive.appearance.material;
  assert.ok(primitive instanceof Cesium.Primitive);
  assert.equal(material.type, 'WeatherFrame');
  assert.equal(material.isTranslucent(), false);
  assert.equal(primitive.appearance.isTranslucent(), false, 'opaque pass');
  assert.equal(primitive.appearance.getRenderState().depthMask, false);
  assert.equal(
    Cesium.Appearance.prototype.getRenderState.call(primitive.appearance)
      .depthMask,
    true,
    'the default opaque render state would write depth',
  );
  assert.deepEqual(
    { x: material.uniforms.imageDimensions.x },
    { x: 1 },
    'Cesium tracks the bound texture size',
  );
  assert.match(
    material.shaderSource,
    /step\(1\.5, float\(imageDimensions_\d+\.x\)\)/,
  );
  surface.setAlpha(0.4);
  assert.equal(material.uniforms.alpha, 0.4);
  surface.destroy();
  assert.equal(scene.primitives.length, 0);
  assert.equal(primitive.isDestroyed(), true);
  assert.equal(material.isDestroyed(), true);
  assert.equal(scene.postRender.numberOfListeners, 0);
});

test('shells draw first, in height order, regardless of add order', () => {
  const scene = createShellScene();
  const other = { name: 'other' };
  scene.primitives.add(other);
  const add = (name, height) => {
    const primitive = { name };
    scene.primitives.add(primitive);
    orderWeatherShells(scene.primitives, primitive, height);
    return primitive;
  };
  add('lightning', 6_600);
  add('radar', 6_200);
  add('wind', 5_000);
  const later = { name: 'later' };
  scene.primitives.add(later);
  add('regional', 5_800);
  assert.deepEqual(
    scene.primitives.items.map(({ name }) => name),
    ['wind', 'regional', 'radar', 'lightning', 'other', 'later'],
  );
  const primitives = new Cesium.PrimitiveCollection({
    destroyPrimitives: false,
  });
  const real = (name) => ({ name, update() {}, isDestroyed: () => false });
  const tileset = primitives.add(real('tileset'));
  const lightning = primitives.add(real('lightning'));
  orderWeatherShells(primitives, lightning, 6_600);
  const radar = primitives.add(real('radar'));
  orderWeatherShells(primitives, radar, 6_200);
  assert.deepEqual(
    [0, 1, 2].map((i) => primitives.get(i).name),
    ['radar', 'lightning', 'tileset'],
    'real Cesium collection order',
  );
  assert.equal(tileset.name, 'tileset');
});

test('first frame stages invisibly, requests renders until drawable and then commits', async () => {
  const h = harness();
  const pending = h.shell.setFrame(snapshot(), times[0]);
  assert.equal(h.shell.getDiagnostics().loading, true);
  await flush();
  const material = h.material();
  assert.equal(h.primitives().length, 1);
  assert.equal(material.uniforms.alpha, 0, 'staging surface is invisible');
  assert.equal(material.uniforms.image.width, 4096);
  assert.equal(h.scene.postRender.size, 1, 'render loop while not drawable');
  const before = h.scene.renders;
  h.scene.postRender.emit();
  assert.ok(h.scene.renders > before, 'each render asks for another');
  assert.equal(h.shell.getDiagnostics().time, null);
  h.render();
  assert.equal(await pending, true);
  assert.equal(material.uniforms.alpha, 0.7);
  assert.equal(h.scene.postRender.size, 0, 'render loop ends');
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
  });
  assert.equal(
    new URL(h.fetches[0].url, 'https://example.test').search,
    `?product=radar&time=${encodeURIComponent(times[0])}`,
  );
  h.shell.clear();
});

test('a new frame keeps the previous image until decoded, then swaps the uniform', async () => {
  const decode = deferred();
  let first = true;
  const h = harness({
    decodeImage: async () =>
      first
        ? ((first = false), { width: 4096, height: 2048, close() {} })
        : decode.promise,
  });
  assert.equal(await show(h, times[0]), true);
  const material = h.material();
  const previous = material.uniforms.image;
  const pending = h.shell.setFrame(snapshot(), times[1]);
  await flush();
  assert.equal(material.uniforms.image, previous, 'previous image stays');
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
  assert.notEqual(material.uniforms.image, previous);
  assert.equal(material.uniforms.image.source.width, 4096, 'canvas copy');
  assert.equal(h.primitives().length, 1, 'same extent reuses the surface');
  assert.equal(h.shell.getDiagnostics().time, times[1]);
  assert.equal(h.scene.postRender.size, 1, 'renders until the upload');
  h.render();
  assert.equal(h.scene.postRender.size, 0);
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
    const image = h.material().uniforms.image;
    fail = true;
    const pending = h.shell.setFrame(snapshot(), times[1]);
    await flush();
    if (outcome === 'timeout') t.mock.timers.tick(25_000);
    assert.equal(await pending, false);
    assert.equal(h.material().uniforms.image, image);
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

test('alpha writes the uniform and hidden hides without losing the frame', async () => {
  const h = harness();
  h.shell.setAlpha(0.4);
  assert.equal(await show(h, times[0]), true);
  const material = h.material();
  assert.equal(material.uniforms.alpha, 0.4);
  const renders = h.scene.renders;
  h.shell.setAlpha(0.8);
  assert.equal(material.uniforms.alpha, 0.8);
  assert.ok(h.scene.renders > renders);
  const primitive = h.primitives()[0];
  const pending = h.shell.setFrame(snapshot(), times[1]);
  h.shell.setHidden(true);
  assert.equal(await pending, false, 'hiding cancels a stage');
  assert.equal(primitive.show, false);
  assert.equal(h.shell.getDiagnostics().time, null);
  assert.equal(h.shell.getDiagnostics().hidden, true);
  assert.equal(
    await h.shell.prefetch(snapshot(), times[2]),
    false,
    'hidden frames do not prefetch',
  );
  h.shell.setHidden(false);
  assert.equal(primitive.show, true);
  assert.equal(h.shell.getDiagnostics().time, times[0]);
  h.shell.clear();
});

test('clear destroys the primitive, material, listeners, timers and decoded images', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness();
  assert.equal(await show(h, times[0]), true);
  const [primitive] = h.primitives();
  const material = primitive.appearance.material;
  const pending = h.shell.setFrame(snapshot(), times[1]);
  const signal = h.fetches.at(-1)?.signal;
  h.shell.clear();
  assert.equal(await pending, false);
  assert.equal(h.primitives().length, 0);
  assert.equal(primitive.destroyed, true);
  assert.equal(material.destroyed, true, 'the material is destroyed too');
  assert.equal(h.scene.postRender.size, 0);
  assert.equal(signal?.aborted ?? true, true);
  assert.deepEqual(h.shell.getDiagnostics().cache, {
    mosaics: 0,
    bytes: 0,
    prefetching: false,
  });
  assert.equal(h.shell.getDiagnostics().time, null);
  t.mock.timers.tick(30_000);
  assert.equal(h.primitives().length, 0);
});

test('a new extent stages a second surface and retires the first only once drawable', async () => {
  const h = harness();
  assert.equal(await show(h, times[0]), true);
  const [first] = h.primitives();
  const pending = h.shell.setFrame(
    snapshot('radar', { bounds: { ...bounds, south: 21 } }),
    times[0],
  );
  await flush();
  assert.equal(h.primitives().length, 2);
  const second = h.primitives()[1];
  assert.equal(second.appearance.material.uniforms.alpha, 0);
  assert.equal(h.shell.getDiagnostics().imageryCount, 2);
  h.render();
  assert.equal(await pending, true);
  assert.deepEqual(h.primitives(), [second]);
  assert.equal(first.destroyed, true);
  assert.equal(first.appearance.material.destroyed, true);
  assert.equal(second.appearance.material.uniforms.alpha, 0.7);
  h.shell.clear();
});

test('decoded frames are a byte-bounded LRU that never evicts the displayed frame', async () => {
  const lightning = harness({ product: 'lightning' });
  const extra = Array.from({ length: 5 }, (_, i) =>
    new Date(Date.parse(times[2]) + (i + 1) * 60_000).toISOString(),
  );
  const all = [...times, ...extra];
  const sample = snapshot('lightning', { times: all, latest: all.at(-1) });
  for (const time of all.slice(0, 6)) {
    const pending = lightning.shell.setFrame(sample, time);
    await flush();
    lightning.render();
    assert.equal(await pending, true);
  }
  assert.deepEqual(lightning.shell.getDiagnostics().cache, {
    mosaics: 6,
    bytes: 6 * 8 * 1024 * 1024,
    prefetching: false,
  });
  const pending = lightning.shell.setFrame(sample, all[6]);
  await flush();
  lightning.render();
  assert.equal(await pending, true);
  assert.equal(lightning.shell.getDiagnostics().cache.mosaics, 6);
  const fetches = lightning.fetches.length;
  const again = lightning.shell.setFrame(sample, all[0]);
  await flush();
  assert.equal(await again, true);
  assert.equal(lightning.fetches.length, fetches + 1, 'oldest was evicted');
  const cached = lightning.shell.setFrame(sample, all[5]);
  assert.equal(await cached, true);
  assert.equal(lightning.fetches.length, fetches + 1);
  assert.deepEqual(lightning.shell.getDiagnostics().mosaic, {
    fetched: false,
    decodeMs: 0,
    cached: true,
  });
  lightning.shell.clear();

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
  assert.equal(h.primitives().length, 1);
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
    const image = h.material().uniforms.image;
    assert.equal(image.source, h.decoded[0], 'drawn into a canvas');
    assert.equal(h.decoded[0].closed, true);
    assert.equal(image.pixels !== undefined, transfer, product);
    if (transfer)
      assert.deepEqual([...image.pixels], [194, 0, 0, 98], 'clouds only');
    h.render();
    assert.equal(await pending, true);
    assert.equal(
      h.shell.getDiagnostics().height,
      WEATHER_SHELL_HEIGHTS[product],
    );
    h.shell.clear();
  }
});

test('an infrared mode change restages the same time with its own cached canvas', async () => {
  const h = harness({ product: 'clouds' });
  assert.equal(await show(h, times[0]), true);
  const filtered = h.material().uniforms.image;
  assert.equal(await show(h, times[0]), true, 'same frame is a no-op');
  assert.equal(h.fetches.length, 1);
  assert.equal(await show(h, times[0], { infrared: 'full' }), true);
  const full = h.material().uniforms.image;
  assert.notEqual(full, filtered);
  assert.deepEqual([...full.pixels], [194, 0, 0, 200]);
  assert.equal(h.shell.getDiagnostics().infrared, 'full');
  assert.equal(await show(h, times[0], { infrared: 'filtered' }), true);
  assert.equal(h.material().uniforms.image, filtered, 'cache hit');
  assert.equal(h.fetches.length, 2);
  h.shell.clear();
});

test('image size follows the product maximum and halves for small texture limits', async () => {
  for (const [product, limit, size, query] of [
    ['radar', 0, [4096, 2048], null],
    ['clouds-regional', 16_384, [4096, 2048], null],
    ['radar', 2048, [2048, 1024], '2048x1024'],
    ['lightning', 0, [2048, 1024], null],
    ['clouds', 1024, [1024, 512], '1024x512'],
  ]) {
    const h = harness({
      product,
      cesium: createShellCesium({ maximumTextureSize: limit }),
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
    const pending = h.shell.setFrame(snapshot(product), times[0]);
    await flush();
    h.render();
    assert.equal(await pending, true);
    const url = new URL(h.fetches[0].url, 'https://example.test');
    assert.equal(url.pathname, '/api/weather/image');
    assert.equal(url.searchParams.get('product'), product);
    assert.equal(url.searchParams.get('size'), query);
    h.shell.clear();
  }
});

test('a host without imagery hides the shell, keeps the frame and refuses work', async () => {
  const h = harness();
  assert.equal(await show(h, times[0]), true);
  const [primitive] = h.primitives();
  h.setHost({ collection: null, kind: 'none' });
  assert.equal(h.shell.rehome(), true);
  assert.equal(primitive.show, false);
  assert.equal(h.shell.getDiagnostics().time, times[0]);
  assert.equal(h.shell.getDiagnostics().error, NO_IMAGERY_HOST);
  assert.equal(await h.shell.setFrame(snapshot(), times[1]), false);
  assert.equal(await h.shell.prefetch(snapshot(), times[1]), false);
  h.setHost({ collection: null, kind: 'tileset' });
  h.shell.rehome();
  assert.equal(primitive.show, true);
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
  h.render();
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
