import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import {
  createShellSurface,
  createWeatherShell,
  detailWindow,
  orderWeatherShells,
  shellLift,
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
// The detail window uniform; NONE is the empty window.
const NONE = { x: 0, y: 0, z: -1, w: -1 };
const windowOf = (primitive) => {
  const { x, y, z, w } = primitive.appearance.material.uniforms.window;
  return { x, y, z, w };
};

function harness({ product = 'radar', camera, ...options } = {}) {
  const cesium = options.cesium ?? createShellCesium();
  const scene = createShellScene();
  const fetches = [];
  const decoded = [];
  let host = { collection: null, kind: 'tileset' };
  const shell = createWeatherShell({
    viewer: { scene, camera },
    cesium,
    product,
    getHost: () => host,
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
    'xweather-radar': 6_200,
    'xweather-lightning': 6_600,
  });
  assert.equal(WEATHER_SHELL_CACHE_BYTES, 128 * 1024 * 1024);
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
    detail: Cesium.Material.DefaultImageId,
    alpha: 1,
    window: { type: 'vec4', x: 0, y: 0, z: -1, w: -1 },
  });
  const { source } = template.fabric;
  assert.match(
    source,
    /material\.alpha = c\.a \* alpha \* step\(1\.5, float\(imageDimensions\.x\)\);/,
    'nothing draws before the full-extent image',
  );
  assert.match(
    source,
    /float useDetail = inside \* step\(1\.5, float\(detailDimensions\.x\)\);/,
    'the detail image is sampled only once it has arrived',
  );
  assert.match(
    source,
    /all\(greaterThanEqual\(st, window\.xy\)\) && all\(lessThanEqual\(st, window\.zw\)\)/,
  );
  assert.match(
    source,
    /mix\(coarse, texture\(detail, clamp\(dst, 0\.0, 1\.0\)\), useDetail\)/,
  );
  assert.match(source, /material\.diffuse = czm_gammaCorrect\(c\.rgb\);/);
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
  const lower = createShellSurface({
    viewer: { scene },
    cesium,
    rectangle,
    height: 5_000,
  });
  assert.equal(cesium.templates.size, 1, 'the template registers once');
  assert.deepEqual(
    scene.primitives.items.map(
      (item) => item.options.geometryInstances.geometry.options.height,
    ),
    [5_000, 6_200],
  );
  lower.destroy();
  surface.destroy();
});

test('a surface applies a new detail window only once its image has drawn; the same window swaps only the image', () => {
  const cesium = createShellCesium();
  const scene = createShellScene();
  const surface = createShellSurface({
    viewer: { scene },
    cesium,
    rectangle: Cesium.Rectangle.fromDegrees(-130, 20, -60, 55),
    height: 6_200,
  });
  const [primitive] = scene.primitives.items;
  const { uniforms } = primitive.appearance.material;
  const render = (count) => renderShells(cesium, scene, count);
  const image = () => ({ width: 4096, height: 2048 });
  surface.setImage(image());
  render();
  assert.deepEqual(surface.getDiagnostics().detail, {
    uploaded: false,
    window: null,
  });
  const a = { west: 0.25, south: 0.5, east: 0.5, north: 0.75 };
  const first = image();
  surface.setDetail(first, a);
  assert.equal(uniforms.detail, first);
  assert.deepEqual(windowOf(primitive), NONE, 'the full-extent image covers');
  assert.equal(scene.postRender.size, 1, 'renders until the detail has drawn');
  render(2);
  assert.deepEqual(windowOf(primitive), NONE);
  render(1);
  assert.deepEqual(windowOf(primitive), { x: 0.25, y: 0.5, z: 0.5, w: 0.75 });
  assert.ok(uniforms.window instanceof Cesium.Cartesian4);
  assert.deepEqual(surface.getDiagnostics().detail, {
    uploaded: true,
    window: a,
  });
  assert.equal(scene.postRender.size, 0);

  // A time change in the same window: Cesium keeps drawing the previous
  // texture until the new one is uploaded, so the window stays.
  const applied = uniforms.window;
  const second = image();
  surface.setDetail(second, { ...a });
  assert.equal(uniforms.detail, second);
  assert.equal(uniforms.window, applied, 'only the image is written');
  assert.equal(surface.getDiagnostics().detail.uploaded, false);
  render();
  assert.equal(surface.getDiagnostics().detail.uploaded, true);
  assert.equal(uniforms.window, applied);
  const renders = scene.renders;
  surface.setDetail(second, { ...a });
  assert.equal(scene.renders, renders, 'an unchanged detail costs nothing');
  assert.equal(scene.postRender.size, 0);

  // A different window empties at once and applies once its image has drawn.
  const b = { west: 0.5, south: 0.25, east: 0.75, north: 0.5 };
  surface.setDetail(image(), b);
  assert.deepEqual(windowOf(primitive), NONE);
  render(2);
  assert.deepEqual(windowOf(primitive), NONE);
  render(1);
  assert.deepEqual(windowOf(primitive), { x: 0.5, y: 0.25, z: 0.75, w: 0.5 });

  surface.setDetail(null);
  assert.equal(uniforms.detail, Cesium.Material.DefaultImageId);
  assert.deepEqual(windowOf(primitive), NONE);
  assert.deepEqual(surface.getDiagnostics().detail, {
    uploaded: false,
    window: null,
  });
  render();
  assert.deepEqual(
    { ...uniforms.detailDimensions },
    { type: 'ivec3', x: 1, y: 1 },
  );
  // Counted renders alone are not enough: the bound texture must be this image.
  surface.setDetail(image(), a);
  for (let i = 0; i < 4; i++) scene.postRender.emit();
  assert.deepEqual(windowOf(primitive), NONE, 'still the 1×1 default');
  render(1);
  assert.deepEqual(windowOf(primitive), { x: 0.25, y: 0.5, z: 0.5, w: 0.75 });
  surface.destroy();
  surface.setDetail(image(), b);
  assert.deepEqual(windowOf(primitive), { x: 0.25, y: 0.5, z: 0.5, w: 0.75 });
  assert.equal(scene.postRender.size, 0);
});

test('shells rise with the camera over coarse 3D tiles, in steps, up to 60 km', () => {
  assert.equal(shellLift(undefined), 0);
  assert.equal(shellLift(1_200), 0, 'city views keep the shell heights');
  assert.equal(shellLift(3_000_000), 12_000);
  assert.equal(shellLift(8_000_000), 32_000);
  assert.equal(shellLift(18_500_000), 60_000);
  const camera = { positionCartographic: { height: 1_200 } };
  const scene = {
    primitives: new Cesium.PrimitiveCollection(),
    preRender: new Cesium.Event(),
    postRender: new Cesium.Event(),
    camera,
    requestRender() {},
  };
  const surface = createShellSurface({
    viewer: { scene },
    cesium: Cesium,
    rectangle: Cesium.Rectangle.fromDegrees(-130, 20, -60, 55),
    height: 5_800,
  });
  const primitive = scene.primitives.get(0);
  const identity = primitive.modelMatrix;
  scene.preRender.raiseEvent();
  assert.equal(primitive.modelMatrix, identity, 'no lift, no new matrix');
  camera.positionCartographic.height = 8_000_000;
  scene.preRender.raiseEvent();
  const radius = Cesium.Ellipsoid.WGS84.maximumRadius;
  assert.ok(
    Math.abs(primitive.modelMatrix[0] * radius - (radius + 32_000)) < 1e-3,
  );
  const lifted = primitive.modelMatrix;
  camera.positionCartographic.height = 8_010_000;
  scene.preRender.raiseEvent();
  assert.equal(primitive.modelMatrix, lifted, 'the same step keeps the matrix');
  surface.destroy();
  assert.equal(scene.preRender.numberOfListeners, 0);
});

test('real Cesium builds the two-texture material, the opaque-pass appearance and the rectangle primitive', () => {
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
    [material.uniforms.imageDimensions.x, material.uniforms.detailDimensions.x],
    [1, 1],
    'Cesium tracks both bound texture sizes',
  );
  const shader = material.shaderSource;
  for (const declaration of [
    /uniform sampler2D image_\d+;/,
    /uniform sampler2D detail_\d+;/,
    /uniform float alpha_\d+;/,
    /uniform vec4 window_\d+;/,
    /uniform ivec3 imageDimensions_\d+;/,
    /uniform ivec3 detailDimensions_\d+;/,
  ])
    assert.match(shader, declaration);
  assert.match(shader, /texture\(image_\d+, st\)/);
  assert.match(shader, /texture\(detail_\d+, clamp\(dst, 0\.0, 1\.0\)\)/);
  assert.match(shader, /lessThanEqual\(st, window_\d+\.zw\)/);
  assert.match(shader, /step\(1\.5, float\(detailDimensions_\d+\.x\)\)/);
  assert.match(
    shader,
    /material\.alpha = c\.a \* alpha_\d+ \* step\(1\.5, float\(imageDimensions_\d+\.x\)\);/,
    'the uniform is renamed, the material field is not',
  );
  assert.match(shader, /float useDetail = inside \* step/, 'locals keep names');
  const detail = { width: 4096, height: 2048 };
  surface.setDetail(detail, { west: 0.1, south: 0.2, east: 0.3, north: 0.4 });
  assert.equal(material.uniforms.detail, detail);
  assert.deepEqual(
    [material.uniforms.window.z, material.uniforms.window.w],
    [-1, -1],
    'no window before the image has drawn',
  );
  surface.setDetail(null);
  assert.equal(material.uniforms.detail, Cesium.Material.DefaultImageId);
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
    detail: {
      bbox: null,
      size: { width: 4096, height: 2048 },
      ready: false,
      enabled: false,
    },
  });
  assert.equal(h.fetches.length, 1, 'no camera, no detail window');
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
    clouds.render();
    assert.equal(await pending, true);
  }
  assert.deepEqual(clouds.shell.getDiagnostics().cache, {
    mosaics: 6,
    bytes: 6 * 8 * 1024 * 1024,
    prefetching: false,
  });
  const pending = clouds.shell.setFrame(sample, all[6]);
  await flush();
  clouds.render();
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
    ['lightning', 0, [4096, 2048], null],
    ['lightning', 4096, [4096, 2048], null],
    ['clouds', 0, [2048, 1024], null],
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

const footprint = (west, south, east, north) => ({ west, south, east, north });
const box = (west, south, east, north) => ({ west, south, east, north });

test('hidden frames do not count towards a pending detail window', () => {
  const cesium = createShellCesium();
  const scene = createShellScene();
  const surface = createShellSurface({
    viewer: { scene },
    cesium,
    rectangle: Cesium.Rectangle.fromDegrees(-130, 20, -60, 55),
    height: 6_200,
  });
  const [primitive] = scene.primitives.items;
  const render = (count) => renderShells(cesium, scene, count);
  const image = () => ({ width: 4096, height: 2048 });
  surface.setImage(image());
  const a = { west: 0.25, south: 0.5, east: 0.5, north: 0.75 };
  surface.setDetail(image(), a);
  render();
  assert.deepEqual(windowOf(primitive), { x: 0.25, y: 0.5, z: 0.5, w: 0.75 });
  // A different window with a same-sized image: the dimensions alone cannot
  // tell the textures apart, so only shown frames may count.
  const b = { west: 0.5, south: 0.25, east: 0.75, north: 0.5 };
  surface.setDetail(image(), b);
  assert.deepEqual(windowOf(primitive), NONE);
  for (let i = 0; i < 3; i++) {
    surface.setShow(false);
    scene.postRender.emit();
    surface.setShow(true);
  }
  assert.deepEqual(windowOf(primitive), NONE, 'hidden frames counted nothing');
  render(2);
  assert.deepEqual(windowOf(primitive), NONE);
  render(1);
  assert.deepEqual(windowOf(primitive), { x: 0.5, y: 0.25, z: 0.75, w: 0.5 });
});

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

function camera(west, south, east, north) {
  const listeners = new Set();
  let rectangle = Cesium.Rectangle.fromDegrees(west, south, east, north);
  return {
    moveEnd: {
      addEventListener(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      get size() {
        return listeners.size;
      },
    },
    computeViewRectangle: () => rectangle,
    look(...edges) {
      rectangle = Cesium.Rectangle.fromDegrees(...edges);
      for (const listener of [...listeners]) listener();
    },
  };
}
// A window in degrees, in the full-extent image's texture coordinates.
const windowFor = (w) => ({
  x: (w.west - bounds.west) / (bounds.east - bounds.west),
  y: (w.south - bounds.south) / (bounds.north - bounds.south),
  z: (w.east - bounds.west) / (bounds.east - bounds.west),
  w: (w.north - bounds.south) / (bounds.north - bounds.south),
});
const query = (url) => new URL(url, 'https://example.test').searchParams;

test('a detail window follows the view after the full-extent frame, on the same surface', async () => {
  const view = camera(-100, 35, -98, 36);
  const h = harness({ camera: view });
  const pending = h.shell.setFrame(snapshot(), times[0]);
  await flush();
  assert.equal(h.fetches.length, 1, 'the full-extent image comes first');
  h.render();
  assert.equal(await pending, true);
  assert.equal(view.moveEnd.size, 1);
  await flush();
  assert.equal(h.fetches.length, 2);
  assert.equal(query(h.fetches[1].url).get('bbox'), '-102,34,-96,37');
  assert.equal(query(h.fetches[1].url).get('time'), times[0]);
  assert.equal(query(h.fetches[1].url).get('size'), null);
  const [shell] = h.primitives();
  assert.equal(h.primitives().length, 1, 'no second surface');
  const { uniforms } = shell.appearance.material;
  assert.equal(uniforms.detail.source, h.decoded[1]);
  assert.deepEqual(windowOf(shell), NONE, 'the full-extent image covers');
  assert.deepEqual(h.shell.getDiagnostics().shell.detail, {
    bbox: [-102, 34, -96, 37],
    size: { width: 4096, height: 2048 },
    ready: false,
    enabled: true,
  });
  h.render();
  assert.deepEqual(windowOf(shell), windowFor(box(-102, 34, -96, 37)));
  assert.equal(h.shell.getDiagnostics().shell.detail.ready, true);
  assert.equal(h.shell.getDiagnostics().imageryCount, 1);
  assert.equal(h.scene.postRender.size, 0);

  view.look(-99.5, 35.2, -97.5, 36.2);
  await flush();
  assert.equal(
    h.fetches.length,
    2,
    'panning inside the window fetches nothing',
  );

  view.look(-90, 40, -88, 41);
  assert.equal(
    uniforms.detail,
    Cesium.Material.DefaultImageId,
    'a moved window clears at once',
  );
  assert.deepEqual(windowOf(shell), NONE);
  assert.deepEqual(h.shell.getDiagnostics().shell.detail, {
    bbox: [-92, 39, -86, 42],
    size: { width: 4096, height: 2048 },
    ready: false,
    enabled: true,
  });
  await flush();
  assert.equal(query(h.fetches[2].url).get('bbox'), '-92,39,-86,42');
  assert.equal(uniforms.detail.source, h.decoded[2]);
  assert.deepEqual(windowOf(shell), NONE, 'until the new image has drawn');
  assert.equal(h.shell.getDiagnostics().shell.detail.ready, false);
  h.render();
  assert.deepEqual(windowOf(shell), windowFor(box(-92, 39, -86, 42)));
  assert.equal(h.shell.getDiagnostics().shell.detail.ready, true);

  view.look(-120, 25, -100, 50);
  assert.equal(
    uniforms.detail,
    Cesium.Material.DefaultImageId,
    'a wide view needs no window',
  );
  assert.deepEqual(windowOf(shell), NONE);
  assert.deepEqual(h.shell.getDiagnostics().shell.detail, {
    bbox: null,
    size: { width: 4096, height: 2048 },
    ready: false,
    enabled: false,
  });
  await flush();
  assert.equal(h.fetches.length, 3);
  assert.deepEqual(h.primitives(), [shell]);
  assert.equal(h.shell.getDiagnostics().imageryCount, 1);
  h.shell.clear();
  assert.equal(view.moveEnd.size, 0);
});

test('a new extent restages the surface and the detail follows onto it', async () => {
  const h = harness({ camera: camera(-100, 35, -98, 36) });
  assert.equal(await show(h, times[0]), true);
  await flush();
  h.render();
  const [first] = h.primitives();
  const detail = first.appearance.material.uniforms.detail;
  const wider = { ...bounds, west: -140 };
  const pending = h.shell.setFrame(
    snapshot('radar', { bounds: wider }),
    times[0],
  );
  await flush();
  const [, second] = h.primitives();
  assert.equal(
    second.appearance.material.uniforms.detail,
    Cesium.Material.DefaultImageId,
  );
  assert.equal(h.shell.getDiagnostics().imageryCount, 2, 'staged, no detail');
  h.render();
  assert.equal(await pending, true);
  assert.deepEqual(h.primitives(), [second]);
  assert.equal(first.destroyed, true);
  assert.equal(second.appearance.material.uniforms.detail, detail);
  assert.deepEqual(windowOf(second), NONE, 'a new mesh uploads it first');
  h.render();
  const x = (edge) => (edge - wider.west) / (wider.east - wider.west);
  assert.deepEqual(windowOf(second), {
    x: x(-102),
    y: windowFor(box(-102, 34, -96, 37)).y,
    z: x(-96),
    w: windowFor(box(-102, 34, -96, 37)).w,
  });
  assert.equal(h.shell.getDiagnostics().shell.detail.ready, true);
  h.shell.clear();
});

test('a new frame swaps the full-extent image first and keeps the detail until its own image decodes', async () => {
  const view = camera(-100, 35, -98, 36);
  const urls = [];
  let gate = null;
  let offline = false;
  const h = harness({
    camera: view,
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
  await flush();
  h.render();
  const [shell] = h.primitives();
  const { uniforms } = shell.appearance.material;
  const previous = { image: uniforms.image, detail: uniforms.detail };
  const applied = uniforms.window;
  gate = deferred();
  assert.equal(await h.shell.setFrame(snapshot(), times[1]), true);
  await flush();
  assert.notEqual(uniforms.image, previous.image);
  assert.equal(h.shell.getDiagnostics().time, times[1]);
  assert.equal(query(urls.at(-1)).get('time'), times[1]);
  assert.equal(query(urls.at(-1)).get('bbox'), '-102,34,-96,37');
  assert.equal(uniforms.detail, previous.detail, 'the previous detail stays');
  assert.equal(uniforms.window, applied);
  assert.equal(h.shell.getDiagnostics().shell.detail.ready, false);
  gate.resolve();
  await flush();
  assert.notEqual(uniforms.detail, previous.detail);
  assert.equal(
    uniforms.window,
    applied,
    'the same window swaps only the image',
  );
  h.render();
  assert.equal(h.shell.getDiagnostics().shell.detail.ready, true);

  gate = null;
  offline = true;
  assert.equal(await h.shell.setFrame(snapshot(), times[2]), true);
  await flush();
  assert.equal(
    uniforms.detail,
    Cesium.Material.DefaultImageId,
    'a failed detail leaves no older one over the frame',
  );
  assert.deepEqual(windowOf(shell), NONE);
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
  const rect = windowFor(box(-102, 34, -96, 37));
  const advance = async (h, time) => {
    const pending = h.shell.setFrame(playback, time);
    await flush();
    h.render();
    assert.equal(await pending, true);
    await flush();
  };

  const requests = [];
  let slow = false;
  const h = harness({
    camera: camera(-100, 35, -98, 36),
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
  h.render();
  const [shell] = h.primitives();
  const { uniforms } = shell.appearance.material;
  const first = uniforms.detail;
  assert.deepEqual(windowOf(shell), rect);
  slow = true;
  await advance(h, all[1]);
  assert.equal(uniforms.detail, first, 'over one newer frame');
  assert.deepEqual(windowOf(shell), rect);
  assert.equal(h.shell.getDiagnostics().shell.detail.ready, false);
  await advance(h, all[2]);
  assert.equal(
    uniforms.detail,
    Cesium.Material.DefaultImageId,
    'cleared at the second',
  );
  assert.deepEqual(windowOf(shell), NONE);
  for (const time of all.slice(3)) {
    await advance(h, time);
    assert.equal(uniforms.detail, Cesium.Material.DefaultImageId);
    assert.deepEqual(windowOf(shell), NONE);
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

  const warm = harness({ camera: camera(-100, 35, -98, 36) });
  await advance(warm, all[0]);
  warm.render();
  const [surface] = warm.primitives();
  const material = surface.appearance.material;
  const applied = material.uniforms.window;
  assert.deepEqual(windowOf(surface), rect);
  for (const time of all.slice(1)) {
    assert.equal(await warm.shell.prefetch(playback, time), true);
    const fetches = warm.fetches.length;
    const previous = material.uniforms.detail;
    await advance(warm, time);
    assert.equal(warm.fetches.length, fetches, 'both images from the cache');
    assert.notEqual(material.uniforms.detail, previous, time);
    assert.equal(material.uniforms.window, applied, 'the window never empties');
    assert.equal(warm.shell.getDiagnostics().shell.detail.ready, true);
  }
  warm.shell.clear();
});

test('hiding, a host without imagery and clear hide or release the detail with its surface', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const view = camera(-100, 35, -98, 36);
  const h = harness({ camera: view });
  assert.equal(await show(h, times[0]), true);
  await flush();
  h.render();
  const [shell] = h.primitives();
  const rect = windowFor(box(-102, 34, -96, 37));
  h.shell.setHidden(true);
  assert.equal(shell.show, false);
  assert.deepEqual(windowOf(shell), rect, 'the detail hides with its surface');
  assert.equal(h.shell.getDiagnostics().shell.detail.ready, false);
  h.shell.setHidden(false);
  assert.equal(shell.show, true);
  assert.deepEqual(windowOf(shell), rect);
  assert.equal(h.shell.getDiagnostics().shell.detail.ready, true);
  h.shell.setAlpha(0.4);
  assert.equal(shell.appearance.material.uniforms.alpha, 0.4);
  h.setHost({ collection: null, kind: 'none' });
  h.shell.rehome();
  assert.equal(shell.show, false);
  view.look(-90, 40, -88, 41);
  await flush();
  assert.equal(h.fetches.length, 2, 'no window work without a host');
  assert.deepEqual(windowOf(shell), NONE, 'the moved window is dropped');
  h.setHost({ collection: null, kind: 'tileset' });
  h.shell.rehome();
  await flush();
  assert.equal(query(h.fetches[2].url).get('bbox'), '-92,39,-86,42');
  h.render();
  assert.deepEqual(windowOf(shell), windowFor(box(-92, 39, -86, 42)));
  assert.deepEqual(h.primitives(), [shell]);

  // Frames shown while hidden leave no older detail to reappear.
  h.shell.setHidden(true);
  for (const time of [times[1], times[2]])
    assert.equal(await h.shell.setFrame(snapshot(), time), true);
  h.shell.setHidden(false);
  assert.equal(
    shell.appearance.material.uniforms.detail,
    Cesium.Material.DefaultImageId,
  );
  await flush();
  assert.equal(query(h.fetches.at(-1).url).get('time'), times[2]);
  h.render();
  assert.equal(h.shell.getDiagnostics().shell.detail.ready, true);

  h.shell.clear();
  assert.equal(shell.destroyed, true);
  assert.equal(shell.appearance.material.destroyed, true);
  assert.equal(view.moveEnd.size, 0);
  assert.equal(h.scene.postRender.size, 0);
  assert.deepEqual(h.shell.getDiagnostics().cache, {
    mosaics: 0,
    bytes: 0,
    prefetching: false,
  });

  // A detail image still decoding is abandoned, never installed.
  const gate = deferred();
  const requests = [];
  const late = harness({
    camera: camera(-100, 35, -98, 36),
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
  assert.equal(late.primitives().length, 0);
  assert.equal(late.shell.getDiagnostics().cache.mosaics, 0);
  t.mock.timers.tick(30_000);
  assert.equal(h.primitives().length, 0);
});

test('full-extent and detail images share one byte budget; prefetch warms both', async () => {
  const view = camera(-100, 35, -98, 36);
  const h = harness({ camera: view });
  const MiB = 1024 * 1024;
  assert.equal(await show(h, times[0]), true);
  await flush();
  h.render();
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
  await flush();
  h.render();
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
    await flush();
    h.render();
    assert.equal(h.fetches.length, 6, `${time} full-extent and detail cached`);
    assert.equal(h.shell.getDiagnostics().shell.detail.ready, true);
  }
  assert.equal(await show(h, times[0]), true);
  await flush();
  assert.equal(h.fetches.length, 8, 'nothing older survived the prefetch');
  assert.equal(h.shell.getDiagnostics().cache.bytes, 128 * MiB);
  h.shell.clear();

  const wide = harness({ camera: camera(-120, 25, -100, 50) });
  assert.equal(await show(wide, times[0]), true);
  assert.equal(await wide.shell.prefetch(snapshot(), times[1]), true);
  assert.equal(wide.fetches.length, 2, 'no window, no detail prefetch');
  assert.ok(wide.fetches.every(({ url }) => !url.includes('bbox=')));
  wide.shell.clear();
});

test('global infrared keeps one full-extent image; detail images halve for small texture limits', async () => {
  const view = camera(-100, 35, -98, 36);
  const clouds = harness({ product: 'clouds', camera: view });
  assert.equal(await show(clouds, times[0]), true);
  await flush();
  assert.equal(view.moveEnd.size, 0);
  assert.equal(clouds.fetches.length, 1);
  assert.equal(clouds.shell.getDiagnostics().shell.detail.enabled, false);
  assert.equal(await clouds.shell.prefetch(snapshot('clouds'), times[1]), true);
  assert.ok(clouds.fetches.every(({ url }) => !url.includes('bbox=')));
  clouds.shell.clear();

  const small = harness({
    camera: camera(-100, 35, -98, 36),
    cesium: createShellCesium({ maximumTextureSize: 2048 }),
    decodeImage: async () => ({ width: 2048, height: 1024, close() {} }),
  });
  assert.equal(await show(small, times[0]), true);
  await flush();
  small.render();
  assert.equal(query(small.fetches[1].url).get('size'), '2048x1024');
  assert.equal(query(small.fetches[1].url).get('bbox'), '-102,34,-96,37');
  assert.deepEqual(small.shell.getDiagnostics().shell.detail, {
    bbox: [-102, 34, -96, 37],
    size: { width: 2048, height: 1024 },
    ready: true,
    enabled: true,
  });
  small.shell.clear();
});
