import assert from 'node:assert/strict';
import test from 'node:test';
import { vesselGround } from './aisLiveVessels.js';

test('vessels read water levels from the application terrain', () => {
  const terrain = {
    cachedRealEllipsoidalGround: () => 1,
    cachedRealOrthometricGround: () => 2,
    resolveEllipsoidalGround: async () => [],
  };
  const ground = vesselGround({ terrain, groundFloor: {} });
  assert.equal(
    ground.cachedRealEllipsoidalGround,
    terrain.cachedRealEllipsoidalGround,
  );
  assert.equal(
    ground.cachedRealOrthometricGround,
    terrain.cachedRealOrthometricGround,
  );
  assert.equal(
    ground.resolveEllipsoidalGround,
    terrain.resolveEllipsoidalGround,
  );
});

test('without surface services vessels stay on the geoid', () => {
  assert.equal(vesselGround(null), null);
  assert.equal(vesselGround({ terrain: {} }), null);
  assert.equal(
    vesselGround({ terrain: { cachedRealEllipsoidalGround() {} } }),
    null,
  );
});
