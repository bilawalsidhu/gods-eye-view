import test from 'node:test';
import assert from 'node:assert/strict';
import {
  imageryTilePlan,
  imageryTileUrl,
  createImageryTileQueue,
  mercatorX,
  mercatorY,
} from './tiles.js';

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
