import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';
import { createCesiumGlobe, markBaseTileset } from './globe.js';
import { hookProvider, xyzTileUrl } from './imagery.js';

const ALL = new Set(['imageHooks', 'imageryOnTiles', 'splitSwipe', 'terrain']);
const url = (name) => `https://${name}.invalid/{z}/{x}/{y}.png`;

function fakeScene() {
  const primitives = [];
  return {
    imageryLayers: new Cesium.ImageryLayerCollection(),
    globe: {
      show: true,
      tilesLoaded: true,
      showGroundAtmosphere: true,
      enableLighting: false,
    },
    primitives: {
      get length() {
        return primitives.length;
      },
      get: (i) => primitives[i],
      add: (p) => (primitives.push(p), p),
      remove(p) {
        const i = primitives.indexOf(p);
        if (i < 0) return false;
        primitives.splice(i, 1);
        p.destroy();
        return true;
      },
    },
    preUpdate: new Cesium.Event(),
    fog: { enabled: true },
    sun: { show: true },
    moon: { show: false },
    skyAtmosphere: {
      show: true,
      brightnessShift: -0.08,
      saturationShift: -0.12,
    },
    skyBox: { show: true, milkyWayVisibility: 1 },
    splitPosition: 0,
    verticalExaggeration: 1,
  };
}

/** A 3D tileset as the port sees one: shown, with its imagery collection. */
function fakeTileset() {
  const tileset = Object.create(Cesium.Cesium3DTileset.prototype);
  let destroyed = false;
  Object.defineProperties(tileset, {
    show: { value: true, writable: true },
    tilesLoaded: { value: true, writable: true },
    imageryLayers: { value: new Cesium.ImageryLayerCollection() },
  });
  tileset.isDestroyed = () => destroyed;
  tileset.destroy = () => {
    destroyed = true;
    tileset.imageryLayers.destroy();
  };
  return tileset;
}

function setup(capabilities = ALL) {
  const scene = fakeScene();
  const renders = [];
  const { port, dispose } = createCesiumGlobe(
    { scene },
    { capabilities, requestRender: (reason) => renders.push(reason) },
  );
  const tick = () => scene.preUpdate.raiseEvent(scene);
  return { scene, port, dispose, renders, tick };
}

const providerUrl = (layer) => layer.imageryProvider.url;

test('port layers keep their order above layers others added', () => {
  const { scene, port } = setup();
  const base = scene.imageryLayers.addImageryProvider(
    new Cesium.UrlTemplateImageryProvider({ url: url('base') }),
  );
  const a = port.imagery.add({ kind: 'xyz', url: url('a') });
  const b = port.imagery.add({ kind: 'xyz', url: url('b') });
  const order = () =>
    Array.from({ length: scene.imageryLayers.length }, (_, i) =>
      providerUrl(scene.imageryLayers.get(i)).split('.')[0].slice(8),
    );
  assert.deepEqual(order(), ['base', 'a', 'b']);
  a.raise();
  assert.deepEqual(order(), ['base', 'b', 'a']);
  assert.deepEqual(port.imagery.list(), [b, a]);
  a.lower();
  assert.deepEqual(order(), ['base', 'a', 'b']);
  const under = port.imagery.add({ kind: 'xyz', url: url('c') }, 0);
  assert.deepEqual(order(), ['base', 'c', 'a', 'b']);
  under.remove();
  a.remove();
  assert.deepEqual(order(), ['base', 'b']);
  assert.ok(!base.isDestroyed(), 'the other layer is left alone');
});

test('zOrder places a layer above lower and equal ones', () => {
  const { port } = setup();
  const top = port.imagery.add({ kind: 'xyz', url: url('a'), zOrder: 5 });
  const low = port.imagery.add({ kind: 'xyz', url: url('b'), zOrder: 1 });
  const mid = port.imagery.add({ kind: 'xyz', url: url('c'), zOrder: 1 });
  assert.deepEqual(port.imagery.list(), [low, mid, top]);
});

test('the look writes through to the Cesium layer', () => {
  const { scene, port } = setup();
  const layer = port.imagery.add({ kind: 'xyz', url: url('a') });
  const cesium = scene.imageryLayers.get(0);
  layer.alpha = 0.25;
  layer.show = false;
  layer.split = 'left';
  assert.equal(cesium.alpha, 0.25);
  assert.equal(cesium.show, false);
  assert.equal(cesium.splitDirection, Cesium.SplitDirection.LEFT);
  assert.throws(() => (layer.split = 'up'), TypeError);
  assert.throws(() => (layer.drapeOn = 'sky'), TypeError);
  assert.equal(layer.lit, true);
  layer.lit = false;
  assert.equal(layer.lit, false);
});

test('imagery drapes on the drawn base tileset while the globe is hidden', () => {
  const { scene, port, tick } = setup();
  const tileset = fakeTileset();
  markBaseTileset(tileset);
  scene.primitives.add(tileset);
  const all = port.imagery.add({ kind: 'xyz', url: url('all') });
  const surface = port.imagery.add({ kind: 'xyz', url: url('surface') });
  surface.drapeOn = 'surface';
  const objects = port.imagery.add({ kind: 'xyz', url: url('objects') });
  objects.drapeOn = 'objects';
  assert.equal(scene.imageryLayers.length, 2, 'all and surface on the globe');
  assert.equal(tileset.imageryLayers.length, 1, 'objects on the tiles');

  // The map stack hides the globe itself; the next tick follows it.
  scene.globe.show = false;
  tick();
  assert.equal(scene.imageryLayers.length, 1, 'surface stays');
  assert.equal(tileset.imageryLayers.length, 2);
  assert.ok(
    tileset.imageryLayers.indexOf(tileset.imageryLayers.get(0)) === 0 &&
      providerUrl(tileset.imageryLayers.get(0)).includes('all'),
    'port order holds on the tiles',
  );

  tileset.show = false;
  tick();
  assert.equal(tileset.imageryLayers.length, 0, 'nothing on hidden tiles');

  // A tileset destroyed with a layer on it: the layer is built again.
  tileset.show = true;
  tick();
  scene.primitives.remove(tileset);
  scene.globe.show = true;
  tick();
  assert.equal(scene.imageryLayers.length, 2);
  all.remove();
  surface.remove();
  objects.remove();
  assert.equal(scene.imageryLayers.length, 0);
});

test('an unmarked tileset is not a base, and without imageryOnTiles nothing drapes on tiles', () => {
  const { scene, port, tick } = setup();
  const tileset = fakeTileset();
  scene.primitives.add(tileset);
  scene.globe.show = false;
  port.imagery.add({ kind: 'xyz', url: url('a') });
  tick();
  assert.equal(tileset.imageryLayers.length, 0);

  const other = setup(new Set(['imageHooks']));
  const marked = fakeTileset();
  markBaseTileset(marked);
  other.scene.primitives.add(marked);
  other.scene.globe.show = false;
  const layer = other.port.imagery.add({ kind: 'xyz', url: url('a') });
  layer.drapeOn = 'objects';
  assert.equal(marked.imageryLayers.length, 0);
  assert.equal(other.scene.imageryLayers.length, 0);
});

test('without imageHooks a spec with main-thread hooks throws', () => {
  const { port } = setup(new Set());
  assert.throws(
    () => port.imagery.add({ kind: 'canvas', drawTile() {} }),
    /imageHooks/,
  );
  assert.throws(
    () =>
      port.imagery.add({ kind: 'xyz', url: url('a'), admit: (t, i) => i() }),
    /imageHooks/,
  );
  assert.ok(!('getSplit' in port.imagery), 'no split without splitSwipe');
});

test('the split position is a clamped fraction of the canvas', () => {
  const { scene, port } = setup();
  port.imagery.setSplit(0.3);
  assert.equal(scene.splitPosition, 0.3);
  assert.equal(port.imagery.getSplit(), 0.3);
  port.imagery.setSplit(2);
  assert.equal(port.imagery.getSplit(), 1);
});

test('tile errors are told with the tile and status', () => {
  const { scene, port } = setup();
  const layer = port.imagery.add({ kind: 'xyz', url: url('a') });
  const errors = [];
  layer.on('tileError', (error) => errors.push(error));
  const provider = scene.imageryLayers.get(0).imageryProvider;
  provider.errorEvent.raiseEvent({
    x: 1,
    y: 2,
    level: 3,
    error: { statusCode: 404 },
  });
  assert.deepEqual(errors, [{ tile: { x: 1, y: 2, level: 3 }, status: 404 }]);
  layer.remove();
  provider.errorEvent.raiseEvent({ x: 0, y: 0, level: 0 });
  assert.equal(errors.length, 1, 'a removed layer says nothing');
});

test('admit decides first; at most maxConcurrentRequests are in flight', async () => {
  const resolvers = [];
  const provider = {
    tilingScheme: new Cesium.WebMercatorTilingScheme(),
    requestImage: () => new Promise((resolve) => resolvers.push(resolve)),
  };
  const counts = { started: 0, settled: 0, retries: 0 };
  const ctx = {
    started: () => (counts.started += 1),
    settled: () => (counts.settled += 1),
    retrySoon: () => (counts.retries += 1),
    laterFrame: () => Promise.resolve(),
    signals: new Set(),
  };
  const admitted = [];
  const hooked = hookProvider(
    provider,
    {
      kind: 'xyz',
      url: url('a'),
      maxConcurrentRequests: 1,
      admit(tile, issue) {
        admitted.push(tile);
        return tile.x === 9 ? undefined : issue();
      },
    },
    ctx,
  );
  const first = hooked.requestImage(0, 0, 1);
  assert.ok(first, 'the first is issued');
  assert.equal(hooked.requestImage(1, 0, 1), undefined, 'the second waits');
  assert.equal(counts.retries, 0, 'a full budget asks for no frame itself');
  assert.equal(hooked.requestImage(9, 0, 1), undefined, 'admit deferred');
  assert.equal(counts.retries, 1, 'admit deferring asks for a later frame');
  assert.deepEqual(admitted[0], { x: 0, y: 0, level: 1 });
  resolvers[0]('image');
  assert.equal(await first, 'image');
  assert.deepEqual(counts, { started: 1, settled: 1, retries: 1 });
  assert.ok(hooked.requestImage(1, 0, 1), 'the budget is free again');
});

test('fetchTile fetches in place of the provider, with the URL it would fetch', async (t) => {
  const asked = [];
  const answers = [{ defer: true }, { missing: true }];
  const provider = {
    tilingScheme: new Cesium.WebMercatorTilingScheme(),
    requestImage: () => assert.fail('the provider fetches nothing'),
  };
  const ctx = {
    started() {},
    settled() {},
    retrySoon() {},
    laterFrame: () => Promise.resolve(),
    signals: new Set(),
  };
  const hooked = hookProvider(
    provider,
    {
      kind: 'xyz',
      url: 'https://{s}.tiles.invalid/{z}/{x}/{reverseY}.png',
      subdomains: ['p', 'q'],
      async fetchTile(request) {
        asked.push(request.url);
        return answers.shift();
      },
    },
    ctx,
  );
  await assert.rejects(hooked.requestImage(1, 0, 1), { name: 'MissingTile' });
  assert.deepEqual(asked, [
    'https://p.tiles.invalid/1/1/1.png',
    'https://p.tiles.invalid/1/1/1.png',
  ]);
  assert.equal(ctx.signals.size, 0);
  const { port } = setup();
  assert.throws(
    () =>
      port.imagery.add({
        kind: 'arcgis',
        url: 'https://arcgis.invalid',
        fetchTile: async () => ({ missing: true }),
      }),
    /xyz/,
    'refused at once, before any provider is built',
  );
  t.diagnostic(
    xyzTileUrl({ url: '{z}/{x}/{y}' }, provider.tilingScheme, {
      x: 1,
      y: 2,
      level: 3,
    }),
  );
});

test('the sky reads the scene and writes through, keeping the rest', () => {
  const { scene, port } = setup();
  const before = port.sky.get();
  assert.deepEqual(
    { ...before, atmosphereTuning: undefined },
    {
      atmosphere: true,
      atmosphereTuning: undefined,
      stars: true,
      milkyWay: 1,
      sun: true,
      moon: false,
      fog: true,
      lighting: false,
    },
  );
  port.sky.set({
    fog: false,
    milkyWay: 0.25,
    atmosphereTuning: { hueShift: 0.1 },
  });
  assert.equal(scene.fog.enabled, false);
  assert.equal(scene.skyBox.milkyWayVisibility, 0.25);
  assert.equal(scene.skyAtmosphere.hueShift, 0.1);
  assert.equal(scene.skyAtmosphere.brightnessShift, -0.08, 'tuning kept');
  // Written outside the port, as the IR mode still does: read as drawn.
  scene.fog.enabled = true;
  assert.equal(port.sky.get().fog, true);
  assert.equal(port.sky.get().stars, true);
});

test('a sky part the scene lacks keeps what was set', () => {
  const scene = fakeScene();
  delete scene.skyBox;
  const { port } = createCesiumGlobe(
    { scene },
    { capabilities: ALL, requestRender() {} },
  );
  assert.equal(port.sky.get().stars, false);
  port.sky.set({ stars: true, milkyWay: 0.5 });
  assert.equal(port.sky.get().stars, true);
  assert.equal(port.sky.get().milkyWay, 0.5);
});

test('terrain: the ellipsoid with exaggeration; the last call wins', async () => {
  const { scene, port } = setup();
  await port.setTerrain({ kind: 'ellipsoid', exaggeration: 2 });
  assert.ok(scene.terrainProvider instanceof Cesium.EllipsoidTerrainProvider);
  assert.equal(scene.verticalExaggeration, 2);
  await port.setTerrain(null);
  assert.equal(scene.verticalExaggeration, 1);
  await assert.rejects(
    port.setTerrain({
      kind: 'heightmap',
      url: '',
      encoding: 'mapbox',
      geoid: 'egm96',
    }),
    /Geoid/,
  );
  const flat = setup(new Set());
  await assert.rejects(
    flat.port.setTerrain({ kind: 'quantizedMesh', url: 'x' }),
    /no terrain/,
  );
});

test('setBase replaces the imagery and says what it drew', async () => {
  const { scene, port } = setup();
  const overlay = port.imagery.add({ kind: 'xyz', url: url('overlay') });
  const status = await port.setBase({
    photoreal: null,
    terrain: { kind: 'ellipsoid' },
    imagery: [
      { kind: 'xyz', url: url('one') },
      { kind: 'xyz', url: url('two') },
    ],
  });
  assert.deepEqual(status.photoreal, { route: 'none' });
  assert.equal(status.imagery.length, 2);
  assert.deepEqual(port.imagery.list(), status.imagery);
  assert.ok(!port.imagery.list().includes(overlay));
  assert.equal(scene.imageryLayers.length, 2);
  assert.equal(status.settled, true);
  await assert.rejects(port.setBase({ vector: { styleUrl: 'x' } }), /vector/);
});

test('globe visibility, settling and progress', () => {
  const { scene, port, tick } = setup();
  port.setGlobeVisible(false);
  assert.equal(scene.globe.show, false);
  assert.equal(port.isSettled('terrain'), true, 'a hidden globe loads nothing');
  port.setGlobeVisible(true);
  scene.globe.tilesLoaded = false;
  assert.equal(port.isSettled('terrain'), false);
  assert.equal(port.isSettled('base'), false);
  const tileset = fakeTileset();
  markBaseTileset(tileset);
  scene.primitives.add(tileset);
  tileset.tilesLoaded = false;
  const seen = [];
  port.on('progress', (p) => seen.push(p));
  tick();
  assert.deepEqual(seen, [
    { tilesPending: 1, imageryPending: 0, terrainPending: 0 },
  ]);
  tick();
  assert.equal(seen.length, 1, 'only changes are told');
  assert.equal(port.isSettled('tiles'), false);
});

test('a disposed port stops following the scene', () => {
  const { scene, port, dispose, tick } = setup();
  const tileset = fakeTileset();
  markBaseTileset(tileset);
  scene.primitives.add(tileset);
  port.imagery.add({ kind: 'xyz', url: url('a') });
  dispose();
  scene.globe.show = false;
  tick();
  assert.equal(tileset.imageryLayers.length, 0);
  assert.throws(() => port.imagery.add({ kind: 'xyz', url: url('b') }));
});

test('a layer with no zOrder counts as 0', () => {
  const { port } = setup();
  const top = port.imagery.add({ kind: 'xyz', url: url('a'), zOrder: 5 });
  const plain = port.imagery.add({ kind: 'xyz', url: url('b') });
  assert.deepEqual(port.imagery.list(), [plain, top]);
});

test('a deferred fetch frees its budget slot while it waits', async () => {
  let release;
  const waiting = new Promise((resolve) => (release = resolve));
  const asked = [];
  const ctx = {
    started() {},
    settled() {},
    retrySoon() {},
    laterFrame: () => waiting,
    signals: new Set(),
  };
  const hooked = hookProvider(
    { tilingScheme: new Cesium.WebMercatorTilingScheme() },
    {
      kind: 'xyz',
      url: url('a'),
      maxConcurrentRequests: 1,
      async fetchTile({ tile, signal }) {
        asked.push(tile.x);
        signal.throwIfAborted();
        return tile.x === 0 && asked.length === 1
          ? { defer: true }
          : { missing: true };
      },
    },
    ctx,
  );
  const first = hooked.requestImage(0, 0, 1);
  await new Promise((resolve) => setImmediate(resolve));
  const second = hooked.requestImage(1, 0, 1);
  assert.ok(second, 'issued while the first waits');
  await assert.rejects(second, { name: 'MissingTile' });
  for (const controller of ctx.signals) controller.abort();
  release();
  await assert.rejects(first, { name: 'AbortError' });
});

test('a hook that throws fails its tile, never the frame', async () => {
  const ctx = {
    started() {},
    settled() {},
    retrySoon() {},
    laterFrame: () => Promise.resolve(),
    signals: new Set(),
  };
  const hooked = hookProvider(
    {
      tilingScheme: new Cesium.WebMercatorTilingScheme(),
      requestImage() {
        throw new Error('provider');
      },
    },
    {
      kind: 'xyz',
      url: url('a'),
      admit(tile, issue) {
        if (tile.x === 1) throw new Error('admit');
        return issue();
      },
    },
    ctx,
  );
  await assert.rejects(hooked.requestImage(1, 0, 1), /admit/);
  await assert.rejects(hooked.requestImage(0, 0, 1), /provider/);
});

test('a scene with no globe drapes on its base tileset', () => {
  const scene = fakeScene();
  delete scene.globe;
  const { port } = createCesiumGlobe(
    { scene },
    { capabilities: ALL, requestRender() {} },
  );
  const tileset = fakeTileset();
  markBaseTileset(tileset);
  scene.primitives.add(tileset);
  port.imagery.add({ kind: 'xyz', url: url('a') });
  assert.equal(tileset.imageryLayers.length, 1);
});
