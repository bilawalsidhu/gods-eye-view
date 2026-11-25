import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TILE_RENDER_REASON,
  createImageryBoxPreview,
  createRecentImageryRenderer,
} from './rendering.js';
import { fromDegrees } from '../../geo/ellipsoid.js';
import { boxKey, nonCrossingBoxes } from './model.js';
import { BOX, FIJI_BOX } from './testDoubles.mjs';
import { fakeGlobePort } from '../../testSupport/fakeGlobePort.mjs';
import { fakeDrawPort } from '../../testSupport/fakeDrawPort.mjs';

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

test('the box preview draws a ground fill and a draped dashed edge, hidden rather than dropped between drags', async () => {
  const draw = fakeDrawPort();
  let box = null;
  const preview = createImageryBoxPreview({}, () => box, { draw });
  const sets = [...draw.sets.values()];
  assert.deepEqual(
    sets.map((r) => [r.kind, r.spec.pickable]),
    [
      ['shapes', false],
      ['lines', false],
    ],
  );
  const [fills, lines] = sets;
  preview.setVisible(true);
  assert.equal(fills.items.size, 0, 'no box yet');
  box = { west: -98, south: 30, east: -98, north: 30 };
  preview.changed();
  assert.equal(fills.items.size, 0, 'a press draws nothing');
  assert.equal(lines.items.size, 0);
  // Dragged along one axis: the edge draws as a line, the fill has no area.
  box = { west: -98, south: 30, east: -97.9, north: 30 };
  preview.changed();
  assert.equal(fills.items.size, 0, 'no fill without an area');
  assert.equal(lines.items.get('edge').show, true, 'the edge along the drag');
  box = { west: -98, south: 30, east: -97.9, north: 30.1 };
  preview.changed();
  const fill = fills.items.get('box');
  assert.deepEqual(fill.geometry.rect, box);
  assert.equal(fill.height, 'clampGround');
  assert.equal(fill.clampTo, 'both');
  assert.deepEqual(fill.fill, [139 / 255, 233 / 255, 1, 0.12]);
  assert.equal(fill.show, true);
  const edge = lines.items.get('edge');
  assert.equal(edge.mode, 'draped');
  assert.equal(edge.clampTo, 'both');
  assert.equal(edge.widthPx, 2);
  assert.deepEqual(edge.style, {
    kind: 'dash',
    color: [139 / 255, 233 / 255, 1, 0.95],
    length: 12,
  });
  assert.equal(edge.positions.length, 5, 'round the corners and back');
  assert.deepEqual(edge.positions[0], edge.positions[4]);
  preview.setVisible(false);
  assert.equal(fills.items.get('box').show, false, 'hidden, kept to move');
  assert.equal(lines.items.get('edge').show, false);
  // The next drag moves it and shows it again.
  box = { west: -97, south: 31, east: -96.5, north: 31.5 };
  preview.setVisible(true);
  assert.deepEqual(fills.items.get('box').geometry.rect, box);
  assert.equal(fills.items.get('box').show, true);
  assert.equal(lines.items.get('edge').show, true);
  // A press with no extent hides the last box.
  box = { west: -97, south: 31, east: -97, north: 31 };
  preview.changed();
  assert.equal(fills.items.get('box').show, false);
  assert.equal(lines.items.get('edge').show, false);
  const gone = preview.destroy();
  assert.equal(preview.destroy(), gone, 'the same promise every time');
  await gone;
  assert.ok(fills.disposed && lines.disposed);
  // Gone: changes after do nothing.
  box = { west: -96, south: 32, east: -95, north: 33 };
  assert.doesNotThrow(() => preview.changed());
});

test('a dateline box drapes one layer on each side of ±180 and removes both', () => {
  const { renderer, globe } = fixture();
  const box = { west: 179, south: 0, east: -179, north: 1 };
  assert.equal(
    renderer.showSlot('a', S30, box, { alpha: 0.4, splitDirection: 'left' }),
    true,
  );
  assert.equal(renderer.ownedCount(), 1);
  assert.equal(globe.layers.length, 2);
  assert.deepEqual(
    globe.layers.map((item) => item.spec.rectangle),
    [
      { west: 179, south: 0, east: 180, north: 1 },
      { west: -180, south: 0, east: -179, north: 1 },
    ],
  );
  assert.equal(globe.layers[0].alpha, 0.4);
  assert.equal(globe.layers[1].alpha, 0.4);
  assert.equal(globe.layers[0].split, 'left');
  assert.equal(globe.layers[1].split, 'left');
  renderer.setAlpha('a', 0.2);
  assert.equal(globe.layers[0].alpha, 0.2);
  assert.equal(globe.layers[1].alpha, 0.2);
  renderer.showSlot('a', S30, box, { alpha: 0.2 });
  assert.equal(globe.added.length, 2, 'the same box does not remount');
  renderer.hideSlot('a');
  assert.equal(globe.layers.length, 0);
});

test('the renderer drapes only the halves the probe allows, and rebind keeps them', () => {
  const { renderer, globe } = fixture();
  const [west, east] = nonCrossingBoxes(FIJI_BOX);
  assert.equal(
    renderer.showSlot('a', VIIRS, FIJI_BOX, { availableBoxes: [east] }),
    true,
  );
  assert.deepEqual(
    globe.layers.map((layer) => layer.spec.rectangle),
    [east],
  );
  renderer.showSlot('b', VIIRS, FIJI_BOX, {
    availableBoxes: [east, west],
    splitDirection: 'right',
  });
  assert.deepEqual(
    globe.layers.map((layer) => layer.split),
    ['none', 'right', 'right'],
  );
  assert.equal(globe.layers.length, 3);

  const next = fakeGlobePort();
  renderer.rebind({ collection: {}, kind: 'globe', globe: next });
  assert.deepEqual(
    next.layers.map((layer) => layer.spec.rectangle),
    [east, west, east],
  );
  renderer.showSlot('a', VIIRS, FIJI_BOX, { availableBoxes: [west, east] });
  assert.equal(next.layers.length, 4);
  renderer.destroy();
  assert.equal(next.layers.length, 0);
});

test('no allowed half, or halves of another box, drapes nothing', () => {
  const { renderer, globe } = fixture();
  for (const availableBoxes of [[], [BOX]]) {
    assert.equal(
      renderer.showSlot('a', VIIRS, FIJI_BOX, { availableBoxes }),
      false,
    );
    assert.equal(globe.layers.length, 0);
  }
});

test('without per-half evidence a VIIRS dateline box drapes nothing, a plain VIIRS box and an HLS dateline box still drape', () => {
  const { renderer, globe } = fixture();
  assert.equal(renderer.showSlot('a', VIIRS, FIJI_BOX), false);
  assert.equal(globe.layers.length, 0);
  assert.equal(renderer.showSlot('a', VIIRS, BOX), true);
  assert.equal(globe.layers.length, 1);
  assert.equal(renderer.showSlot('b', S30, FIJI_BOX), true);
  assert.equal(globe.layers.length, 3);
  renderer.destroy();
});

test('evidence going from none to empty removes the drape', () => {
  const { renderer, globe } = fixture();
  renderer.showSlot('a', S30, FIJI_BOX);
  assert.equal(globe.layers.length, 2);
  assert.equal(
    renderer.showSlot('a', S30, FIJI_BOX, {
      availableBoxes: [],
      emptyBoxes: nonCrossingBoxes(FIJI_BOX),
    }),
    false,
  );
  assert.equal(globe.layers.length, 0);
  renderer.destroy();
});

test('an HLS dateline day drapes every half not confirmed empty, a VIIRS one only the confirmed halves', () => {
  const [west, east] = nonCrossingBoxes(FIJI_BOX);
  for (const [product, expected] of [
    [S30, [west, east]],
    [VIIRS, [east]],
  ]) {
    const { renderer, globe } = fixture();
    renderer.showSlot('a', product, FIJI_BOX, {
      availableBoxes: [east],
      emptyBoxes: [],
    });
    assert.deepEqual(
      globe.layers.map((layer) => layer.spec.rectangle),
      expected,
    );
    renderer.destroy();
  }
});

test('a probe that narrows or widens a dateline drape keeps the layer of the unchanged half', () => {
  const renderer = createRecentImageryRenderer();
  const globe = fakeGlobePort();
  renderer.rebind({ collection: {}, kind: 'globe', globe });
  const [west, east] = nonCrossingBoxes(FIJI_BOX);
  const layerFor = (box) =>
    globe.layers.find((layer) => boxKey(layer.spec.rectangle) === boxKey(box));

  // An HLS day drapes both halves before its probe answers.
  renderer.showSlot('a', S30, FIJI_BOX, { alpha: 0.4, splitDirection: 'left' });
  const kept = layerFor(west);
  assert.ok(kept);
  const added = globe.added.length;

  // The probe confirms the east half empty: only the east layer goes.
  renderer.showSlot('a', S30, FIJI_BOX, {
    alpha: 0.4,
    splitDirection: 'left',
    availableBoxes: [west],
    emptyBoxes: [east],
  });
  assert.equal(kept.removed, false, 'the west layer survives the narrowing');
  assert.equal(globe.added.length, added, 'narrowing adds no layer');
  assert.equal(layerFor(east), undefined);

  // A later probe admits east again: only the east layer is added.
  renderer.showSlot('a', S30, FIJI_BOX, {
    alpha: 0.4,
    splitDirection: 'left',
    availableBoxes: [west, east],
    emptyBoxes: [],
  });
  assert.equal(kept.removed, false, 'the west layer survives the widening');
  assert.equal(globe.added.length, added + 1);
  assert.equal(kept.alpha, 0.4);
  assert.equal(kept.split, 'left');
  renderer.destroy();
});

test('widening slot a over the dateline keeps it below slot b on both sides', () => {
  const { renderer, globe } = fixture();
  const [west, east] = nonCrossingBoxes(FIJI_BOX);
  const topOn = (box) =>
    globe.layers
      .filter((layer) => boxKey(layer.spec.rectangle) === boxKey(box))
      .at(-1)
      .spec.url.includes('S30')
      ? 'A'
      : 'B';
  renderer.showSlot('a', S30, FIJI_BOX, { emptyBoxes: [east] });
  renderer.showSlot('b', L30, FIJI_BOX, { emptyBoxes: [] });
  assert.deepEqual([topOn(west), topOn(east)], ['B', 'B']);
  renderer.showSlot('a', S30, FIJI_BOX, { emptyBoxes: [] });
  assert.deepEqual([topOn(west), topOn(east)], ['B', 'B']);
  renderer.destroy();
});

test('the drag preview draws a wrapped fill and outline across the dateline', async () => {
  const draw = fakeDrawPort();
  let box = { west: 179, south: 0, east: 179, north: 0 };
  const preview = createImageryBoxPreview({}, () => box, { draw });
  const [fills, outlines] = draw.sets.values();
  preview.setVisible(true);

  box = { ...box, east: -179 };
  preview.changed();
  assert.equal(fills.items.size, 0);
  assert.equal(outlines.items.get('edge').show, true);
  assert.deepEqual(
    outlines.items.get('edge').positions[1],
    fromDegrees(-179, 0),
  );

  box = { ...box, north: 1 };
  preview.changed();
  assert.equal(fills.items.get('box').show, true);
  assert.deepEqual(fills.items.get('box').geometry.rect, box);
  const edge = outlines.items.get('edge');
  assert.equal(edge.show, true);
  assert.deepEqual(edge.positions, [
    fromDegrees(179, 0),
    fromDegrees(-179, 0),
    fromDegrees(-179, 1),
    fromDegrees(179, 1),
    fromDegrees(179, 0),
  ]);
  await preview.destroy();
});
