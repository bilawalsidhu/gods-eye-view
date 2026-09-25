import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TILE_RENDER_REASON,
  TILE_RETRY_DELAY_MS,
  createRecentImageryRenderer,
} from './rendering.js';
import { BOX, manualTimers } from './testDoubles.mjs';

/** A provider whose tile requests stay pending until the test settles them. */
class UrlTemplateImageryProvider {
  constructor(options) {
    this.options = options;
    this.calls = [];
    this.pending = [];
  }
  requestImage(x, y, level) {
    this.calls.push([x, y, level]);
    return new Promise((resolve) => this.pending.push(resolve));
  }
}

function fakeCesium(requestImage) {
  class Provider extends UrlTemplateImageryProvider {}
  if (requestImage) Provider.prototype.requestImage = requestImage;
  return {
    UrlTemplateImageryProvider: Provider,
    WebMercatorTilingScheme: class {},
    Rectangle: {
      fromDegrees: (west, south, east, north) => ({ west, south, east, north }),
    },
    SplitDirection: { LEFT: -1, NONE: 0, RIGHT: 1 },
  };
}

function fakeCollection() {
  const layers = [];
  return {
    layers,
    addImageryProvider(provider) {
      const layer = { provider, alpha: 1, splitDirection: 0 };
      layers.push(layer);
      return layer;
    },
    remove(layer, destroy) {
      layers.splice(layers.indexOf(layer), 1);
      layer.destroyed = destroy;
    },
  };
}

const S30 = { key: 'S30:2026-09-18', product: 'S30', day: '2026-09-18' };
const L30 = { key: 'L30:2026-09-16', product: 'L30', day: '2026-09-16' };
const VIIRS = { key: 'VIIRS:2026-09-20', product: 'VIIRS', day: '2026-09-20' };

function fixture({ requestImage, maxTileRequests } = {}) {
  const renders = [];
  const timers = manualTimers();
  const renderer = createRecentImageryRenderer({
    cesium: fakeCesium(requestImage),
    maxTileRequests,
    requestRender: (reason) => renders.push(reason),
    setTimeoutImpl: timers.setTimeoutImpl,
    clearTimeoutImpl: timers.clearTimeoutImpl,
  });
  const globe = fakeCollection();
  renderer.rebind({ collection: globe, kind: 'globe' });
  const tileFrames = () =>
    renders.filter((reason) => reason === TILE_RENDER_REASON).length;
  return { renderer, globe, renders, timers, tileFrames };
}

test('a slot drapes one GIBS provider bounded to the box; the same day only restyles it', () => {
  const { renderer, globe, renders } = fixture();
  assert.equal(renderer.showSlot('a', S30, BOX, { alpha: 0.8 }), true);
  const [layer] = globe.layers;
  assert.match(
    layer.provider.options.url,
    /^https:\/\/gibs-\{s\}\.earthdata\.nasa\.gov\/.*HLS_S30.*\/2026-09-18\/GoogleMapsCompatible_Level12\/\{z\}\/\{y\}\/\{x\}\.png$/,
  );
  assert.deepEqual(layer.provider.options.subdomains, ['a', 'b', 'c']);
  assert.equal(layer.provider.options.credit, 'NASA GIBS');
  assert.deepEqual(layer.provider.options.rectangle, BOX);
  assert.equal(layer.alpha, 0.8);
  assert.deepEqual(renders, ['recent-imagery-show']);
  assert.deepEqual(renderer.getOwned().a, {
    key: 'S30:2026-09-18',
    kind: 'globe',
    alpha: 0.8,
    split: 'none',
  });
  renderer.showSlot('a', S30, BOX, { alpha: 0.5, splitDirection: 'left' });
  assert.deepEqual(globe.layers, [layer], 'the layer is reused');
  assert.equal(layer.splitDirection, -1);
  // A different day replaces the layer in its own collection.
  renderer.showSlot('a', L30, BOX);
  assert.equal(layer.destroyed, true);
  assert.equal(globe.layers.length, 1);
  // VIIRS is a level-9 JPEG overview with no alpha channel.
  renderer.showSlot('b', VIIRS, BOX, { splitDirection: 'right' });
  assert.equal(globe.layers[1].provider.options.maximumLevel, 9);
  assert.equal(globe.layers[1].provider.options.hasAlphaChannel, false);
  assert.equal(globe.layers[1].splitDirection, 1);
  renderer.setAlpha('b', 7);
  assert.equal(globe.layers[1].alpha, 1, 'alpha clamps to 0–1');
});

test('rapid replacement never owns more than two layers', () => {
  const { renderer, globe } = fixture();
  const days = [S30, L30, VIIRS];
  for (let i = 0; i < 10; i += 1) {
    renderer.showSlot('a', days[i % 3], BOX);
    renderer.showSlot('b', days[(i + 1) % 3], BOX);
    if (i % 4 === 0) renderer.hideSlot('a');
    assert.ok(globe.layers.length <= 2 && renderer.ownedCount() <= 2);
  }
  renderer.hideSlot('a');
  renderer.hideSlot('b');
  assert.equal(globe.layers.length, 0);
});

test('rebind rebuilds the owned layers on the new host and leaves the old one empty', () => {
  const { renderer, globe } = fixture();
  renderer.showSlot('a', S30, BOX, { alpha: 0.6, splitDirection: 'left' });
  renderer.showSlot('b', L30, BOX, { splitDirection: 'right' });
  const tileset = fakeCollection();
  renderer.rebind({ collection: tileset, kind: 'tileset' });
  assert.equal(globe.layers.length, 0);
  assert.deepEqual(
    tileset.layers.map((layer) => [layer.alpha, layer.splitDirection]),
    [
      [0.6, -1],
      [1, 1],
    ],
  );
  assert.equal(renderer.getOwned().a.kind, 'tileset');
  renderer.rebind({ collection: null, kind: 'none' });
  assert.equal(tileset.layers.length, 0);
  assert.equal(renderer.showSlot('a', S30, BOX), false);
  renderer.rebind({ collection: globe, kind: 'globe' });
  renderer.showSlot('a', S30, BOX);
  renderer.destroy();
  assert.equal(globe.layers.length, 0);
  assert.equal(renderer.showSlot('a', S30, BOX), false, 'destroyed');
});

test('above the tile limit a request defers silently; its settlement asks for exactly one frame', async () => {
  const { renderer, globe, timers, tileFrames } = fixture({
    maxTileRequests: 1,
  });
  renderer.showSlot('a', S30, BOX);
  const { provider } = globe.layers[0];
  const first = provider.requestImage(0, 0, 1);
  assert.ok(first instanceof Promise);
  for (let i = 1; i <= 120; i += 1)
    assert.equal(provider.requestImage(i, 0, 1), undefined);
  assert.equal(provider.calls.length, 1, 'deferred requests never go out');
  assert.equal(tileFrames(), 0, 'a deferral asks for no frame');
  assert.equal(timers.armed(), 0);
  provider.pending[0]('tile');
  await first;
  assert.equal(tileFrames(), 1, 'the settlement asks for the retry frame');
  assert.ok(provider.requestImage(200, 0, 1) instanceof Promise);
});

test('upstream deferrals from both slots share one delayed retry frame; destroy disarms it', () => {
  let throwNext = false;
  const { renderer, globe, timers, tileFrames } = fixture({
    maxTileRequests: 1,
    requestImage() {
      if (throwNext) throw new Error('boom');
      return undefined;
    },
  });
  renderer.showSlot('a', S30, BOX);
  renderer.showSlot('b', L30, BOX);
  for (const { provider } of globe.layers)
    for (let i = 0; i < 40; i += 1)
      assert.equal(provider.requestImage(i, 0, 0), undefined);
  // Every deferral released its slot (the limit is one), and none asked
  // for a frame of its own: one timer holds the single retry.
  assert.equal(tileFrames(), 0);
  assert.equal(timers.armed(), 1);
  assert.equal([...timers.pending.values()][0].ms, TILE_RETRY_DELAY_MS);
  timers.flush();
  assert.equal(tileFrames(), 1);
  // A throwing provider releases its slot too.
  throwNext = true;
  assert.throws(() => globe.layers[0].provider.requestImage(0, 0, 0), /boom/);
  throwNext = false;
  globe.layers[0].provider.requestImage(0, 0, 0);
  assert.equal(timers.armed(), 1, 'the next deferral arms a fresh timer');
  renderer.destroy();
  assert.equal(timers.armed(), 0, 'destroy disarms the retry');
  assert.equal(tileFrames(), 1);
});

test('against the basemap slot a splits left with no second layer, and leaving the swipe only restyles it', () => {
  const { renderer, globe, renders } = fixture();
  renderer.showSlot('a', S30, BOX, { splitDirection: 'left' });
  renderer.hideSlot('b');
  assert.equal(globe.layers.length, 1, 'the basemap is the right side');
  assert.equal(globe.layers[0].splitDirection, -1);
  assert.equal(renderer.getOwned().b, null);
  const [layer] = globe.layers;
  renderer.showSlot('a', S30, BOX, { splitDirection: 'none' });
  assert.deepEqual(globe.layers, [layer], 'no rebuild for a new look');
  assert.equal(layer.splitDirection, 0);
  assert.deepEqual(renders, ['recent-imagery-show', 'recent-imagery-look']);
});
