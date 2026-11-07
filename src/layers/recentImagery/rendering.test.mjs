import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TILE_RENDER_REASON,
  createRecentImageryRenderer,
} from './rendering.js';
import { BOX } from './testDoubles.mjs';
import { fakeGlobePort } from '../../testSupport/fakeGlobePort.mjs';

const S30 = { key: 'S30:2026-09-18', product: 'S30', day: '2026-09-18' };
const L30 = { key: 'L30:2026-09-16', product: 'L30', day: '2026-09-16' };
const VIIRS = { key: 'VIIRS:2026-09-20', product: 'VIIRS', day: '2026-09-20' };

/** A tile fetch that stays pending until the test settles it. */
function pendingFetches() {
  const pending = [];
  const fetch = () => new Promise((resolve) => pending.push(resolve));
  return { pending, fetch };
}

function fixture({ maxTileRequests, ...options } = {}) {
  const renders = [];
  const renderer = createRecentImageryRenderer({
    ...options,
    maxTileRequests,
    requestRender: (reason) => renders.push(reason),
  });
  const globe = fakeGlobePort();
  renderer.rebind({ collection: {}, kind: 'globe', globe });
  const tileFrames = () =>
    renders.filter((reason) => reason === TILE_RENDER_REASON).length;
  return { renderer, globe, renders, tileFrames };
}

const tile = (x, level = 1) => ({ x, y: 0, level });

test('a slot drapes one GIBS layer bounded to the box; the same day only restyles it', () => {
  const { renderer, globe, renders } = fixture();
  assert.equal(renderer.showSlot('a', S30, BOX, { alpha: 0.8 }), true);
  const [layer] = globe.layers;
  assert.match(
    layer.spec.url,
    /^https:\/\/gibs-\{s\}\.earthdata\.nasa\.gov\/.*HLS_S30.*\/2026-09-18\/GoogleMapsCompatible_Level12\/\{z\}\/\{y\}\/\{x\}\.png$/,
  );
  assert.equal(layer.spec.kind, 'xyz');
  assert.equal(layer.spec.tiling, 'webMercator');
  assert.deepEqual(layer.spec.subdomains, ['a', 'b', 'c']);
  assert.deepEqual(layer.spec.credit, { text: 'NASA GIBS' });
  assert.deepEqual(layer.spec.rectangle, BOX);
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
  assert.equal(layer.split, 'left');
  // A different day replaces the layer.
  renderer.showSlot('a', L30, BOX);
  assert.equal(layer.removed, true);
  assert.equal(globe.layers.length, 1);
  // VIIRS is a level-9 overview.
  renderer.showSlot('b', VIIRS, BOX, { splitDirection: 'right' });
  assert.equal(globe.layers[1].spec.maxLevel, 9);
  assert.equal(globe.layers[1].split, 'right');
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

test('the renderer leaves the surface to the globe port; no host removes the layers; a new port rebuilds them', () => {
  const { renderer, globe, renders } = fixture();
  renderer.showSlot('a', S30, BOX, { alpha: 0.6, splitDirection: 'left' });
  renderer.showSlot('b', L30, BOX, { splitDirection: 'right' });
  const layers = [...globe.layers];
  renders.length = 0;
  renderer.rebind({ collection: {}, kind: 'tileset', globe, tileset: {} });
  assert.deepEqual(globe.layers, layers, 'the port drapes them on the tiles');
  assert.ok(
    layers.every((layer) => layer.drapeOn === 'all'),
    'the renderer never narrows where they drape',
  );
  assert.equal(renderer.getOwned().a.kind, 'tileset');
  assert.deepEqual(renders, ['recent-imagery-rebind'], 'the move gets a frame');
  renderer.rebind({ collection: {}, kind: 'globe', globe: null });
  assert.equal(
    globe.layers.length,
    0,
    'a host with no globe port drapes nothing',
  );
  assert.equal(renderer.showSlot('a', S30, BOX), false);
  renderer.rebind({ collection: {}, kind: 'globe', globe });
  renderer.rebind({ collection: null, kind: 'none', globe });
  assert.equal(globe.layers.length, 0);
  assert.equal(renderer.showSlot('a', S30, BOX), false);
  const other = fakeGlobePort();
  renderer.rebind({ collection: {}, kind: 'globe', globe });
  renderer.showSlot('a', S30, BOX, { alpha: 0.6, splitDirection: 'left' });
  renderer.showSlot('b', L30, BOX, { splitDirection: 'right' });
  renderer.rebind({ collection: {}, kind: 'globe', globe: other });
  assert.equal(globe.layers.length, 0);
  assert.deepEqual(
    other.layers.map((layer) => [layer.alpha, layer.split]),
    [
      [0.6, 'left'],
      [1, 'right'],
    ],
  );
  renderer.destroy();
  assert.equal(other.layers.length, 0);
  assert.equal(renderer.showSlot('a', S30, BOX), false, 'destroyed');
});

test('above the tile limit a request defers silently; its settlement asks for exactly one frame', async () => {
  const { renderer, globe, tileFrames } = fixture({ maxTileRequests: 1 });
  renderer.showSlot('a', S30, BOX);
  const [layer] = globe.layers;
  const { pending, fetch } = pendingFetches();
  const first = layer.request(tile(0), fetch);
  assert.ok(first instanceof Promise);
  for (let i = 1; i <= 120; i += 1)
    assert.equal(layer.request(tile(i), fetch), undefined);
  assert.equal(pending.length, 1, 'deferred requests never go out');
  assert.equal(tileFrames(), 0, 'a deferral asks for no frame');
  pending[0]('tile');
  await first;
  assert.equal(tileFrames(), 1, 'the settlement asks for the retry frame');
  assert.ok(layer.request(tile(200), fetch) instanceof Promise);
});

test('both slots share the budget; a renderer deferral or throw frees its slot', async () => {
  const { renderer, globe, tileFrames } = fixture({ maxTileRequests: 1 });
  renderer.showSlot('a', S30, BOX);
  renderer.showSlot('b', L30, BOX);
  const [a, b] = globe.layers;
  const { pending, fetch } = pendingFetches();
  const held = a.request(tile(0), fetch);
  assert.equal(b.request(tile(0), fetch), undefined, 'the other slot waits');
  pending[0]('tile');
  await held;
  // The renderer itself defers: the slot is free at once.
  for (let i = 0; i < 40; i += 1)
    assert.equal(
      b.request(tile(i), () => undefined),
      undefined,
    );
  assert.throws(
    () =>
      a.request(tile(0), () => {
        throw new Error('boom');
      }),
    /boom/,
  );
  assert.ok(b.request(tile(1), fetch) instanceof Promise, 'still room');
  assert.equal(tileFrames(), 1);
  renderer.destroy();
});

test('against the basemap slot a splits left with no second layer, and leaving the swipe only restyles it', () => {
  const { renderer, globe, renders } = fixture();
  renderer.showSlot('a', S30, BOX, { splitDirection: 'left' });
  renderer.hideSlot('b');
  assert.equal(globe.layers.length, 1, 'the basemap is the right side');
  assert.equal(globe.layers[0].split, 'left');
  assert.equal(renderer.getOwned().b, null);
  const [layer] = globe.layers;
  renderer.showSlot('a', S30, BOX, { splitDirection: 'none' });
  assert.deepEqual(globe.layers, [layer], 'no rebuild for a new look');
  assert.equal(layer.split, 'none');
  assert.deepEqual(renders, ['recent-imagery-show', 'recent-imagery-look']);
});

test('replacement imagery uses source-owned tile URLs and credit and tears down normally', () => {
  const { renderer, globe } = fixture({
    tileTemplate: (product, day) =>
      `https://tiles.example/${product}/${day}/{z}/{x}/{y}`,
    credit: 'Example imagery',
  });
  assert.equal(renderer.showSlot('a', S30, BOX), true);
  const layer = globe.layers[0];
  assert.equal(
    layer.spec.url,
    'https://tiles.example/S30/2026-09-18/{z}/{x}/{y}',
  );
  assert.deepEqual(layer.spec.credit, { text: 'Example imagery' });
  renderer.destroy();
  assert.equal(globe.layers.length, 0);
  assert.equal(layer.removed, true);
});
