import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTerrainHeights } from './terrainHeights.js';

test('a failed later chunk does not overwrite the measured height across the prime meridian', async () => {
  const calls = [];
  const source = {
    async getHeights(chunk) {
      calls.push(chunk.length);
      if (calls.length === 1) return chunk.map(() => ({ ellipsoid: 125 }));
      const error = new Error('429');
      error.status = 429;
      throw error;
    },
  };
  const terrain = createTerrainHeights({ source });
  const coords = [{ lat: 51.48, lon: -0.000001 }];
  for (let i = 1; i <= 63; i += 1) coords.push({ lat: 51.48, lon: i });
  coords.push({ lat: 51.48, lon: 0.000001 });
  const rows = await terrain.resolveEllipsoidalGround(coords);
  assert.deepEqual(rows[0], { ellipsoid: 125, source: 'reearth' });
  assert.equal(terrain.cachedRealEllipsoidalGround(51.48, -0.000001), 125);
  assert.deepEqual(calls, [64]);
  assert.deepEqual(rows[64], { ellipsoid: 125, source: 'reearth' });
  assert.equal(terrain.cachedRealEllipsoidalGround(51.48, 0.000001), 125);
});
