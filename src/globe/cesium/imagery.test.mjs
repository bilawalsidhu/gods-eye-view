import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { TILE_RETRY_DELAY_MS, createCesiumImagery } from './imagery.js';

const BOX = { west: -97.8, south: 30.2, east: -97.7, north: 30.3 };
const tiles = (extra = {}) => ({
  kind: 'tiles',
  url: 'https://gibs-{s}.example/{z}/{y}/{x}.png',
  maxLevel: 12,
  rectangle: BOX,
  ...extra,
});
const pixels = (width = 4, height = 2) => ({
  width,
  height,
  data: new Uint8ClampedArray(width * height * 4),
});

/** A tile provider whose requests stay pending until the test settles them. */
class PendingProvider {
  constructor(options) {
    this.options = options;
    this.calls = [];
    this.pending = [];
    // What a Cesium ImageryLayer reads of its provider.
    this.tilingScheme =
      options.tilingScheme ?? new Cesium.WebMercatorTilingScheme();
    this.rectangle = options.rectangle ?? this.tilingScheme.rectangle;
    this.tileWidth = this.tileHeight = 256;
    this.minimumLevel = 0;
    this.maximumLevel = options.maximumLevel ?? 18;
    this.errorEvent = new Cesium.Event();
  }
  requestImage(x, y, level) {
    this.calls.push([x, y, level]);
    return new Promise((resolve) => this.pending.push(resolve));
  }
}

function manualTimers() {
  const pending = new Map();
  let next = 1;
  return {
    pending,
    setTimeout(run, ms) {
      const id = next++;
      pending.set(id, { run, ms });
      return id;
    },
    clearTimeout: (id) => pending.delete(id),
    flush() {
      const entries = [...pending.values()];
      pending.clear();
      for (const entry of entries) entry.run();
    },
  };
}

function fixture({ requestImage } = {}) {
  const preRender = new Cesium.Event();
  const viewer = {
    imageryLayers: new Cesium.ImageryLayerCollection(),
    scene: { globe: { show: true }, preRender, splitPosition: 0.5 },
  };
  const renders = [];
  const timers = manualTimers();
  const tileset = {
    show: false,
    imageryLayers: new Cesium.ImageryLayerCollection(),
    isDestroyed: () => false,
  };
  const providers = [];
  const { imagery, destroy } = createCesiumImagery(viewer, {
    requestRender: (reason) => renders.push(reason),
    tilesets: () => [tileset],
    createCanvas: (width, height) => ({
      width,
      height,
      getContext: () => ({
        createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
        putImageData() {},
      }),
    }),
    factories: {
      tiles(options) {
        const provider = new PendingProvider(options);
        if (requestImage) provider.requestImage = requestImage;
        providers.push(provider);
        return provider;
      },
    },
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  });
  const globe = viewer.imageryLayers;
  const frame = () => preRender.raiseEvent();
  return {
    viewer,
    imagery,
    destroy,
    globe,
    tileset,
    providers,
    renders,
    timers,
    frame,
    tileFrames: () => renders.filter((r) => r === 'imagery-tiles').length,
  };
}

const layersOf = (collection) =>
  Array.from({ length: collection.length }, (_, i) => collection.get(i));

test('a tiles layer is one Web Mercator template provider bounded to its rectangle', () => {
  const f = fixture();
  const layer = f.imagery.createLayer({
    id: 'a',
    source: tiles({ credit: 'NASA GIBS', opaque: true, maxLevel: 9 }),
    alpha: 0.8,
    split: 'left',
  });
  const [drawn] = layersOf(f.globe);
  const { options } = drawn.imageryProvider;
  assert.equal(options.url, 'https://gibs-{s}.example/{z}/{y}/{x}.png');
  assert.deepEqual(options.subdomains, ['a', 'b', 'c']);
  assert.equal(options.maximumLevel, 9);
  assert.equal(options.hasAlphaChannel, false, 'opaque tiles have no alpha');
  assert.equal(options.credit, 'NASA GIBS');
  assert.ok(options.tilingScheme instanceof Cesium.WebMercatorTilingScheme);
  assert.ok(
    Cesium.Rectangle.equalsEpsilon(
      options.rectangle,
      Cesium.Rectangle.fromDegrees(-97.8, 30.2, -97.7, 30.3),
      1e-12,
    ),
  );
  assert.equal(drawn.alpha, 0.8);
  assert.equal(drawn.splitDirection, Cesium.SplitDirection.LEFT);
  assert.equal(layer.ready(), true);
  layer.setAlpha(0.25);
  layer.show(false);
  layer.setSplit('right');
  assert.deepEqual(layersOf(f.globe), [drawn], 'a restyle keeps the layer');
  assert.deepEqual(
    [drawn.alpha, drawn.show, drawn.splitDirection],
    [0.25, false, Cesium.SplitDirection.RIGHT],
  );
  // A new source replaces the layer at its place, keeping the look.
  f.imagery.createLayer({ id: 'over', source: tiles(), order: 1 });
  layer.setSource(tiles({ url: 'https://other.example/{z}/{x}/{y}.png' }));
  const [replaced, over] = layersOf(f.globe);
  assert.equal(drawn.isDestroyed(), true);
  assert.equal(
    replaced.imageryProvider.options.url,
    'https://other.example/{z}/{x}/{y}.png',
  );
  assert.equal(over.imageryProvider.options.url, tiles().url);
  assert.deepEqual([replaced.alpha, replaced.show], [0.25, false]);
  f.destroy();
  assert.equal(f.globe.length, 0);
});

test('an image layer is one geographic tile of the image itself over its rectangle', async () => {
  const f = fixture();
  const image = pixels(8, 4);
  f.imagery.createLayer({ id: 'heat', source: { kind: 'image', image } });
  const provider = f.globe.get(0).imageryProvider;
  assert.ok(provider.tilingScheme instanceof Cesium.GeographicTilingScheme);
  assert.deepEqual(
    [
      provider.tileWidth,
      provider.tileHeight,
      provider.maximumLevel,
      provider.tilingScheme.getNumberOfXTilesAtLevel(0),
      provider.tilingScheme.getNumberOfYTilesAtLevel(0),
    ],
    [8, 4, 0, 1, 1],
  );
  assert.ok(
    Cesium.Rectangle.equalsEpsilon(
      provider.rectangle,
      Cesium.Rectangle.fromDegrees(-180, -90, 180, 90),
      1e-12,
    ),
  );
  const drawn = await provider.requestImage(0, 0, 0);
  assert.equal(drawn.width, 8, 'RGBA bytes go on a canvas');
  assert.equal(typeof drawn.getContext, 'function');
});

test('layers sit over the base imagery in their order, then creation; others stay put', () => {
  const f = fixture();
  const base = new Cesium.ImageryLayer(new PendingProvider({}));
  f.globe.add(base);
  f.imagery.createLayer({ id: 'high', source: tiles(), order: 5 });
  f.imagery.createLayer({ id: 'low', source: tiles(), order: -1 });
  f.imagery.createLayer({ id: 'mid', source: tiles() });
  f.imagery.createLayer({ id: 'mid-later', source: tiles() });
  assert.deepEqual(
    f.imagery.list().map(({ id }) => id),
    ['low', 'mid', 'mid-later', 'high'],
  );
  const layers = layersOf(f.globe);
  assert.equal(layers[0], base);
  assert.equal(layers.length, 5);
  // Each engine layer's provider was made in creation order.
  const created = ['high', 'low', 'mid', 'mid-later'];
  const drawnOrder = layers
    .slice(1)
    .map((layer) => created[f.providers.indexOf(layer.imageryProvider)]);
  assert.deepEqual(drawnOrder, ['low', 'mid', 'mid-later', 'high']);
});

test('the layers follow the surface: the globe, a shown tileset, none, and back', () => {
  const f = fixture();
  const layer = f.imagery.createLayer({
    id: 'a',
    source: tiles(),
    alpha: 0.6,
    split: 'left',
  });
  assert.equal(f.imagery.surface(), 'globe');
  f.viewer.scene.globe.show = false;
  f.tileset.show = true;
  assert.equal(f.imagery.surface(), 'tiles');
  f.frame();
  assert.equal(f.globe.length, 0, 'the globe stack is left empty');
  const [onTiles] = layersOf(f.tileset.imageryLayers);
  assert.deepEqual(
    [onTiles.alpha, onTiles.splitDirection],
    [0.6, Cesium.SplitDirection.LEFT],
  );
  f.tileset.show = false;
  assert.equal(f.imagery.surface(), 'none');
  f.frame();
  assert.equal(f.tileset.imageryLayers.length, 0);
  assert.equal(layer.ready(), false, 'no surface: nothing drawn');
  f.viewer.scene.globe.show = true;
  f.frame();
  assert.equal(f.globe.length, 1);
  assert.equal(layer.ready(), true);
  layer.destroy();
  assert.equal(f.globe.length, 0);
  assert.equal(f.viewer.scene.preRender.numberOfListeners, 0, 'unwatched');
});

test('the split position is the scene’s, set by the engine or the shell', () => {
  const f = fixture();
  assert.equal(f.imagery.splitPosition(), 0.5);
  f.imagery.setSplitPosition(0.3);
  assert.equal(f.viewer.scene.splitPosition, 0.3);
  // The shell's swipe writes the scene too: the engine reads it.
  f.viewer.scene.splitPosition = 0.7;
  assert.equal(f.imagery.splitPosition(), 0.7);
  f.imagery.setSplitPosition(0.3);
  assert.equal(f.viewer.scene.splitPosition, 0.3);
});

test('above maxRequests a tile request defers silently; its settlement asks for one frame', async () => {
  const f = fixture();
  f.imagery.createLayer({ id: 'a', source: tiles({ maxRequests: 1 }) });
  const provider = f.globe.get(0).imageryProvider;
  const first = provider.requestImage(0, 0, 1);
  assert.ok(first instanceof Promise);
  for (let i = 1; i <= 120; i += 1)
    assert.equal(provider.requestImage(i, 0, 1), undefined);
  assert.equal(
    f.providers[0].calls.length,
    1,
    'deferred requests never go out',
  );
  assert.equal(f.tileFrames(), 0, 'a deferral asks for no frame');
  assert.equal(f.timers.pending.size, 0);
  f.providers[0].pending[0]('tile');
  await first;
  assert.equal(f.tileFrames(), 1, 'the settlement asks for the retry frame');
  assert.ok(provider.requestImage(200, 0, 1) instanceof Promise);
});

test('provider deferrals share one delayed retry frame per layer; destroy disarms it', () => {
  let throwNext = false;
  const f = fixture({
    requestImage() {
      if (throwNext) throw new Error('boom');
      return undefined;
    },
  });
  const layer = f.imagery.createLayer({
    id: 'a',
    source: tiles({ maxRequests: 1 }),
  });
  const provider = f.globe.get(0).imageryProvider;
  for (let i = 0; i < 40; i += 1)
    assert.equal(provider.requestImage(i, 0, 0), undefined);
  assert.equal(f.timers.pending.size, 1);
  assert.equal([...f.timers.pending.values()][0].ms, TILE_RETRY_DELAY_MS);
  f.timers.flush();
  assert.equal(
    f.renders.filter((reason) => reason === 'imagery-retry').length,
    1,
  );
  // A throwing provider releases its slot too.
  throwNext = true;
  assert.throws(() => provider.requestImage(0, 0, 0), /boom/);
  throwNext = false;
  provider.requestImage(0, 0, 0);
  assert.equal(f.timers.pending.size, 1, 'the next deferral arms a timer');
  layer.destroy();
  assert.equal(f.timers.pending.size, 0, 'destroy disarms the retry');
});

test('an image URL draws once it has loaded; a newer source wins', async () => {
  const loads = [];
  const preRender = new Cesium.Event();
  const viewer = {
    imageryLayers: new Cesium.ImageryLayerCollection(),
    scene: { globe: { show: true }, preRender },
  };
  const { imagery } = createCesiumImagery(viewer, {
    requestRender() {},
    factories: {
      loadImage: (url) =>
        new Promise((resolve) => loads.push({ url, resolve })),
    },
  });
  const layer = imagery.createLayer({
    id: 'event',
    source: { kind: 'image', url: 'before.webp', rectangle: BOX },
  });
  assert.equal(viewer.imageryLayers.length, 0);
  assert.equal(layer.ready(), false);
  layer.setSource({ kind: 'image', url: 'after.webp', rectangle: BOX });
  loads[0].resolve({ width: 2, height: 2, name: 'before' });
  await Promise.resolve();
  assert.equal(viewer.imageryLayers.length, 0, 'a superseded load is dropped');
  loads[1].resolve({ width: 2, height: 2, name: 'after' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(viewer.imageryLayers.length, 1);
  const image = await viewer.imageryLayers
    .get(0)
    .imageryProvider.requestImage(0, 0, 0);
  assert.equal(image.name, 'after');
  assert.equal(layer.ready(), true);
});
