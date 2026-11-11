import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Cesium3DTileset } from 'cesium';
import { Core, initSync } from '@navaramap/engine';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { Group, Raycaster, Vector3 } from 'three';
import { DepthCopyPass } from 'postprocessing';
import * as geo from '../src/geo/index.js';
import { buildTilesFixture } from './build-tiles3d-fixture.mjs';
import { localTilesetPath, qaTilesetUrl } from '../src/maps/qaTileset.js';
import { createDefaultMapSources } from '../src/maps/defaultSources.js';
import { MapSourceController } from '../src/maps/controller.js';
import { createFakeEngine } from '../src/globe/testing/fakeEngine.js';
import { createNavaraMaps } from '../src/globe/navara/maps.js';
import { createNavaraSurface } from '../src/globe/navara/surface.js';
import { GROUND_SURFACE_GLSL } from '../src/globe/navara/ground/surface.js';
import {
  assertKeylessPreview,
  TILES_FIXTURE_PATH,
  tilesFixtureRoutes,
} from './qa-strict-harness.mjs';

function globals(t, values) {
  for (const [name, value] of Object.entries(values)) {
    const old = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, {
      configurable: true,
      writable: true,
      value,
    });
    t.after(() => {
      if (old) Object.defineProperty(globalThis, name, old);
      else delete globalThis[name];
    });
  }
}

const committedFixture = (name) =>
  readFileSync(new URL(`./fixtures/tiles3d/${name}`, import.meta.url));

// The tileset's numbers come from trigonometry whose last bits differ
// between CPUs (the fixture was written on arm64, CI runs x64), so they
// match to 1e-12 of their size; the meshes are exact.
function assertClose(actual, expected, path) {
  if (typeof expected === 'number') {
    assert.equal(typeof actual, 'number', path);
    assert.ok(
      Math.abs(actual - expected) <=
        1e-12 * Math.max(1, Math.abs(actual), Math.abs(expected)),
      `${path}: ${actual} != ${expected}`,
    );
  } else if (expected && typeof expected === 'object') {
    assert.deepEqual(Object.keys(actual).sort(), Object.keys(expected).sort());
    for (const key of Object.keys(expected))
      assertClose(actual[key], expected[key], `${path}.${key}`);
  } else assert.equal(actual, expected, path);
}

test('fixture is reproducible, self-contained and under 200 KB', () => {
  const files = buildTilesFixture();
  assert.equal(files.size, 5);
  assert.ok(
    [...files.values()].reduce((sum, bytes) => sum + bytes.length, 0) < 200_000,
  );
  for (const [name, bytes] of files)
    if (name.endsWith('.json'))
      assertClose(JSON.parse(committedFixture(name)), JSON.parse(bytes), name);
    else assert.deepEqual(committedFixture(name), bytes);
  const tileset = JSON.parse(files.get('tileset.json'));
  for (const child of tileset.root.children)
    assert.ok(files.has(child.content.uri));
  assert.equal(tileset.extras.points.length, 40);
});

test('independent glTF loader and triangle rays recover the authored heights', async () => {
  const files = buildTilesFixture();
  const probes = [
    ['plate', 0, -170, 0],
    ['block50', -160, 0, 50],
    ['block200', 0, 170, 200],
    ['roof', 180, 0, 84],
    ['roof', 140, 30, 84],
    ['roof', 160, 0, 100],
  ];
  for (const [name, east, north, height] of probes) {
    const bytes = files.get(`${name}.glb`);
    const gltf = await new GLTFLoader().parseAsync(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      '',
    );
    gltf.scene.updateMatrixWorld(true);
    const ray = new Raycaster(
      new Vector3(east, 1000, -north),
      new Vector3(0, -1, 0),
    );
    const hits = ray.intersectObject(gltf.scene, true);
    assert.ok(hits.length, name);
    assert.ok(
      Math.abs(hits[0].point.y - height) < 1e-5,
      `${name}: ${hits[0].point.y}`,
    );
  }
});

// Exercise the installed WASM tile loader, then the same glTF transforms
// consumed by Three's renderModel/setTransform path, without WebGL or fetch.
async function loadedNavaraTiles(t, adapter) {
  initSync({
    module: readFileSync(
      new URL(
        '../node_modules/@navaramap/engine/navara_wasm_bg.wasm',
        import.meta.url,
      ),
    ),
  });
  const files = buildTilesFixture();
  const fixture = JSON.parse(files.get('tileset.json'));
  const core = new Core('tiles-fixture');
  t.after(() => core.free());
  core.resize(1280, 800, 1);
  core.setFrustum(60, 1, 1e8);
  core.start();
  core.changeCamera(
    new Float64Array([
      fixture.extras.origin.lon,
      fixture.extras.origin.lat,
      1100,
    ]),
    -90,
    0,
    0,
  );
  const view = {
    addSource: (desc) => {
      const id = core.addSource(desc);
      return { id, delete: () => core.deleteSource(id) };
    },
    addLayer: (desc) => {
      const id = core.addLayer({ ...desc, source: desc.source.id });
      return { id, delete: () => core.deleteLayer(id) };
    },
    forceUpdate() {},
  };
  if (adapter) {
    globals(t, { location: new URL('http://localhost:4303') });
    const owner = createNavaraMaps(view, {
      setInterval: () => 1,
      clearInterval() {},
    });
    await owner.maps.setPhotorealTiles({ tilesetUrl: TILES_FIXTURE_PATH });
  } else {
    const source = view.addSource({
      type: '3d-tiles',
      url: 'http://localhost:4303/tileset.json',
    });
    view.addLayer({ type: '3d-tiles', source, model: { maxSse: 16 } });
  }
  const roots = [];
  for (let frame = 0; frame < 60 && roots.length < 4; frame++) {
    core.update(frame * 16);
    const events = core.readEvents();
    if (!events) continue;
    for (const request of events.take_data_requested()) {
      const bytes = files.get(new URL(request.url).pathname.split('/').at(-1));
      assert.ok(bytes, `unexpected fixture request: ${request.url}`);
      core.setBufferU8(request.handle, request.bits, bytes.length, (buffer) =>
        buffer.set(bytes),
      );
    }
    for (const event of events.take_renderable_feature_added()) {
      const model = event.feature.model;
      if (!model) continue;
      const bytes = core.getBufferU8(model.bin).slice();
      const gltf = await new GLTFLoader().parseAsync(bytes.buffer, '');
      const root = new Group();
      const m = model.transform;
      root.position.set(m.tx, m.ty, m.tz);
      root.quaternion.set(m.qx, m.qy, m.qz, m.qw);
      root.scale.set(m.sx, m.sy, m.sz);
      root.add(gltf.scene);
      root.updateMatrixWorld(true);
      roots.push(root);
      core.markFeatureIsRendered('model', event.bits);
    }
  }
  assert.equal(roots.length, 4, 'all four real tile contents loaded');
  const { surface } = createNavaraSurface(
    { sampleTerrainHeight: () => undefined },
    { tileRoots: () => roots, isIdle: () => true, retainTileGeometry() {} },
  );
  t.after(() => {
    for (const root of roots)
      root.traverse((object) => {
        object.geometry?.dispose();
        object.material?.dispose();
      });
  });
  return { fixture, roots, surface };
}

test('Navara default tile height shifts the rendered transform by one ECEF metre', async (t) => {
  const { fixture, roots, surface } = await loadedNavaraTiles(t, false);
  for (const root of roots) {
    assert.equal(root.position.x, fixture.root.transform[12] - 1);
    assert.equal(root.position.y, fixture.root.transform[13]);
    assert.equal(root.position.z, fixture.root.transform[14]);
  }
  for (const [id, expected] of Object.entries({
    plate: 0.11864,
    block50: 50.11837,
    block200: 200.11864,
    roof: 83.32621,
  }))
    assert.ok(
      Math.abs(
        surface.sampleHeight(fixture.extras.probes[id].cartographic) - expected,
      ) < 0.001,
      id,
    );
});

test('Navara map source preserves authored rendered vertices, sampled heights and clamps', async (t) => {
  const { fixture, roots, surface } = await loadedNavaraTiles(t, true);
  for (const root of roots)
    assert.deepEqual(
      root.position.toArray(),
      fixture.root.transform.slice(12, 15),
    );
  for (const p of [
    ...Object.values(fixture.extras.probes),
    ...fixture.extras.points,
  ]) {
    const normal = geo.ellipsoid.WGS84.geodeticSurfaceNormalCartographic(
      p.cartographic,
      {},
    );
    const origin = geo.cartesian3.fromDegrees(p.lon, p.lat, p.height + 300);
    const ray = new Raycaster(
      new Vector3(origin.x, origin.y, origin.z),
      new Vector3(-normal.x, -normal.y, -normal.z),
    );
    const hit = ray.intersectObjects(roots, true)[0];
    assert.ok(hit, 'rendered mesh is under the authored probe');
    assert.ok(geo.cartesian3.distance(hit.point, p.position) < 1e-6);
    assert.ok(Math.abs(surface.sampleHeight(p.cartographic) - p.height) < 1e-6);
    assert.ok(
      geo.cartesian3.distance(surface.clampToHeight(origin), p.position) < 1e-6,
    );
  }
});

test('QA URL switch is inert by default and rejects nonlocal or malformed paths', (t) => {
  const location = new URL('http://localhost:4303/');
  globals(t, { location });
  assert.equal(qaTilesetUrl(), null);
  assert.equal(createDefaultMapSources().defaultId, 'esri-imagery');
  location.searchParams.set('qaTileset', TILES_FIXTURE_PATH);
  assert.equal(qaTilesetUrl(), TILES_FIXTURE_PATH);
  for (const value of [
    'https://example.com/tileset.json',
    'http://localhost:4303/tileset.json',
    '//example.com/x',
    '/\\example.com/x',
    'relative.json',
    '/x\n',
    '/x?key=test',
    '/x#fragment',
  ]) {
    assert.throws(() => localTilesetPath(value), /page origin/);
    for (const engineKind of ['cesium', 'navara'])
      assert.throws(
        () => createDefaultMapSources({ engineKind, tilesetUrl: value }),
        /page origin/,
      );
  }
});

test('controller passes local URL to Navara and owns the Cesium factory result', async (t) => {
  globals(t, { location: new URL('http://localhost:4303/') });
  const tileset = { url: TILES_FIXTURE_PATH, show: true, destroy: t.mock.fn() };
  const factory = t.mock.method(
    Cesium3DTileset,
    'fromUrl',
    async () => tileset,
  );
  for (const engineKind of ['navara', 'cesium']) {
    const registry = createDefaultMapSources({
      engineKind,
      tilesetUrl: TILES_FIXTURE_PATH,
    });
    const engine = createFakeEngine({ kind: engineKind });
    const controller = new MapSourceController({ registry, engine });
    await controller.setStack('photoreal');
    const source = engine.maps.current().photoreal;
    assert.equal(source.tilesetUrl, TILES_FIXTURE_PATH);
    assert.equal(source.tileset, engineKind === 'cesium' ? tileset : undefined);
    assert.equal(factory.mock.callCount(), engineKind === 'cesium' ? 1 : 0);
    controller.destroy();
    engine.destroy();
  }
  assert.equal(factory.mock.calls[0].arguments[0], TILES_FIXTURE_PATH);
  assert.equal(tileset.destroy.mock.callCount(), 1);
});

test('Navara accepts the local 3D source without a key or Google credit, and rejects remote paths', async (t) => {
  globals(t, { location: new URL('http://localhost:4303/') });
  const sources = [],
    credits = [];
  const update = t.mock.fn();
  const view = {
    addSource: (desc) => {
      sources.push(desc);
      return { delete() {} };
    },
    addLayer: () => ({ id: 'fixture', update, delete() {} }),
    forceUpdate() {},
    attribution: {
      add: (items) => credits.push(...items),
      remove() {},
      show: t.mock.fn(),
    },
  };
  const owner = createNavaraMaps(view, {
    setInterval: () => 1,
    clearInterval() {},
  });
  t.after(owner.destroy);
  await owner.maps.setPhotorealTiles({ tilesetUrl: TILES_FIXTURE_PATH });
  assert.deepEqual(sources, [
    { type: '3d-tiles', url: `http://localhost:4303${TILES_FIXTURE_PATH}` },
  ]);
  assert.equal(owner.maps.photorealActive(), true);
  assert.deepEqual(credits, []);
  assert.equal(view.attribution.show.mock.callCount(), 0);
  await assert.rejects(
    owner.maps.setPhotorealTiles({
      tilesetUrl: '//example.com/tileset.json',
      googleApiKey: 'unused',
    }),
    /page origin/,
  );
  assert.equal(sources.length, 1);
  await owner.maps.setPhotorealTiles(null);
  assert.equal(owner.maps.photorealActive(), false);
  assert.deepEqual(update.mock.calls[0].arguments[0].model, {
    maxSse: 16,
    height: 0,
    show: false,
  });
});

test('strict keyless assertion permits only the opted-in fixture and its real tileset URL', async (t) => {
  const location = new URL(
    `http://localhost:4303/?qaTileset=${encodeURIComponent(TILES_FIXTURE_PATH)}`,
  );
  const source = {
    tilesetUrl: TILES_FIXTURE_PATH,
    tileset: { resource: { url: TILES_FIXTURE_PATH } },
  };
  const app = {
    engine: {
      maps: {
        current: () => ({ photoreal: source }),
        photorealActive: () => true,
      },
    },
  };
  const window = { __godsEyeView: app };
  globals(t, { window, location });
  const page = { evaluate: async (fn, ...args) => fn(...args) };
  await assertKeylessPreview(page);
  source.tileset.resource.url = 'https://example.com/tileset.json';
  await assert.rejects(assertKeylessPreview(page), /Keyless/);
  source.tileset.resource.url = TILES_FIXTURE_PATH;
  location.search = '';
  await assert.rejects(assertKeylessPreview(page), /Keyless/);
  location.searchParams.set('qaTileset', TILES_FIXTURE_PATH);
  source.tilesetUrl = '/another/tileset.json';
  await assert.rejects(assertKeylessPreview(page), /Keyless/);
  source.tilesetUrl = TILES_FIXTURE_PATH;
  window.__GOOGLE_MAPS_API_KEY__ = 'key';
  await assert.rejects(assertKeylessPreview(page), /Keyless/);
  delete window.__GOOGLE_MAPS_API_KEY__;
  app.tileset = { url: '/another/tileset.json' };
  await assert.rejects(assertKeylessPreview(page), /Keyless/);
});

test('harness exposes exactly the five binary-safe fixture routes on the preview origin', () => {
  const routes = tilesFixtureRoutes('http://localhost:4303');
  assert.equal(routes.length, 5);
  const names = new Set();
  for (const route of routes) {
    const url = new URL(route.pattern);
    assert.equal(url.origin, 'http://localhost:4303');
    assert.ok(!route.pattern.includes('*'));
    const answer = route.respond();
    const name = url.pathname.split('/').at(-1);
    names.add(name);
    assert.deepEqual(answer.body, committedFixture(name));
    assert.equal(
      answer.contentType,
      url.pathname.endsWith('.glb') ? 'model/gltf-binary' : 'application/json',
    );
  }
  assert.deepEqual([...names].sort(), [...buildTilesFixture().keys()].sort());
});

// Load only the page callbacks, without launching the command-line scenario.
const scenario = readFileSync(
  new URL('./qa-tiles-fixture.mjs', import.meta.url),
  'utf8',
);
const diagnosticSource = scenario.slice(
  scenario.indexOf('function readNavaraDrape('),
  scenario.indexOf('async function checkPoints('),
);
const readNavaraDrape = new Function(`return (${diagnosticSource})`)();
const pixelsSource = scenario.slice(
  scenario.indexOf('async function pixels('),
  scenario.indexOf('// Runs in the page, after rendering.'),
);
const reportPixels = new Function(
  'geo',
  'report',
  'readNavaraDrape',
  'GROUND_SURFACE_GLSL',
  `return (${pixelsSource})`,
)(geo, true, readNavaraDrape, GROUND_SURFACE_GLSL);

function depthDiagnostic(t) {
  const copies = [];
  class Copy extends DepthCopyPass {
    constructor() {
      super();
      this.disposed = false;
      this.renderTarget.addEventListener('dispose', () => {
        this.disposed = true;
      });
      copies.push(this);
    }
  }
  const bytes = new Uint8Array(16);
  // Exact RGBA depths: 0.25 composed, 0.25 scene, 0.5 globe; tile classification.
  bytes.set([64, 0, 0, 0, 64, 0, 0, 0, 128, 0, 0, 0, 2, 0, 0, 255]);
  let error = 0;
  const gl = { NO_ERROR: 0, getError: () => error };
  const textures = Array.from({ length: 3 }, (_, id) => ({
    id,
    image: { width: 1280, height: 800 },
  }));
  const previous = {};
  const renderer = {
    getContext: () => gl,
    getRenderTarget: () => previous,
    render: t.mock.fn(),
    readRenderTargetPixels: (_, x, y, width, height, buffer) =>
      buffer.set(bytes),
    setRenderTarget: t.mock.fn(),
  };
  let effect = {
    uniforms: new Map(
      ['tAllDepth', 'tSurfaceDepth', 'tGlobeDepth'].map((name, i) => [
        name,
        { value: textures[i] },
      ]),
    ),
    getFragmentShader: () => GROUND_SURFACE_GLSL,
  };
  const ctx = {
    getRenderer: () => renderer,
    findEffect: (key) =>
      key === 'gevGround'
        ? { effect }
        : {
            depthBuffer: textures[0],
            globeDepthBuffer: textures[2],
            raw: { globeDepthCopyPass: { constructor: Copy } },
          },
    getRenderTarget: () => ({ depthTexture: textures[1] }),
  };
  let tiles = true;
  const position = geo.cartesian3.fromDegrees(-97.7, 30.2, 50);
  let listener;
  const engine = {
    kind: 'navara',
    extensions: {
      navara: { view: { viewContext: ctx, camera: { raw: { far: 1e8 } } } },
    },
    host: {
      canvas: { width: 2560, height: 1600 },
      size: () => ({ width: 1280, height: 800 }),
    },
    projector: { worldToWindow: () => ({ x: 120, y: 70 }) },
    camera: {
      pickRay: t.mock.fn(() => ({
        origin: { x: 1, y: 2, z: 3 },
        direction: { x: 0, y: 0, z: -1 },
      })),
      pickEllipsoid: () => position,
    },
    surface: {
      raycast: t.mock.fn(() => (tiles ? { position } : undefined)),
      sampleHeightDetailed: t.mock.fn(() => ({
        height: tiles ? 50 : 0,
        source: tiles ? 'tiles' : 'terrain',
      })),
    },
    maps: { photorealActive: () => tiles },
    frames: {
      postRender: {
        addEventListener: (fn) => {
          listener = fn;
          return () => {};
        },
      },
    },
    render: { request: () => queueMicrotask(() => listener()) },
  };
  const color = Uint8ClampedArray.from(
    { length: 100 },
    (_, i) => [231, 226, 223, 255][i % 4],
  );
  globals(t, {
    window: { __godsEyeView: { engine } },
    document: {
      createElement: () => ({
        getContext: () => ({
          clearRect() {},
          drawImage() {},
          getImageData: () => ({ data: color }),
        }),
      }),
    },
  });
  return {
    engine,
    copies,
    renderer,
    previous,
    position,
    textures,
    page: { evaluate: async (fn, ...args) => fn(...args) },
    hideGround() {
      effect = null;
    },
    removeTiles() {
      tiles = false;
      bytes.set([128, 0, 0, 0, 255, 255, 255, 255, 128, 0, 0, 0, 1, 0, 0, 255]);
    },
    fail() {
      error = 'INVALID_OPERATION';
    },
  };
}

test('drape report distinguishes depths and shown tile rays when colour is identical', async (t) => {
  const h = depthDiagnostic(t);
  const shown = await reportPixels(h.page, h.position);
  assert.deepEqual(shown.rgb, [231, 226, 223]);
  assert.equal(shown.depths.allDepth, 0.25);
  assert.equal(shown.depths.sceneDepth, 0.25);
  assert.equal(shown.depths.globeDepth, 0.5);
  assert.equal(shown.depths.buffer, 'scene');
  assert.equal(shown.depths.classification, 'tiles');
  assert.equal(shown.depths.source, 'tiles');
  assert.equal(shown.depths.shownTileAtRay, true);
  assert.equal(shown.depths.bindings, 'ground');
  assert.deepEqual(shown.depths.pixel, [120, 729]);
  assert.deepEqual(h.engine.camera.pickRay.mock.calls[0].arguments[0], {
    x: 120.25,
    y: 70.25,
  });
  assert.equal(h.engine.surface.raycast.mock.calls[0].arguments[0].far, 1e8);
  const place =
    h.engine.surface.sampleHeightDetailed.mock.calls[0].arguments[0];
  assert.ok(Math.abs(place.longitude - geo.math.toRadians(-97.7)) < 1e-10);
  assert.ok(Math.abs(place.latitude - geo.math.toRadians(30.2)) < 1e-10);
  h.hideGround();
  h.removeTiles();
  const hidden = await reportPixels(h.page, h.position);
  assert.deepEqual(hidden.rgb, shown.rgb);
  assert.equal(hidden.depths.allDepth, 0.5);
  assert.equal(hidden.depths.sceneDepth, 1);
  assert.equal(hidden.depths.globeDepth, 0.5);
  assert.equal(hidden.depths.buffer, 'globe');
  assert.equal(hidden.depths.classification, 'terrain');
  assert.equal(hidden.depths.source, 'terrain');
  assert.equal(hidden.depths.shownTileAtRay, false);
  assert.equal(hidden.depths.photorealActive, false);
  assert.equal(hidden.depths.bindings, 'mrt');
  assert.equal(h.copies.length, 4);
  assert.ok(h.copies.every((copy) => copy.disposed));
  assert.equal(
    h.copies[0].fullscreenMaterial.uniforms.tGlobeDepth.value,
    h.textures[2],
  );
  assert.equal(
    h.renderer.setRenderTarget.mock.calls.at(-1).arguments[0],
    h.previous,
  );
});

test('drape report rejects a failed GPU read and releases temporary resources', async (t) => {
  const h = depthDiagnostic(t);
  h.fail();
  await assert.rejects(
    reportPixels(h.page, h.position),
    /WebGL error: INVALID_OPERATION/,
  );
  assert.equal(h.copies.length, 1);
  assert.ok(h.copies[0].disposed);
  assert.equal(
    h.renderer.setRenderTarget.mock.calls.at(-1).arguments[0],
    h.previous,
  );
});

test('drape report never reads native Navara state on Cesium', async (t) => {
  const h = depthDiagnostic(t);
  h.engine.kind = 'cesium';
  Object.defineProperty(h.engine, 'extensions', {
    get() {
      throw new Error('Native read');
    },
  });
  const sample = await reportPixels(h.page, h.position);
  assert.deepEqual(sample.rgb, [231, 226, 223]);
  assert.equal(sample.depths, undefined);
  assert.equal(h.copies.length, 0);
});
