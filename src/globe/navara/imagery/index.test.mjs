import test from 'node:test';
import assert from 'node:assert/strict';
import { createEngineEvent } from '../../contract.js';
import { MAX_IMAGERY_SLOTS, createNavaraImagery } from './index.js';

const BOX = { west: -97.77, south: 30.25, east: -97.71, north: 30.29 };
const tick = () => new Promise((resolve) => setImmediate(resolve));

function fixture() {
  const canvases = [];
  const draws = [];
  const jobs = [];
  const sets = [];
  const credits = new Map();
  const changed = createEngineEvent();
  let photoreal = false;
  let frames = 0;
  const view = {
    forceUpdate: () => frames++,
  };
  const { imagery, diagnostics, destroy } = createNavaraImagery(view, {
    camera: {
      changed,
      pose: () => ({
        cartographic: { height: 12_000, latitude: 0.53 },
        fovy: 0.7,
      }),
      viewRectangle: () => null,
    },
    size: () => ({ width: 1280, height: 800 }),
    credits: {
      addStatic(html) {
        credits.set(html, (credits.get(html) ?? 0) + 1);
        return () => credits.set(html, credits.get(html) - 1);
      },
    },
    photorealActive: () => photoreal,
    createPass: () => ({
      set: (slots, split) => sets.push({ slots, split }),
      destroy: () => sets.push('destroyed'),
    }),
    load: (url, signal) =>
      new Promise((resolve) => jobs.push({ url, signal, resolve })),
    createCanvas(width, height) {
      const canvas = {
        width,
        height,
        getContext: () => ({ drawImage: (image) => draws.push(image) }),
      };
      canvases.push(canvas);
      return canvas;
    },
  });
  return {
    imagery,
    diagnostics,
    destroy,
    canvases,
    draws,
    jobs,
    credits,
    changed,
    last: () => sets.filter((entry) => entry !== 'destroyed').at(-1),
    sets,
    frames: () => frames,
    setPhotoreal: (value) => (photoreal = value),
  };
}

const tiles = (extra = {}) => ({
  kind: 'tiles',
  url: 'https://gibs-{s}.example/{z}/{y}/{x}.png',
  maxLevel: 12,
  rectangle: BOX,
  credit: 'NASA GIBS',
  ...extra,
});

test('a tiles layer mosaics the visible tiles into one atlas; a new source drops it and its loads', async () => {
  const f = fixture();
  const layer = f.imagery.createLayer({ id: 'a', source: tiles() });
  await tick();
  const first = f.diagnostics().a;
  assert.equal(first.atlas.level, 12);
  assert.ok(first.atlas.tiles >= 1 && first.atlas.tiles <= 64);
  assert.equal(f.jobs.length, Math.min(6, first.atlas.tiles), 'six at a time');
  assert.match(
    f.jobs[0].url,
    /^https:\/\/gibs-[abc]\.example\/12\/\d+\/\d+\.png$/,
  );
  const [slot] = f.last().slots;
  assert.deepEqual(slot.look, [1, 0, 1, 0], 'alpha 1, no side, Web Mercator');
  assert.deepEqual(slot.rect, [BOX.west, BOX.south, BOX.east, BOX.north]);
  assert.equal(f.credits.get('NASA GIBS'), 1);
  // A tile arriving draws into the atlas and asks for a frame.
  const before = f.frames();
  f.jobs[0].resolve({ close() {} });
  await tick();
  assert.equal(f.draws.length, 1);
  assert.ok(f.frames() > before);
  // A restyle keeps the atlas; the split side reaches the pass.
  const texture = slot.texture;
  layer.setAlpha(0.4);
  layer.setSplit('left');
  assert.equal(f.last().slots[0].texture, texture);
  assert.deepEqual(f.last().slots[0].look, [0.4, -1, 1, 0]);
  // Another day: the atlas goes, its pending loads abort, late images close.
  let disposed = 0;
  texture.addEventListener('dispose', () => disposed++);
  const pending = f.jobs.slice(1);
  layer.setSource(tiles({ url: 'https://other.example/{z}/{x}/{y}.png' }));
  assert.equal(disposed, 1);
  assert.ok(pending.every((job) => job.signal.aborted));
  assert.equal(f.canvases[0].width, 0, 'the old atlas canvas is released');
  let closed = 0;
  for (const job of pending) job.resolve({ close: () => closed++ });
  await tick();
  assert.equal(closed, pending.length);
  assert.equal(f.draws.length, 1, 'late images never draw');
  assert.match(f.jobs.at(-1).url, /^https:\/\/other\.example\//);
  layer.destroy();
  assert.equal(f.credits.get('NASA GIBS'), 0);
  assert.deepEqual(f.last().slots, []);
  f.destroy();
  assert.equal(f.sets.at(-1), 'destroyed');
});

test('an image layer is one texture; the same canvas again uploads its pixels', () => {
  const f = fixture();
  const canvas = { width: 8, height: 4, getContext: () => ({}) };
  const layer = f.imagery.createLayer({
    id: 'heat',
    source: { kind: 'image', image: canvas },
    order: 1,
  });
  const [slot] = f.last().slots;
  assert.deepEqual(slot.rect, [-180, -90, 180, 90]);
  assert.deepEqual(slot.bounds, slot.rect);
  assert.deepEqual(slot.look, [1, 0, 0, 0], 'geographic');
  assert.equal(slot.texture.image, canvas);
  assert.equal(slot.texture.flipY, false, 'row 0 is the north edge');
  const version = slot.texture.version;
  layer.setSource({ kind: 'image', image: canvas });
  assert.equal(f.last().slots[0].texture, slot.texture);
  assert.ok(slot.texture.version > version, 'its new pixels upload');
  // Across the antimeridian the east edge comes after the west one.
  layer.setSource({
    kind: 'image',
    image: { width: 2, height: 2, data: new Uint8Array(16) },
    rectangle: { west: 170, south: -10, east: -170, north: 10 },
  });
  assert.deepEqual(f.last().slots[0].rect, [170, -10, 190, 10]);
  layer.setAlpha(0);
  assert.deepEqual(f.last().slots, [], 'alpha 0 draws nothing');
  layer.setAlpha(1);
  layer.show(false);
  assert.deepEqual(f.last().slots, []);
});

test('the pass draws the shown layers bottom first, at most its slot count', () => {
  const f = fixture();
  const image = { width: 1, height: 1, data: new Uint8Array(4) };
  const layers = Array.from({ length: MAX_IMAGERY_SLOTS + 2 }, (_, index) =>
    f.imagery.createLayer({
      id: `layer-${index}`,
      source: { kind: 'image', image },
      order: -index,
      alpha: 0.5 + index / 100,
    }),
  );
  const drawn = f.last().slots.map((slot) => slot.look[0]);
  assert.equal(drawn.length, MAX_IMAGERY_SLOTS);
  // Highest order last; the lowest two are left out.
  assert.deepEqual(
    drawn,
    layers
      .slice(0, MAX_IMAGERY_SLOTS)
      .map((layer) => layer.alpha())
      .reverse(),
  );
  f.imagery.setSplitPosition(0.3);
  assert.equal(f.last().split, 0.3);
  assert.equal(f.imagery.surface(), 'globe');
  f.setPhotoreal(true);
  assert.equal(f.imagery.surface(), 'tiles');
});

test('a hidden tiles layer drops its atlas; shown again it builds one at the view', async () => {
  const f = fixture();
  const layer = f.imagery.createLayer({ id: 'a', source: tiles() });
  layer.show(false);
  assert.equal(f.diagnostics().a.atlas, null);
  assert.equal(f.credits.get('NASA GIBS'), 0, 'its credit goes too');
  f.changed.raiseEvent();
  assert.equal(f.diagnostics().a.atlas, null);
  layer.show(true);
  await tick();
  assert.ok(f.diagnostics().a.atlas);
  assert.equal(f.last().slots.length, 1);
});

test('geographic tiles draw in degrees through the source’s transform', async () => {
  const f = fixture();
  const masked = [];
  f.imagery.createLayer({
    id: 'radar',
    source: tiles({
      url: 'https://weather.example/tile?z={z}&x={x}&y={y}',
      scheme: 'geographic',
      maxLevel: 6,
      transform: (image) => {
        masked.push(image);
        return { masked: image };
      },
    }),
  });
  await tick();
  const { atlas } = f.diagnostics().radar;
  assert.equal(atlas.level, 6, 'the source’s top level');
  const [slot] = f.last().slots;
  assert.equal(slot.look[2], 0, 'sampled in degrees');
  const [west, south, east, north] = slot.bounds;
  assert.ok(west <= BOX.west && east >= BOX.east);
  assert.ok(south <= BOX.south && north >= BOX.north);
  assert.match(f.jobs[0].url, /z=6&x=\d+&y=\d+$/);
  const tile = { close() {} };
  f.jobs[0].resolve(tile);
  await tick();
  assert.deepEqual(masked, [tile]);
  assert.deepEqual(f.draws, [{ masked: tile }]);
});

test('a staged tiles source builds its own atlas under the drawn one and takes its place when complete', async () => {
  const f = fixture();
  const layer = f.imagery.createLayer({ id: 'a', source: tiles() });
  await tick();
  const drawn = f.last().slots[0].texture;
  const firstJobs = f.jobs.length;
  const staged = layer.setSource(
    tiles({ url: 'https://next.example/{z}/{x}/{y}.png', credit: 'Next' }),
    { staged: true },
  );
  await tick();
  assert.equal(f.last().slots[0].texture, drawn, 'the drawn atlas stays');
  assert.ok(f.diagnostics().a.staging, 'the staged atlas loads');
  const next = f.jobs.slice(firstJobs);
  assert.ok(next.length > 0 && next.every((job) => /next/.test(job.url)));
  let done;
  staged.then((value) => (done = value));
  // Every tile of the staged atlas in: it takes the drawn one's place.
  for (let round = 0; round < 20 && done === undefined; round++) {
    for (const job of f.jobs.slice(firstJobs)) job.resolve({ close() {} });
    await tick();
  }
  assert.equal(done, true);
  assert.notEqual(f.last().slots[0].texture, drawn);
  assert.equal(f.credits.get('Next'), 1);
  assert.equal(f.credits.get('NASA GIBS'), 0);
  // A failed tile leaves the drawn atlas.
  const before = f.last().slots[0].texture;
  const from = f.jobs.length;
  const failed = layer.setSource(
    tiles({ url: 'https://broken.example/{z}/{x}/{y}.png' }),
    { staged: true },
  );
  await tick();
  f.jobs[from].resolve(Promise.reject(new Error('404')));
  let result;
  failed.then((value) => (result = value));
  for (let round = 0; round < 20 && result === undefined; round++) {
    for (const job of f.jobs.slice(from + 1)) job.resolve({ close() {} });
    await tick();
  }
  assert.equal(result, false);
  assert.equal(f.last().slots[0].texture, before);
});

test('a raised image is lifted with the camera; its detail is a slot over it', async () => {
  const f = fixture();
  const image = { width: 2, height: 2, data: new Uint8Array(16) };
  const layer = f.imagery.createLayer({
    id: 'shell',
    source: { kind: 'image', image, rectangle: BOX },
    raise: 6000,
  });
  const [slot] = f.last().slots;
  // 12 km up: a 0 m lift (48 m rounds to 0).
  assert.equal(slot.raise, 6000);
  const detailRectangle = { ...BOX, east: -97.74 };
  assert.equal(
    await layer.setDetail({ image, rectangle: detailRectangle }),
    true,
  );
  const [main, detail] = f.last().slots;
  assert.equal(main.look[3], 1, 'the next slot is its detail');
  assert.deepEqual(detail.rect, [
    detailRectangle.west,
    detailRectangle.south,
    detailRectangle.east,
    detailRectangle.north,
  ]);
  assert.equal(detail.raise, 6000);
  await layer.setDetail(null);
  assert.equal(f.last().slots.length, 1);
  assert.equal(f.last().slots[0].look[3], 0);
});
