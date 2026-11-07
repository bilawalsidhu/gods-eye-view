import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createImageryRegistry,
  createImageryTileQueue,
  imageryTileLevel,
  imageryTilePlan,
  imageryTileUrl,
  mercatorX,
  mercatorY,
  normalizeImageryLayerOptions,
  normalizeImagerySource,
} from './imagery.js';

const image = { width: 2, height: 1, data: new Uint8Array(8) };

test('sources are checked and defaulted; rectangles default to the globe', () => {
  const tiles = normalizeImagerySource({
    kind: 'tiles',
    url: 'https://t.example/{z}/{x}/{y}.png',
  });
  assert.deepEqual(
    { ...tiles },
    {
      kind: 'tiles',
      url: 'https://t.example/{z}/{x}/{y}.png',
      subdomains: ['a', 'b', 'c'],
      minLevel: 0,
      maxLevel: 18,
      tileSize: 256,
      rectangle: { west: -180, south: -90, east: 180, north: 90 },
      credit: null,
      opaque: false,
      maxRequests: null,
    },
  );
  const across = normalizeImagerySource({
    kind: 'image',
    image,
    rectangle: { west: 170, south: -10, east: -170, north: 10 },
    credit: '<b>x</b>',
  });
  assert.equal(across.image, image);
  assert.equal(across.rectangle.west, 170, 'west > east crosses 180°');
  assert.equal(
    normalizeImagerySource({ kind: 'image', url: 'a.png' }).url,
    'a.png',
  );
  for (const bad of [
    null,
    { kind: 'wms' },
    { kind: 'tiles', url: 'https://t.example/{z}/{x}.png' },
    {
      kind: 'tiles',
      url: 'https://t.example/{z}/{x}/{y}',
      minLevel: 4,
      maxLevel: 2,
    },
    { kind: 'tiles', url: 'https://t.example/{z}/{x}/{y}', maxRequests: 0 },
    { kind: 'tiles', url: 'https://t.example/{z}/{x}/{y}', subdomains: [] },
    { kind: 'image' },
    { kind: 'image', image, url: 'a.png' },
    { kind: 'image', image: { width: 0, height: 1 } },
    { kind: 'image', image: { width: 2, height: 2, data: new Uint8Array(4) } },
    {
      kind: 'image',
      image,
      rectangle: { west: 0, south: 1, east: 2, north: 1 },
    },
    {
      kind: 'image',
      image,
      rectangle: { west: 0, south: 0, east: 0, north: 1 },
    },
    { kind: 'image', image, credit: 7 },
  ])
    assert.throws(
      () => normalizeImagerySource(bad),
      TypeError,
      JSON.stringify(bad),
    );
});

test('layer options are checked and defaulted', () => {
  const options = normalizeImageryLayerOptions({
    id: 'a',
    source: { kind: 'image', image },
  });
  assert.deepEqual(
    [options.order, options.alpha, options.shown, options.split],
    [0, 1, true, 'none'],
  );
  for (const bad of [
    { source: { kind: 'image', image } },
    { id: 'a' },
    { id: 'a', source: { kind: 'image', image }, alpha: 1.5 },
    { id: 'a', source: { kind: 'image', image }, show: 1 },
    { id: 'a', source: { kind: 'image', image }, split: 'top' },
    { id: 'a', source: { kind: 'image', image }, order: Infinity },
  ])
    assert.throws(() => normalizeImageryLayerOptions(bad), TypeError);
});

test('the registry keeps each layer’s look, draws in order and calls its part', () => {
  const calls = [];
  const { imagery, ordered, destroyAll } = createImageryRegistry(
    (state) => ({
      source: () => calls.push(['source', state.options.id, state.source.kind]),
      look: () =>
        calls.push([
          'look',
          state.options.id,
          state.alpha,
          state.shown,
          state.split,
        ]),
      destroy: () => calls.push(['destroy', state.options.id]),
    }),
    {
      splitPosition: (fraction) => calls.push(['split', fraction]),
      surface: () => 'tiles',
    },
  );
  const top = imagery.createLayer({
    id: 'top',
    source: { kind: 'image', image },
    order: 1,
  });
  const bottom = imagery.createLayer({
    id: 'bottom',
    source: { kind: 'image', image },
  });
  assert.throws(
    () => imagery.createLayer({ id: 'top', source: { kind: 'image', image } }),
    /already exists/,
  );
  assert.deepEqual(
    ordered().map(({ options }) => options.id),
    ['bottom', 'top'],
  );
  bottom.setAlpha(0.5);
  bottom.setAlpha(0.5);
  bottom.show(false);
  bottom.setSplit('left');
  top.setSource({ kind: 'tiles', url: 'https://t.example/{z}/{x}/{y}' });
  imagery.setSplitPosition(0.25);
  imagery.setSplitPosition(0.25);
  assert.equal(imagery.surface(), 'tiles');
  assert.deepEqual(calls, [
    ['look', 'bottom', 0.5, true, 'none'],
    ['look', 'bottom', 0.5, false, 'none'],
    ['look', 'bottom', 0.5, false, 'left'],
    ['source', 'top', 'tiles'],
    ['split', 0.25],
  ]);
  assert.throws(() => bottom.show('no'), TypeError);
  assert.throws(() => top.setSource({ kind: 'tiles' }), TypeError);
  assert.equal(top.source().kind, 'tiles', 'a refused source changes nothing');
  destroyAll();
  assert.deepEqual(imagery.list(), []);
  assert.deepEqual(calls.slice(-2), [
    ['destroy', 'top'],
    ['destroy', 'bottom'],
  ]);
  assert.equal(top.isDestroyed(), true);
  assert.throws(() => top.setAlpha(1), /destroyed/);
});

test('the tile level matches the ground resolution under the camera', () => {
  // About 38 m per pixel at the equator: level 12 (38.2 m at 256 px).
  const level = imageryTileLevel({
    height: 18_000,
    latitude: 0,
    fovy: Math.PI / 3,
    heightPx: 540,
  });
  assert.equal(level, 12);
});

test('visible imagery tiles stay bounded and contain the intersected geographic area', () => {
  const box = { west: -100, east: -90, south: 25, north: 35 };
  for (const level of [0, 5, 9, 12]) {
    const plan = imageryTilePlan(box, null, level),
      n = 2 ** plan.z;
    assert.ok(plan.width <= 8 && plan.height <= 8);
    assert.ok(
      plan.x <= mercatorX(box.west) * n &&
        plan.x + plan.width >= mercatorX(box.east) * n,
    );
    assert.ok(
      plan.y <= mercatorY(box.north) * n &&
        plan.y + plan.height >= mercatorY(box.south) * n,
    );
  }
  const r = (x) => (x * Math.PI) / 180;
  const view = {
    west: r(-97.75),
    east: r(-97.73),
    south: r(30.26),
    north: r(30.28),
  };
  const plan = imageryTilePlan(box, view, 12);
  assert.equal(plan.z, 12);
  assert.ok(plan.width * plan.height < 8);
  assert.equal(
    imageryTilePlan(box, { west: 0, east: 0.1, south: 0, north: 0.1 }, 12),
    null,
  );
});

test('source tile addressing retains XYZ order and deterministic subdomain', () => {
  assert.equal(
    imageryTileUrl('https://gibs-{s}.example/{z}/{y}/{x}.png', 4, 7, 9),
    'https://gibs-c.example/9/7/4.png',
  );
});

test('six admissions include slow aborted decodes; stale images close without drawing or errors', async () => {
  const pending = [],
    drawn = [],
    failed = [],
    closed = [];
  let live = true;
  const controllers = new Set();
  const queue = createImageryTileQueue({
    load: (url, signal) =>
      new Promise((resolve) => pending.push({ url, signal, resolve })),
  });
  const task = (id) => ({
    url: String(id),
    controllers,
    live: () => live,
    draw: () => drawn.push(id),
    fail: () => failed.push(id),
  });
  queue.add(Array.from({ length: 10 }, (_, i) => task(i)));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(pending.length, 6);
  assert.equal(queue.diagnostics().active, 6);
  live = false;
  for (const c of controllers) c.abort();
  queue.prune();
  let replacement = true;
  queue.add([{ ...task(10), live: () => replacement }]);
  assert.equal(queue.diagnostics().active, 6);
  for (const p of pending) p.resolve({ close: () => closed.push(p.url) });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(pending.length, 7);
  assert.equal(drawn.length, 0);
  assert.equal(closed.length, 6);
  queue.destroy();
  replacement = false;
  pending[6].resolve({ close: () => closed.push('last') });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(drawn, []);
  assert.deepEqual(failed, []);
  assert.equal(closed.length, 7);
  assert.deepEqual(queue.diagnostics(), { active: 0, queued: 0, peak: 6 });
});
