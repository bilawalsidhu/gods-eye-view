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

// A fixture whose scene draws frames: postRender, a globe whose tiles load.
function stagingFixture() {
  const f = fixture();
  f.viewer.scene.postRender = new Cesium.Event();
  f.viewer.scene.globe.tilesLoaded = true;
  f.render = () => f.viewer.scene.postRender.raiseEvent();
  return f;
}

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

test('after a staged swap the drawn provider still loads new tiles', async () => {
  const f = stagingFixture();
  const layer = f.imagery.createLayer({ id: 'a', source: tiles() });
  const incoming = await swapped(f, layer);
  f.render();
  assert.deepEqual(drawnOn(f), [incoming]);
  const next = incoming.imageryProvider.requestImage(5, 3, 4);
  assert.ok(next instanceof Promise, 'a new tile after the swap is requested');
});
