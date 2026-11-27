import test from 'node:test';
import assert from 'node:assert/strict';
import { createGroundFloor } from './groundFloor.js';

function seeded(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

function demGround(warm = () => true) {
  const terrain = {
    reads: 0,
    cachedRealEllipsoidalGround(lat, lon) {
      terrain.reads++;
      const cell = `${lat},${lon}`;
      if (!warm(cell)) return null;
      let hash = 0;
      for (const character of cell)
        hash = (Math.imul(hash, 31) + character.charCodeAt(0)) | 0;
      return (hash % 4000) / 10;
    },
    resolveEllipsoidalGround: async () => {},
  };
  const ground = createGroundFloor({ terrain });
  ground.setMeshFloorPreferred(false);
  return { ground, terrain };
}

test('a pass reader shares DEM floors per cell and equals the per-coordinate reads', () => {
  const random = seeded(7);
  const points = [];
  for (let i = 0; i < 4000; i++)
    points.push([40.75 + random() * 0.01, -73.99 + random() * 0.01]);
  // Cell edges, where toFixed(3) and Math.round can disagree, in each sign.
  for (const lat of [40.7505, -40.7505, 0.0005, -0.0005, 1.0005, 8.5745])
    for (const lon of [-73.9905, 73.9905, 0.0005, -0.0005, 1.0005, 2.3515])
      points.push([lat, lon], [lat + 1e-9, lon - 1e-9], [lat - 1e-9, lon]);
  points.push([Number.NaN, 0], [0, Infinity], [0, 0], [-0, -0]);

  const { ground: direct } = demGround();
  const expected = points.map(([lat, lon]) =>
    direct.cachedGroundFloor(lat, lon),
  );
  const { ground, terrain } = demGround();
  const floorAt = ground.floorReader();
  assert.deepStrictEqual(
    points.map(([lat, lon]) => floorAt(lat, lon)),
    expected,
  );
  // 4000 points in a 0.01 degree square share about 121 cells.
  assert.ok(terrain.reads < 600, `read the shared cache ${terrain.reads} times`);

  // A cold cell is remembered as cold for the pass, not asked again.
  const cold = demGround(() => false);
  const coldAt = cold.ground.floorReader();
  assert.equal(coldAt(40.7512, -73.9812), null);
  assert.equal(coldAt(40.7513, -73.9813), null);
  assert.equal(cold.terrain.reads, 1);
});

test('the mesh regime reads floors per point', () => {
  const ground = createGroundFloor({
    terrain: { cachedRealEllipsoidalGround: () => 50 },
  });
  ground.setMeshFloorPreferred(true);
  assert.equal(ground.reportValidatedMeshFloorCell(40.7512, -73.9812, 55), true);
  assert.equal(ground.reportValidatedMeshFloorCell(40.7514, -73.9814, 60), true);
  const at = ground.floorReader();
  assert.equal(at(40.7512, -73.9812), 55);
  assert.equal(at(40.7514, -73.9814), 60);
});
