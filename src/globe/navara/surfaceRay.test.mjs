import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BackSide,
  DoubleSide,
  FrontSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
} from 'three';
import { createNavaraSurface } from './surface.js';

function fixture(t, { distances = [5], sizes = [20], supported = true } = {}) {
  const tiles = distances.map((distance, i) => {
    const root = new Group();
    const geometry = new PlaneGeometry(sizes[i] ?? 20, sizes[i] ?? 20);
    const material = new MeshBasicMaterial({ side: DoubleSide });
    const mesh = new Mesh(geometry, material);
    root.position.set(6378137, 0, distance);
    root.add(mesh);
    root.updateMatrixWorld(true);
    t.after(() => {
      geometry.dispose();
      material.dispose();
    });
    return root;
  });
  let terrainQueries = 0;
  const { surface } = createNavaraSurface(
    {
      sampleTerrainHeight: () => {
        terrainQueries++;
        return 123;
      },
    },
    {
      tileRoots: () => tiles,
      isIdle: () => true,
      retainTileGeometry() {
        if (!supported) throw new Error('CPU geometry unavailable');
      },
    },
  );
  const ray = {
    origin: { x: 6378137, y: 0, z: 0 },
    direction: { x: 0, y: 0, z: 1 },
    far: 10,
  };
  return { surface, tiles, ray, terrainQueries: () => terrainQueries };
}

test('surface ray returns the nearest real triangle in world metres', (t) => {
  const h = fixture(t, { distances: [8, 5] });
  const hit = h.surface.raycast({
    ...h.ray,
    direction: { x: 0, y: 0, z: 7 },
  });
  assert.equal(hit.distance, 5);
  assert.deepEqual(hit.position, { x: 6378137, y: 0, z: 5 });
  assert.equal(hit.object, h.tiles[1]);
  assert.equal(h.terrainQueries(), 0);
});

test('a ray starting inside a broad bound still finds its nearer triangle', (t) => {
  const h = fixture(t, { distances: [5, 2], sizes: [1, 200] });
  assert.equal(h.surface.raycast(h.ray).distance, 2);
});

test('surface rays respect finite range, tile and child exclusions and visibility', (t) => {
  const h = fixture(t, { distances: [5, 8] });
  assert.equal(h.surface.raycast({ ...h.ray, far: 4 }), undefined);
  assert.equal(h.surface.raycast({ ...h.ray, far: 5 }).distance, 5);
  for (const excluded of [h.tiles[0], h.tiles[0].children[0]])
    assert.equal(
      h.surface.raycast({ ...h.ray, exclude: [excluded] }).distance,
      8,
    );
  h.tiles[0].visible = false;
  assert.equal(h.surface.raycast(h.ray).distance, 8);
  h.tiles[1].children[0].visible = false;
  assert.equal(h.surface.raycast(h.ray), undefined);
  assert.equal(h.terrainQueries(), 0);
});

test('invalid and unsupported surface rays never invent terrain intersections', (t) => {
  const h = fixture(t);
  for (const far of [0, -1, NaN, Infinity])
    assert.equal(h.surface.raycast({ ...h.ray, far }), undefined);
  for (const direction of [
    { x: 0, y: 0, z: 0 },
    { x: NaN, y: 0, z: 1 },
  ])
    assert.equal(h.surface.raycast({ ...h.ray, direction }), undefined);
  assert.equal(
    h.surface.raycast({ ...h.ray, origin: { x: Infinity, y: 0, z: 0 } }),
    undefined,
  );
  const missing = fixture(t, { supported: false });
  assert.equal(missing.surface.raycast(missing.ray), undefined);
  assert.equal(missing.terrainQueries(), 0);
});

test('surface rays work after UV/normal release and honor sides and draw ranges', (t) => {
  const h = fixture(t);
  const mesh = h.tiles[0].children[0];
  mesh.geometry.attributes.normal.array = null;
  mesh.geometry.attributes.uv.array = null;
  mesh.material.side = FrontSide;
  assert.equal(h.surface.raycast(h.ray), undefined);
  mesh.material.side = BackSide;
  assert.equal(h.surface.raycast(h.ray).distance, 5);
  mesh.geometry.setDrawRange(0, 0);
  assert.equal(h.surface.raycast(h.ray), undefined);
  mesh.geometry.setDrawRange(0, 6);
  const hit = h.surface.raycast({
    ...h.ray,
    direction: { x: 1, y: 0, z: 1 },
  });
  assert.ok(Math.abs(hit.distance - Math.sqrt(50)) < 1e-9);
  assert.ok(Math.abs(hit.position.x - 6378142) < 1e-9);
});

test('surface ray distances stay in world metres under mesh transforms', (t) => {
  const h = fixture(t);
  h.tiles[0].scale.set(2, 3, 2);
  h.tiles[0].children[0].position.z = 1;
  h.tiles[0].updateMatrixWorld(true);
  assert.equal(h.surface.raycast({ ...h.ray, far: 6 }), undefined);
  const first = h.surface.raycast(h.ray);
  assert.equal(first.distance, 7);
  h.surface.raycast({ ...h.ray, direction: { x: 1, y: 0, z: 1 } });
  assert.deepEqual(first.position, { x: 6378137, y: 0, z: 7 });
});
