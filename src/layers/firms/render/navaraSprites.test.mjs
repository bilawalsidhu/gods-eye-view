import test from 'node:test';
import assert from 'node:assert/strict';
import { createMoverRegistry } from '../../../globe/movers.js';
import { createFirmsSpriteBank } from './navaraSprites.js';
const settle = () => new Promise((resolve) => setImmediate(resolve));
function harness(loadImage) {
  let commits = 0,
    disposals = 0;
  const draws = [],
    canvases = [];
  const registry = createMoverRegistry((options, store) => ({
    ready: () => true,
    commit() {
      commits++;
    },
    destroy() {
      disposals++;
    },
  }));
  const bank = createFirmsSpriteBank(
    { movers: registry.movers },
    {
      id: 'firms-test',
      capacity: 3,
      loadImage,
      createCanvas() {
        const canvas = {
          getContext: () => ({ drawImage: (...args) => draws.push(args) }),
        };
        canvases.push(canvas);
        return canvas;
      },
    },
  );
  return {
    bank,
    registry,
    draws,
    canvases,
    get commits() {
      return commits;
    },
    get disposals() {
      return disposals;
    },
  };
}
test('actual image dimensions set both the atlas cell and visible/pickable quad, with batched horizon flips', async () => {
  const h = harness(async (url) => ({
    width: url === 'small' ? 16 : 56,
    height: url === 'small' ? 16 : 56,
  }));
  const first = h.bank.add({
    id: 'firms-0',
    position: { x: 1, y: 2, z: 3 },
    image: 'small',
  });
  const second = h.bank.add({
    id: 'firms-1',
    position: { x: 4, y: 5, z: 6 },
    image: 'large',
  });
  h.bank.setVisible(true);
  await settle();
  const entry = h.registry.sets.get('firms-test');
  assert.equal(h.registry.sets.size, 1);
  assert.equal(entry.options.sharpen, true);
  assert.equal(entry.options.depthTest, 'always');
  assert.equal(entry.options.pickable, true);
  assert.equal(entry.store.count, 2);
  assert.ok(Math.abs(entry.store.scales[0] - 16 / 56) < 1e-7);
  assert.equal(entry.store.scales[1], 1);
  assert.deepEqual(entry.store.pickIds.slice(0, 2), ['firms-0', 'firms-1']);
  assert.equal(h.draws.length, 2);
  assert.ok(
    h.draws.every((args) => args.length === 3),
    'atlas does not resize source PNGs',
  );
  const rect = entry.options.sprite.atlas.cells['0'];
  assert.ok(Math.abs((rect[2] - rect[0]) * h.canvases[0].width - 16) < 1e-10);
  assert.ok(
    rect[0] > 0 && rect[1] > 0,
    'transparent neighbor padding is retained',
  );
  const before = h.commits;
  first.show = false;
  second.show = false;
  await settle();
  assert.equal(h.commits, before + 1);
  assert.equal(h.canvases.length, 1);
  assert.deepEqual([...entry.store.shows.slice(0, 2)], [0, 0]);
  h.bank.setVisible(false);
  assert.equal(entry.store.count, 0);
  const hidden = h.commits;
  await settle();
  assert.equal(h.commits, hidden);
  h.bank.destroy();
  h.bank.destroy();
  assert.equal(h.registry.sets.size, 0);
  assert.equal(h.disposals, 1);
});
test('uncooperative image completion after disable or destroy cannot create movers or request a frame', async () => {
  let finish;
  const h = harness(() => new Promise((resolve) => (finish = resolve)));
  h.bank.add({ id: 'firms-0', position: { x: 1, y: 2, z: 3 }, image: 'late' });
  h.bank.setVisible(true);
  await settle();
  h.bank.setVisible(false);
  finish({ width: 16, height: 16 });
  await settle();
  assert.equal(h.registry.sets.size, 0);
  assert.equal(h.commits, 0);
  h.bank.collection.removeAll();
  h.bank.add({ id: 'firms-1', position: { x: 1, y: 2, z: 3 }, image: 'later' });
  h.bank.setVisible(true);
  await settle();
  h.bank.destroy();
  finish({ width: 56, height: 56 });
  await settle();
  assert.equal(h.registry.sets.size, 0);
  assert.equal(h.commits, 0);
  assert.equal(h.bank.collection.length, 0);
});
test('clearing rows during decode preserves the new generation and commits only the replacement', async () => {
  const complete = new Map(),
    h = harness((url) => new Promise((resolve) => complete.set(url, resolve)));
  h.bank.setVisible(true);
  h.bank.add({ id: 'old', position: { x: 1, y: 2, z: 3 }, image: 'old' });
  await settle();
  h.bank.collection.removeAll();
  h.bank.add({ id: 'new', position: { x: 4, y: 5, z: 6 }, image: 'new' });
  await settle();
  complete.get('old')({ width: 16, height: 16 });
  await settle();
  assert.equal(h.registry.sets.size, 0);
  complete.get('new')({ width: 56, height: 56 });
  await settle();
  const entry = h.registry.sets.get('firms-test');
  assert.equal(entry.store.count, 1);
  assert.equal(entry.store.pickIds[0], 'new');
  assert.equal(h.commits, 1);
  h.bank.destroy();
});

test('the heatmap hand-off fades every marker and hides them all once it completes', async () => {
  const h = harness(async () => ({ width: 56, height: 56 }));
  h.bank.add({ id: 'firms-0', position: { x: 1, y: 2, z: 3 }, image: 'a' });
  h.bank.add({ id: 'firms-1', position: { x: 4, y: 5, z: 6 }, image: 'a' });
  h.bank.setVisible(true);
  await settle();
  await settle();
  const entry = h.registry.sets.get('firms-test');
  assert.equal(entry.store.count, 2);
  assert.deepEqual(
    [...entry.store.colors.slice(0, 8)],
    [1, 1, 1, 1, 1, 1, 1, 1],
  );
  h.bank.setFade(0.25, true);
  await settle();
  await settle();
  assert.deepEqual(
    [...entry.store.colors.slice(0, 8)],
    [1, 1, 1, 0.25, 1, 1, 1, 0.25],
  );
  h.bank.setFade(0, false);
  await settle();
  await settle();
  assert.equal(entry.store.count, 0, 'the heatmap alone: no marker drawn');
  h.bank.setFade(1, true);
  await settle();
  await settle();
  assert.equal(entry.store.count, 2);
  assert.deepEqual(
    [...entry.store.colors.slice(0, 8)],
    [1, 1, 1, 1, 1, 1, 1, 1],
  );
});
