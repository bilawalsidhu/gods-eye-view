import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicMaterial,
} from 'three';
import * as geo from '../../geo/index.js';
import { createNavaraSurface, heightAlongRay, surfaceRay } from './surface.js';

const { cartesian3, cartographic, math } = geo;
const WGS84 = geo.ellipsoid.WGS84;
const near = (actual, expected, tolerance, label) =>
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${label}: ${actual} is not within ${tolerance} of ${expected}`,
  );

// A tile as Navara loads it: float32 positions relative to the tile centre,
// which sits in the mesh's matrixWorld with an identity rotation. The square
// lies `height` metres up at (lon, lat), `half` metres to each side.
function tileAt(lon, lat, height, half = 100) {
  const centre = cartesian3.fromDegrees(lon, lat, height);
  const frame = geo.transforms.eastNorthUpToFixedFrame(centre, WGS84);
  const corner = (e, n) => [
    frame[0] * e + frame[4] * n,
    frame[1] * e + frame[5] * n,
    frame[2] * e + frame[6] * n,
  ];
  const geometry = new BufferGeometry();
  geometry.setAttribute(
    'position',
    new BufferAttribute(
      new Float32Array([
        ...corner(-half, -half),
        ...corner(half, -half),
        ...corner(half, half),
        ...corner(-half, half),
      ]),
      3,
    ),
  );
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
  const mesh = new Mesh(geometry, new MeshBasicMaterial({ side: DoubleSide }));
  const tile = new Group();
  tile.position.set(centre.x, centre.y, centre.z);
  tile.add(mesh);
  tile.updateMatrixWorld(true);
  return { tile, mesh };
}

function setup({
  tiles = [],
  terrain = () => undefined,
  idle = true,
  retain,
} = {}) {
  const view = {
    sampleTerrainHeight: (place) => terrain(place),
  };
  let retained = 0;
  const surface = createNavaraSurface(view, {
    tileRoots: () => tiles,
    isIdle: () => idle,
    retainTileGeometry:
      retain ??
      (() => {
        retained++;
      }),
  });
  return { surface: surface.surface, retained: () => retained };
}

test('surfaceRay runs down the ellipsoid normal from 12 km', () => {
  const ray = surfaceRay(cartographic.fromDegrees(20, 10, 0));
  const start = cartographic.fromCartesian(ray.origin, WGS84);
  near(start.height, 12000, 1e-6, 'start height');
  const below = cartesian3.add(
    ray.origin,
    cartesian3.multiplyByScalar(ray.direction, 12000, cartesian3.create()),
    cartesian3.create(),
  );
  near(cartographic.fromCartesian(below, WGS84).height, 0, 1e-6, 'ground');
  near(
    cartesian3.distance(below, cartesian3.fromDegrees(20, 10, 0)),
    0,
    1e-6,
    'the ray keeps longitude and latitude at the surface',
  );
  assert.equal(heightAlongRay(11950), 50);
  assert.equal(heightAlongRay(null), undefined);
});

test('sampleHeight hits the top of the loaded tiles and keeps tile geometry', () => {
  const low = tileAt(-73.98, 40.75, 12);
  const high = tileAt(-73.98, 40.75, 380, 20);
  const { surface, retained } = setup({ tiles: [low.tile, high.tile] });
  assert.equal(retained(), 1);
  assert.equal(surface.supported, true);
  near(
    surface.sampleHeight(cartographic.fromDegrees(-73.98, 40.75, 0)),
    380,
    0.05,
    'roof',
  );
  near(
    surface.sampleHeight(cartographic.fromDegrees(-73.9795, 40.75, 0)),
    12,
    0.05,
    'street beside it',
  );
});

test('excluded objects are skipped; terrain is the fallback', () => {
  const roof = tileAt(10, 45, 300, 20);
  const ground = tileAt(10, 45, 40);
  const { surface } = setup({
    tiles: [roof.tile, ground.tile],
    terrain: ({ lat, lng }) => (lat === 45 && lng === 10 ? 7 : undefined),
  });
  const place = cartographic.fromDegrees(10, 45, 0);
  near(surface.sampleHeight(place, [roof.mesh]), 40, 0.05, 'excluded roof');
  near(
    surface.sampleHeight(place, [roof.tile, ground.tile]),
    7,
    1e-9,
    'terrain fallback',
  );
  assert.equal(
    surface.sampleHeight(cartographic.fromDegrees(11, 46, 0)),
    undefined,
  );
});

test('outside the view, the loaded tiles Navara hides answer: the finest one', () => {
  // Navara hides the tiles outside the frustum and the parents it refines
  // (visible = false); a camera looking ahead does not see the ground under
  // it. A fine tile in view elsewhere, a hidden fine tile and its hidden
  // coarse parent (300 m wide, 3 m higher) under the camera.
  const inView = tileAt(10.01, 45, 50);
  const fine = tileAt(10, 45, 40);
  const coarse = tileAt(10, 45, 43, 300);
  fine.tile.visible = false;
  coarse.tile.visible = false;
  const { surface } = setup({
    tiles: [inView.tile, coarse.tile, fine.tile],
    terrain: () => 7,
  });
  const place = cartographic.fromDegrees(10, 45, 0);
  near(surface.sampleHeight(place), 40, 0.05, 'the finest hidden tile');
  near(
    surface.sampleHeight(cartographic.fromDegrees(10.01, 45, 0)),
    50,
    0.05,
    'a shown tile first',
  );
  // A shown tile wins over hidden ones at the same place.
  fine.tile.visible = true;
  coarse.tile.visible = true;
  near(surface.sampleHeight(place), 43, 0.05, 'shown: the top surface');
  near(surface.sampleHeight(place, [fine.tile, coarse.tile]), 7, 1e-9);
});

test('terrainHeight reads Navara terrain in degrees; clampToHeight moves along the normal', () => {
  const ground = tileAt(5, 50, 120);
  const seen = [];
  const { surface } = setup({
    tiles: [ground.tile],
    terrain: (place) => {
      seen.push(place);
      return 95;
    },
  });
  assert.equal(surface.terrainHeightSupported, true);
  assert.equal(surface.terrainHeight(cartographic.fromDegrees(5, 50, 0)), 95);
  near(seen[0].lat, 50, 1e-12, 'lat');
  near(seen[0].lng, 5, 1e-12, 'lng');
  assert.equal(surface.clampToHeightSupported, true);
  const clamped = surface.clampToHeight(cartesian3.fromDegrees(5, 50, 5000));
  const place = cartographic.fromCartesian(clamped, WGS84);
  near(place.height, 120, 0.05, 'height');
  near(math.toDegrees(place.longitude), 5, 1e-9, 'longitude');
});

test('tilesLoaded follows Navara idle; a failed geometry patch means unsupported', () => {
  assert.equal(setup({ idle: false }).surface.tilesLoaded(), false);
  assert.equal(setup({ idle: true }).surface.tilesLoaded(), true);
  const { surface } = setup({
    retain: () => {
      throw new Error('ModelMesh._releaseGeometryArrays not found');
    },
  });
  assert.equal(surface.supported, false);
  assert.equal(surface.clampToHeightSupported, false);
});

test('among hidden tiles the finest tile wins by its extent, not by a small mesh in a coarse tile', () => {
  // A coarse hidden tile (800 m across) carries a small 20 m mesh 5 m above
  // the fine hidden tile's ground: by mesh size the coarse tile's small mesh
  // would win; by tile extent the fine tile does.
  const fine = tileAt(10, 45, 40);
  const coarse = tileAt(10, 45, 30, 400);
  const coarseRoof = tileAt(10, 45, 45, 10);
  // One coarse tile with two meshes, both relative to its own centre.
  coarseRoof.tile.remove(coarseRoof.mesh);
  coarseRoof.mesh.position
    .copy(coarseRoof.tile.position)
    .sub(coarse.tile.position);
  coarse.tile.add(coarseRoof.mesh);
  coarse.tile.updateMatrixWorld(true);
  fine.tile.visible = false;
  coarse.tile.visible = false;
  const { surface } = setup({ tiles: [coarse.tile, fine.tile] });
  near(
    surface.sampleHeight(cartographic.fromDegrees(10, 45, 0)),
    40,
    0.05,
    'the fine tile',
  );
});

test('sampleHeightDetailed names the source and the size of the answering tile', () => {
  // A shown coarse tile (600 m wide, 3 m high) over a hidden fine one.
  const fine = tileAt(10, 45, 40);
  const coarse = tileAt(10, 45, 43, 300);
  fine.tile.visible = false;
  const { surface } = setup({
    tiles: [coarse.tile, fine.tile],
    terrain: () => 7,
  });
  const place = cartographic.fromDegrees(10, 45, 0);
  const shown = surface.sampleHeightDetailed(place);
  assert.equal(shown.source, 'tiles');
  near(shown.height, 43, 0.05, 'the shown tile');
  near(shown.tileSizeM, 600 * Math.SQRT2, 1, 'its size');
  assert.deepEqual(
    surface.sampleHeightDetailed(place, { exclude: [coarse.tile, fine.tile] }),
    { height: 7, source: 'terrain' },
  );
  assert.throws(
    () => surface.sampleHeightDetailed(place, { exclude: 'x' }),
    TypeError,
  );
  const bare = setup({ tiles: [] }).surface;
  assert.equal(bare.sampleHeightDetailed(place), undefined);
});

test('a hidden tile answer carries its size too', () => {
  const fine = tileAt(10, 45, 40);
  fine.tile.visible = false;
  const { surface } = setup({ tiles: [fine.tile] });
  const detail = surface.sampleHeightDetailed(
    cartographic.fromDegrees(10, 45, 0),
  );
  near(detail.height, 40, 0.05, 'hidden fine');
  near(detail.tileSizeM, 200 * Math.SQRT2, 1, 'size');
});
