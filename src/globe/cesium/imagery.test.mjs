import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { TILE_RETRY_DELAY_MS, createCesiumImagery } from './imagery.js';
import { createFakeEngine } from '../testing/fakeEngine.js';
import {
  OSM_OVERLAYS,
  createOsmOverlayLayers,
} from '../../data/osmOverlays.js';

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

// `base`: the globe has base imagery under the engine's layers, as the map
// gives it.
function fixture({ requestImage, base = true } = {}) {
  const preRender = new Cesium.Event();
  const preUpdate = new Cesium.Event();
  const viewer = {
    imageryLayers: new Cesium.ImageryLayerCollection(),
    scene: { globe: { show: true }, preRender, preUpdate, splitPosition: 0.5 },
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
  const baseLayer = base
    ? new Cesium.ImageryLayer(new PendingProvider({}))
    : null;
  if (baseLayer) globe.add(baseLayer);
  // A frame: preUpdate, then (Cesium picks the base layer) preRender.
  const frame = () => {
    preUpdate.raiseEvent();
    preRender.raiseEvent();
  };
  return {
    base: baseLayer,
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
/** The layers on the globe over the fixture's base imagery. */
const drawnOn = (f) => layersOf(f.globe).filter((layer) => layer !== f.base);

test('map overlays preserve transparent tile sources on the globe and tileset', (t) => {
  const f = fixture();
  t.after(f.destroy);
  const layers = createOsmOverlayLayers();
  for (const layer of layers) {
    // The fake engine with this adapter's imagery.
    const engine = Object.assign(createFakeEngine({ kind: 'cesium' }), {
      imagery: f.imagery,
    });
    layer.init(null, { engine });
    layer.enable();
  }
  for (const active of [false, true, false]) {
    f.viewer.scene.globe.show = !active;
    f.tileset.show = active;
    f.frame();
    const drawn = active ? layersOf(f.tileset.imageryLayers) : drawnOn(f);
    assert.equal(drawn.length, 2);
    assert.equal(
      active ? drawnOn(f).length : f.tileset.imageryLayers.length,
      0,
    );
    for (const [i, overlay] of OSM_OVERLAYS.entries()) {
      const { options } = drawn[i].imageryProvider;
      assert.equal(options.url, overlay.urlTemplate);
      assert.equal(options.maximumLevel, overlay.maximumLevel);
      assert.equal(options.credit, overlay.credit);
      assert.equal(options.hasAlphaChannel, true);
      assert.equal(drawn[i].alpha, 1);
      assert.equal(drawn[i].show, true);
      assert.equal(layers[i].diagnostics().host, active ? 'tileset' : 'globe');
    }
  }
  for (const layer of layers) layer.destroy();
  assert.deepEqual(drawnOn(f), []);
  assert.equal(f.tileset.imageryLayers.length, 0);
});

test('a tiles layer is one Web Mercator template provider bounded to its rectangle', () => {
  const f = fixture();
  const layer = f.imagery.createLayer({
    id: 'a',
    source: tiles({ credit: 'NASA GIBS', opaque: true, maxLevel: 9 }),
    alpha: 0.8,
    split: 'left',
  });
  const [drawn] = drawnOn(f);
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
  assert.deepEqual(drawnOn(f), [drawn], 'a restyle keeps the layer');
  assert.deepEqual(
    [drawn.alpha, drawn.show, drawn.splitDirection],
    [0.25, false, Cesium.SplitDirection.RIGHT],
  );
  // A new source replaces the layer at its place, keeping the look.
  f.imagery.createLayer({ id: 'over', source: tiles(), order: 1 });
  layer.setSource(tiles({ url: 'https://other.example/{z}/{x}/{y}.png' }));
  const [replaced, over] = drawnOn(f);
  assert.equal(drawn.isDestroyed(), true);
  assert.equal(
    replaced.imageryProvider.options.url,
    'https://other.example/{z}/{x}/{y}.png',
  );
  assert.equal(over.imageryProvider.options.url, tiles().url);
  assert.deepEqual([replaced.alpha, replaced.show], [0.25, false]);
  f.destroy();
  assert.equal(drawnOn(f).length, 0);
});

test('an image layer is one geographic tile of the image itself over its rectangle', async () => {
  const f = fixture();
  const image = pixels(8, 4);
  f.imagery.createLayer({ id: 'heat', source: { kind: 'image', image } });
  const provider = drawnOn(f)[0].imageryProvider;
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
  const f = fixture({ base: false });
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
  const layers = drawnOn(f);
  assert.equal(layers[0], base);
  assert.equal(layers.length, 5);
  // Each engine layer's provider was made in creation order.
  const created = ['high', 'low', 'mid', 'mid-later'];
  const drawnOrder = layers
    .slice(1)
    .map((layer) => created[f.providers.indexOf(layer.imageryProvider)]);
  assert.deepEqual(drawnOrder, ['low', 'mid', 'mid-later', 'high']);
});

test('a layer covering less than the globe never becomes the stretched base layer', async () => {
  const f = fixture({ base: false });
  // Cesium marks the first layer shown as the base layer each frame and
  // stretches its edge texels over the globe.
  const baseLayer = () => {
    f.globe._update();
    return layersOf(f.globe).find((layer) => layer.isBaseLayer());
  };
  const world = f.imagery.createLayer({
    id: 'world',
    source: { kind: 'image', image: pixels() },
  });
  assert.equal(f.globe.length, 1, 'a layer over the globe needs no floor');
  assert.equal(baseLayer(), f.globe.get(0));
  world.destroy();

  const layer = f.imagery.createLayer({
    id: 'overlay',
    source: { kind: 'image', image: pixels(), rectangle: BOX },
  });
  const [floor, drawn] = layersOf(f.globe);
  assert.equal(f.globe.length, 2);
  assert.equal(baseLayer(), floor, 'a floor lies under the bounded layer');
  assert.deepEqual([floor.show, floor.alpha], [true, 0], 'it draws nothing');
  const provider = floor.imageryProvider;
  assert.ok(
    Cesium.Rectangle.equalsEpsilon(
      provider.rectangle,
      Cesium.Rectangle.fromDegrees(-180, -90, 180, 90),
      1e-12,
    ),
  );
  assert.deepEqual([provider.tileWidth, provider.tileHeight], [1, 1]);
  assert.deepEqual(
    [...(await provider.requestImage(0, 0, 0)).arrayBufferView],
    [0, 0, 0, 0],
  );

  // Base imagery under it (the map's) is the base layer: no floor.
  const map = new Cesium.ImageryLayer(new PendingProvider({}));
  f.globe.add(map, 0);
  f.frame();
  assert.deepEqual(layersOf(f.globe), [map, drawn]);
  assert.equal(floor.isDestroyed(), true);
  // Hidden, the floor is back before Cesium picks the base layer.
  map.show = false;
  f.viewer.scene.preUpdate.raiseEvent();
  assert.equal(baseLayer(), f.globe.get(0));
  assert.notEqual(baseLayer(), drawn);
  assert.equal(f.globe.length, 3);
  map.show = true;
  f.frame();
  assert.deepEqual(layersOf(f.globe), [map, drawn]);
  f.globe.remove(map);

  // Web Mercator tiles stop at ±85.05°: they get a floor too.
  layer.destroy();
  assert.equal(f.globe.length, 0, 'the floor goes with the last layer');
  const mercator = f.imagery.createLayer({
    id: 'tiles',
    source: tiles({ rectangle: undefined }),
  });
  assert.equal(f.globe.length, 2);
  assert.equal(baseLayer().alpha, 0);
  // A hidden layer is not the base layer: no floor.
  mercator.show(false);
  assert.equal(f.globe.length, 1);
  mercator.show(true);
  assert.equal(f.globe.length, 2);
  // On 3D tiles the globe keeps no floor.
  f.viewer.scene.globe.show = false;
  f.tileset.show = true;
  f.frame();
  assert.equal(f.globe.length, 0);
  assert.equal(f.tileset.imageryLayers.length, 1);
  f.destroy();
  assert.equal(f.viewer.scene.preUpdate.numberOfListeners, 0, 'unwatched');
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
  assert.equal(drawnOn(f).length, 0, 'the globe stack is left empty');
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
  assert.equal(drawnOn(f).length, 1);
  assert.equal(layer.ready(), true);
  layer.destroy();
  assert.equal(drawnOn(f).length, 0);
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
  const provider = drawnOn(f)[0].imageryProvider;
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
  const provider = drawnOn(f)[0].imageryProvider;
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
  // The map's base imagery.
  viewer.imageryLayers.add(new Cesium.ImageryLayer(new PendingProvider({})));
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
  assert.equal(viewer.imageryLayers.length, 1);
  assert.equal(layer.ready(), false);
  layer.setSource({ kind: 'image', url: 'after.webp', rectangle: BOX });
  loads[0].resolve({ width: 2, height: 2, name: 'before' });
  await Promise.resolve();
  assert.equal(viewer.imageryLayers.length, 1, 'a superseded load is dropped');
  loads[1].resolve({ width: 2, height: 2, name: 'after' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(viewer.imageryLayers.length, 2);
  const image = await viewer.imageryLayers
    .get(1)
    .imageryProvider.requestImage(0, 0, 0);
  assert.equal(image.name, 'after');
  assert.equal(layer.ready(), true);
});

test('geographic tiles take Cesium’s 2×1 tiling; a transform draws each tile', async () => {
  const f = fixture();
  const drawn = [];
  f.imagery.createLayer({
    id: 'radar',
    source: tiles({
      scheme: 'geographic',
      transform: (image) => {
        drawn.push(image);
        return { masked: image };
      },
    }),
  });
  const provider = drawnOn(f)[0].imageryProvider;
  assert.ok(
    provider.options.tilingScheme instanceof Cesium.GeographicTilingScheme,
  );
  assert.equal(provider.options.tilingScheme.getNumberOfXTilesAtLevel(0), 2);
  const request = provider.requestImage(1, 0, 0);
  f.providers[0].pending[0]({ name: 'tile' });
  assert.deepEqual(await request, { masked: { name: 'tile' } });
  assert.deepEqual(drawn, [{ name: 'tile' }]);
});

// A fixture whose scene draws frames: postRender, a globe whose tiles load.
function stagingFixture() {
  const f = fixture();
  f.viewer.scene.postRender = new Cesium.Event();
  f.viewer.scene.globe.tilesLoaded = true;
  f.render = () => f.viewer.scene.postRender.raiseEvent();
  return f;
}

test('a staged source loads at alpha 0 over the drawn one and takes its place once its tiles are in', async () => {
  const f = stagingFixture();
  const layer = f.imagery.createLayer({ id: 'a', source: tiles(), alpha: 0.7 });
  const drawn = drawnOn(f)[0];
  const staged = layer.setSource(
    tiles({ url: 'https://next.example/{z}/{x}/{y}.png' }),
    { staged: true },
  );
  let swapped;
  staged.then((value) => (swapped = value));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(drawnOn(f).length, 2);
  const incoming = drawnOn(f)[1];
  assert.equal(incoming.alpha, 0, 'the staged layer loads unseen');
  assert.equal(drawn.alpha, 0.7, 'the drawn layer stays');
  const request = incoming.imageryProvider.requestImage(0, 0, 1);
  f.render();
  f.render();
  assert.equal(swapped, undefined, 'a request in flight holds it back');
  f.providers[1].pending[0]('tile');
  await request;
  f.render();
  f.render();
  await Promise.resolve();
  assert.equal(swapped, true);
  assert.equal(incoming.alpha, 0.7);
  assert.match(layer.source().url, /next/);
  assert.equal(drawnOn(f).length, 2, 'the drawn one goes after the next frame');
  f.render();
  assert.deepEqual(drawnOn(f), [incoming]);
  assert.equal(drawn.isDestroyed(), true);
});

test('a staged source whose tile fails leaves the drawn one', async () => {
  const f = stagingFixture();
  const layer = f.imagery.createLayer({ id: 'a', source: tiles() });
  const staged = layer.setSource(
    tiles({ url: 'https://next.example/{z}/{x}/{y}.png' }),
    { staged: true },
  );
  await new Promise((resolve) => setImmediate(resolve));
  const incoming = drawnOn(f)[1];
  // Throttled tiles retry; a missing one fails the source.
  const throttled = { x: 0, y: 0, level: 1, error: { statusCode: 429 } };
  incoming.imageryProvider.errorEvent.raiseEvent(throttled);
  assert.equal(throttled.retry, true);
  incoming.imageryProvider.errorEvent.raiseEvent({
    x: 1,
    y: 0,
    level: 1,
    error: { statusCode: 404 },
  });
  f.render();
  assert.equal(await staged, false);
  assert.equal(drawnOn(f).length, 1);
  assert.match(layer.source().url, /gibs/);
});

test('a raised layer is a shell over its rectangle; a staged image swaps once it has drawn', async () => {
  const shells = [];
  const preRender = new Cesium.Event();
  const viewer = {
    imageryLayers: new Cesium.ImageryLayerCollection(),
    scene: { globe: { show: true }, preRender },
  };
  const { imagery } = createCesiumImagery(viewer, {
    requestRender() {},
    createCanvas: (width, height) => ({
      width,
      height,
      getContext: () => ({
        createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
        putImageData() {},
      }),
    }),
    factories: {
      shell(options) {
        const shell = {
          options,
          rectangle: options.rectangle,
          image: null,
          alpha: 1,
          shown: true,
          painted: false,
          destroyed: false,
          setImage(image) {
            shell.image = image;
            shell.painted = false;
          },
          setAlpha: (alpha) => (shell.alpha = alpha),
          setShow: (show) => (shell.shown = show),
          setDetail() {},
          detail: () => null,
          drawn: () => shell.painted,
          paint() {
            shell.painted = true;
            options.onSettled();
          },
          destroy: () => (shell.destroyed = true),
        };
        shells.push(shell);
        return shell;
      },
    },
  });
  const image = pixels(8, 4);
  const layer = imagery.createLayer({
    id: 'shell',
    source: { kind: 'image', image, rectangle: BOX },
    raise: 6000,
    alpha: 0.7,
  });
  assert.equal(viewer.imageryLayers.length, 0, 'no draped layer');
  assert.equal(shells.length, 1);
  assert.deepEqual(shells[0].options.rectangle, BOX);
  assert.equal(shells[0].options.height, 6000);
  assert.equal(shells[0].alpha, 0.7);
  assert.equal(layer.ready(), false);
  shells[0].paint();
  assert.equal(layer.ready(), true);
  // The same rectangle: the shell's image, swapped once it has drawn.
  const next = pixels(8, 4);
  const staged = layer.setSource(
    { kind: 'image', image: next, rectangle: BOX },
    { staged: true },
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(shells.length, 1);
  let done;
  staged.then((value) => (done = value));
  await Promise.resolve();
  assert.equal(done, undefined);
  shells[0].paint();
  assert.equal(await staged, true);
  // Another rectangle: a new shell unseen until it has drawn.
  const wider = { ...BOX, west: -98 };
  const moved = layer.setSource(
    { kind: 'image', image: next, rectangle: wider },
    { staged: true },
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(shells.length, 2);
  assert.equal(shells[1].alpha, 0);
  assert.equal(shells[0].destroyed, false);
  shells[1].paint();
  assert.equal(await moved, true);
  assert.equal(shells[0].destroyed, true);
  assert.equal(shells[1].alpha, 0.7);
  layer.destroy();
  assert.equal(shells[1].destroyed, true);
});

async function swapped(f, layer, extra = {}) {
  const staged = layer.setSource(
    tiles({ url: 'https://next.example/{z}/{x}/{y}.png', ...extra }),
    { staged: true },
  );
  await new Promise((resolve) => setImmediate(resolve));
  const incoming = drawnOn(f)[1];
  const request = incoming.imageryProvider.requestImage(0, 0, 1);
  f.providers[1].pending[0]('tile');
  await request;
  f.render();
  f.render();
  assert.equal(await staged, true);
  return incoming;
}

test('after a staged swap a credit-only change reaches the drawn provider', async () => {
  const f = stagingFixture();
  const layer = f.imagery.createLayer({ id: 'a', source: tiles() });
  const incoming = await swapped(f, layer, { credit: 'Old' });
  layer.setSource(
    tiles({ url: 'https://next.example/{z}/{x}/{y}.png', credit: 'New' }),
  );
  assert.equal(incoming.imageryProvider.credit?.html, 'New');
});

test('after a staged swap the drawn provider still loads new tiles', async () => {
  const f = stagingFixture();
  const layer = f.imagery.createLayer({ id: 'a', source: tiles() });
  const incoming = await swapped(f, layer);
  f.render();
  assert.deepEqual(drawnOn(f), [incoming]);
  const next = incoming.imageryProvider.requestImage(5, 3, 4);
  assert.ok(next instanceof Promise, 'a new tile after the swap is requested');
});
