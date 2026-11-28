import assert from 'node:assert/strict';
import test from 'node:test';
import { createTileCache } from './tileCache.js';

test('coverage tiles are kept for a while: panning back loads nothing again', async () => {
  let now = 0;
  const asked = [];
  const tiles = createTileCache({
    load: async (tile) => {
      asked.push(`${tile.z}/${tile.x}/${tile.y}`);
      return { sequences: [] };
    },
    size: 2,
    ttlMs: 1000,
    now: () => now,
  });
  const a = { x: 1, y: 2, z: 14 };
  const b = { x: 2, y: 2, z: 14 };
  const c = { x: 3, y: 2, z: 14 };
  const first = await tiles.get(a, {});
  assert.equal(await tiles.get(a, {}), first, 'the same decoded tile');
  await tiles.get(b, {});
  await tiles.get(c, {});
  await tiles.get(a, {});
  assert.deepEqual(
    asked,
    ['14/1/2', '14/2/2', '14/3/2', '14/1/2'],
    'oldest dropped',
  );
  now = 2000;
  await tiles.get(a, {});
  assert.equal(asked.length, 5, 'stale after the TTL');
  // The same x/y at another zoom is another tile.
  await tiles.get({ ...a, z: 13 }, {});
  assert.deepEqual(asked.at(-1), '13/1/2');
  assert.equal(asked.length, 6);
  // A failed load is not kept.
  const failing = createTileCache({
    load: async () => {
      throw new Error('KartaView did not answer in time — try again');
    },
    size: 2,
    ttlMs: 1000,
  });
  await assert.rejects(failing.get(a, {}), /did not answer/);
});
