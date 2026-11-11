import test from 'node:test';
import assert from 'node:assert/strict';
import {
  acceptedSurfaceHeight,
  normalizeSurfaceOptions,
} from './surfaceDetail.js';

test('surface options: an exclude list', () => {
  assert.deepEqual(normalizeSurfaceOptions(), { exclude: [] });
  const set = { id: 'flights' };
  assert.deepEqual(normalizeSurfaceOptions({ exclude: [set] }), {
    exclude: [set],
  });
  assert.throws(() => normalizeSurfaceOptions({ exclude: 'x' }), TypeError);
});

test('a coarse tile answer is a miss; terrain only when asked for', () => {
  const fine = { height: 122.5, source: 'tiles', tileSizeM: 180 };
  const coarse = { height: 143.2, source: 'tiles', tileSizeM: 5200 };
  const cesium = { height: 122.4, source: 'tiles' };
  const terrain = { height: 120, source: 'terrain' };
  const limit = { maxTileSizeM: 1000 };
  assert.equal(acceptedSurfaceHeight(fine, limit), 122.5);
  assert.equal(acceptedSurfaceHeight(coarse, limit), undefined);
  assert.equal(acceptedSurfaceHeight(coarse), 143.2, 'no limit: kept');
  assert.equal(acceptedSurfaceHeight(cesium, limit), 122.4, 'no size: kept');
  assert.equal(acceptedSurfaceHeight(terrain, limit), undefined);
  assert.equal(acceptedSurfaceHeight(terrain, { terrain: true }), 120);
  assert.equal(acceptedSurfaceHeight(undefined), undefined);
  assert.equal(
    acceptedSurfaceHeight({ height: NaN, source: 'tiles' }),
    undefined,
  );
});
