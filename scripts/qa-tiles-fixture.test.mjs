import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Cesium3DTileset } from 'cesium';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { Raycaster, Vector3 } from 'three';
import { buildTilesFixture } from './build-tiles3d-fixture.mjs';
import { localTilesetPath, qaTilesetUrl } from '../src/maps/qaTileset.js';
import { createDefaultMapSources } from '../src/maps/defaultSources.js';
import { MapSourceController } from '../src/maps/controller.js';
import { createFakeEngine } from '../src/globe/testing/fakeEngine.js';
import { createNavaraMaps } from '../src/globe/navara/maps.js';
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

test('fixture is reproducible, self-contained and under 200 KB', () => {
  const files = buildTilesFixture();
  assert.equal(files.size, 5);
  assert.ok(
    [...files.values()].reduce((sum, bytes) => sum + bytes.length, 0) < 200_000,
  );
  for (const [name, bytes] of files)
    assert.deepEqual(
      readFileSync(new URL(`./fixtures/tiles3d/${name}`, import.meta.url)),
      bytes,
    );
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
  const view = {
    addSource: (desc) => {
      sources.push(desc);
      return { delete() {} };
    },
    addLayer: () => ({ id: 'fixture', delete() {} }),
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
  const files = buildTilesFixture();
  for (const route of routes) {
    const url = new URL(route.pattern);
    assert.equal(url.origin, 'http://localhost:4303');
    assert.ok(!route.pattern.includes('*'));
    const answer = route.respond();
    assert.deepEqual(answer.body, files.get(url.pathname.split('/').at(-1)));
    assert.equal(
      answer.contentType,
      url.pathname.endsWith('.glb') ? 'model/gltf-binary' : 'application/json',
    );
  }
});
