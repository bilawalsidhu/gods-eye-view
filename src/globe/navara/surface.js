// GlobeSurface on Navara: the height of the rendered scene is a CPU ray
// straight down the ellipsoid normal against the 3D-tile meshes Navara shows.
// Where the shown tiles do not reach (outside the frustum), the loaded
// tiles Navara hides answer, the finest first. Tile positions are float32
// in the mesh's local frame; its float64 matrixWorld maps hits back into
// Earth-fixed metres, including any tileset rotation or translation.
// Navara frees the CPU arrays after upload;
// retainTileGeometry (internals.js) keeps positions and indices. Without a
// tile hit, the answer is Navara's terrain height, as Cesium's sampleHeight
// also samples the globe. Navara internals come in through `hooks`, so this
// module stays testable on plain three objects.

import {
  BackSide,
  DoubleSide,
  FrontSide,
  Matrix4,
  Ray,
  Sphere,
  Vector3,
} from 'three';
import * as geo from '../../geo/index.js';
import { normalizeSurfaceOptions } from '../surfaceDetail.js';
import { photorealTilesVisible } from './maps.js';

const { cartesian3, cartographic, math } = geo;
const WGS84 = geo.ellipsoid.WGS84;
// Above every rendered surface (Everest is 8.8 km) and down to below the
// lowest one (Dead Sea, about −430 m plus the geoid).
const RAY_START_HEIGHT = 12000;
const RAY_BELOW_ELLIPSOID = 1000;

/** The downward ray at a place: every point on it shares its longitude and latitude. */
export function surfaceRay(place) {
  const origin = cartesian3.fromRadians(
    place.longitude,
    place.latitude,
    RAY_START_HEIGHT,
    WGS84,
  );
  const normal = WGS84.geodeticSurfaceNormalCartographic(
    place,
    cartesian3.create(),
  );
  return {
    origin,
    direction: cartesian3.negate(normal, cartesian3.create()),
    far: RAY_START_HEIGHT + RAY_BELOW_ELLIPSOID,
  };
}

/** Height above the ellipsoid of a hit `distance` metres down a surfaceRay. */
export const heightAlongRay = (distance) =>
  Number.isFinite(distance) ? RAY_START_HEIGHT - distance : undefined;

const worldRay = new Ray();
const localRay = new Ray();
const inverse = new Matrix4();
const sphere = new Sphere();
const entry = new Vector3();
const a = new Vector3();
const b = new Vector3();
const c = new Vector3();
const point = new Vector3();

const hasPositions = (object) =>
  object.isMesh && Boolean(object.geometry?.attributes?.position?.array);

// The meshes with CPU positions under `object`, minus `exclude`, into
// `out`; with `shownOnly`, only through visible objects. `roots` (when
// given) gets the tile root of each mesh, at the same index.
function collectMeshes(object, exclude, shownOnly, out, roots, root) {
  if (exclude.has(object) || (shownOnly && !object.visible)) return;
  if (hasPositions(object)) {
    out.push(object);
    roots?.push(root);
  }
  const children = object.children;
  for (let i = 0; i < children.length; i++)
    collectMeshes(children[i], exclude, shownOnly, out, roots, root);
}

// Reused between calls (sampleHeight runs per frame in the ground floor).
const shownMeshes = [];
const shownRoots = [];
const tileMeshesScratch = [];

// Nearest hit along worldRay with one mesh, in metres. Not Mesh.raycast: that
// interpolates UVs and normals, whose arrays Navara has released.
function meshHitDistance(mesh, far) {
  const geometry = mesh.geometry;
  if (!geometry.boundingSphere) geometry.computeBoundingSphere();
  sphere.copy(geometry.boundingSphere).applyMatrix4(mesh.matrixWorld);
  if (!worldRay.intersectsSphere(sphere)) return Infinity;
  inverse.copy(mesh.matrixWorld).invert();
  localRay.copy(worldRay).applyMatrix4(inverse);
  if (!geometry.boundingBox) geometry.computeBoundingBox();
  if (!localRay.intersectsBox(geometry.boundingBox)) return Infinity;
  const material = Array.isArray(mesh.material)
    ? mesh.material[0]
    : mesh.material;
  const side = material?.side ?? FrontSide;
  const cull = side !== DoubleSide;
  const flip = side === BackSide;
  const position = geometry.attributes.position;
  const index = geometry.index?.array ?? null;
  const count = index ? index.length : position.count;
  const start = Math.max(0, geometry.drawRange.start);
  const end = Math.min(count, start + geometry.drawRange.count);
  let nearest = Infinity;
  for (let i = start; i + 2 < end; i += 3) {
    a.fromBufferAttribute(position, index ? index[i] : i);
    b.fromBufferAttribute(position, index ? index[i + 1] : i + 1);
    c.fromBufferAttribute(position, index ? index[i + 2] : i + 2);
    const hit = flip
      ? localRay.intersectTriangle(c, b, a, cull, point)
      : localRay.intersectTriangle(a, b, c, cull, point);
    if (!hit) continue;
    point.applyMatrix4(mesh.matrixWorld);
    const distance = worldRay.origin.distanceTo(point);
    if (distance < nearest && distance <= far) nearest = distance;
  }
  return nearest;
}

// Nearest hit over meshes, tried in the order the ray enters their bounding
// spheres; stops once the next sphere starts below the best hit. Returns
// the distance and the tile root (from `roots`) of the mesh hit.
function nearestHit(meshes, roots, ray) {
  worldRay.origin.set(ray.origin.x, ray.origin.y, ray.origin.z);
  worldRay.direction.set(ray.direction.x, ray.direction.y, ray.direction.z);
  const candidates = [];
  for (let i = 0; i < meshes.length; i++) {
    const mesh = meshes[i];
    const geometry = mesh.geometry;
    if (!geometry.boundingSphere) geometry.computeBoundingSphere();
    sphere.copy(geometry.boundingSphere).applyMatrix4(mesh.matrixWorld);
    if (!worldRay.intersectSphere(sphere, entry)) continue;
    // intersectSphere returns the exit when the origin is inside. Such a mesh
    // can contain the nearest triangle, so it must enter the candidate list at 0.
    candidates.push([
      sphere.containsPoint(worldRay.origin)
        ? 0
        : worldRay.origin.distanceTo(entry),
      i,
    ]);
  }
  candidates.sort((x, y) => x[0] - y[0]);
  let nearest = Infinity;
  let root = null;
  for (const [enter, i] of candidates) {
    if (enter > nearest) break;
    const distance = meshHitDistance(meshes[i], ray.far);
    if (distance < nearest) {
      nearest = distance;
      root = roots[i];
    }
  }
  return { distance: nearest, root };
}

// A tile's extent: the bounding sphere around all its meshes, in
// Earth-fixed metres. Navara 0.2.1 exposes no geometric error or level on a
// tile, and a quadtree tile's extent halves with each level, so the extent
// orders them. Tiles do not move once loaded: computed once per tile.
const extents = new WeakMap();
function tileExtent(root) {
  let extent = extents.get(root);
  if (extent) return extent;
  tileMeshesScratch.length = 0;
  collectMeshes(root, NO_EXCLUDE, false, tileMeshesScratch);
  if (!tileMeshesScratch.length) return null;
  const bounds = new Sphere();
  for (const mesh of tileMeshesScratch) {
    const geometry = mesh.geometry;
    if (!geometry.boundingSphere) geometry.computeBoundingSphere();
    sphere.copy(geometry.boundingSphere).applyMatrix4(mesh.matrixWorld);
    if (bounds.isEmpty()) bounds.copy(sphere);
    else bounds.union(sphere);
  }
  extent = bounds;
  extents.set(root, extent);
  return extent;
}
const NO_EXCLUDE = new Set();

// Where the shown tiles miss, the loaded tiles Navara hides (outside the
// frustum, or parents of the tiles it shows) answer. Several levels of
// detail overlap there: the hit on the finest tiles (extent within 1.5
// times the finest tile hit; a quadtree parent is about twice its child),
// the top one among them. Tiles the ray passes are tried finest first, and
// coarser ones stop being tried once a hit sets the limit, so the coarse
// parents' triangles are never walked.
const hiddenTiles = [];
function finestHiddenHit(roots, exclude, ray) {
  worldRay.origin.set(ray.origin.x, ray.origin.y, ray.origin.z);
  worldRay.direction.set(ray.direction.x, ray.direction.y, ray.direction.z);
  hiddenTiles.length = 0;
  for (let i = 0; i < roots.length; i++) {
    const root = roots[i];
    if (root.visible || exclude.has(root)) continue;
    const extent = tileExtent(root);
    if (extent && worldRay.intersectsSphere(extent)) hiddenTiles.push(root);
  }
  hiddenTiles.sort((x, y) => extents.get(x).radius - extents.get(y).radius);
  let limit = Infinity;
  let nearest = Infinity;
  let answered = null;
  for (const root of hiddenTiles) {
    const radius = extents.get(root).radius;
    if (radius > limit) break;
    tileMeshesScratch.length = 0;
    collectMeshes(root, exclude, false, tileMeshesScratch);
    let hit = Infinity;
    for (const mesh of tileMeshesScratch)
      hit = Math.min(hit, meshHitDistance(mesh, ray.far));
    if (!Number.isFinite(hit)) continue;
    if (limit === Infinity) limit = 1.5 * radius;
    if (hit < nearest) {
      nearest = hit;
      answered = root;
    }
  }
  hiddenTiles.length = 0;
  return { distance: nearest, root: answered };
}

// The size of a tile that answered: its extent's diameter.
const tileSizeOf = (root) => {
  const extent = root ? tileExtent(root) : null;
  return extent ? 2 * extent.radius : undefined;
};

/**
 * @param {{ sampleTerrainHeight: (place: { lat: number, lng: number }) => number | undefined }} view
 * @param {{
 *   tileRoots: () => object[],
 *   isIdle: () => boolean,
 *   retainTileGeometry: () => void,
 * }} hooks Navara internals (internals.js).
 * @param {(positions: object[]) => Promise<(number | undefined)[]>} [sampleTerrain]
 *   The maps' sampling of the terrain shown (maps.js).
 * @returns {{ surface: import('../contract.js').GlobeSurface }}
 */
export function createNavaraSurface(
  view,
  hooks,
  sampleTerrain = async (positions) => positions.map(() => 0),
) {
  let supported = true;
  try {
    hooks.retainTileGeometry();
  } catch (error) {
    supported = false;
    console.warn('[globe] Navara tile heights are unavailable:', error);
  }
  const terrainHeight = (place) => {
    const height = view.sampleTerrainHeight({
      lat: math.toDegrees(place.latitude),
      lng: math.toDegrees(place.longitude),
    });
    return Number.isFinite(height) ? height : undefined;
  };
  const terrainDetail = (place) => {
    const height = terrainHeight(place);
    return height === undefined ? undefined : { height, source: 'terrain' };
  };
  const sampleHeightDetailed = (place, options) => {
    const { exclude } = normalizeSurfaceOptions(options);
    if (!supported || !photorealTilesVisible(view)) return terrainDetail(place);
    const ray = surfaceRay(place);
    const roots = hooks.tileRoots();
    const excluded = exclude.length ? new Set(exclude) : NO_EXCLUDE;
    // The tiles on screen first; where they do not reach (the ground under
    // a camera looking ahead is outside the frustum), the hidden ones.
    shownMeshes.length = 0;
    shownRoots.length = 0;
    for (let i = 0; i < roots.length; i++)
      collectMeshes(
        roots[i],
        excluded,
        true,
        shownMeshes,
        shownRoots,
        roots[i],
      );
    let hit = nearestHit(shownMeshes, shownRoots, ray);
    shownMeshes.length = 0;
    shownRoots.length = 0;
    if (!Number.isFinite(hit.distance))
      hit = finestHiddenHit(roots, excluded, ray);
    const height = heightAlongRay(hit.distance);
    if (height === undefined) return terrainDetail(place);
    return { height, source: 'tiles', tileSizeM: tileSizeOf(hit.root) };
  };
  const sampleHeight = (place, exclude) =>
    sampleHeightDetailed(place, exclude ? { exclude } : undefined)?.height;
  // Activation-time obstruction probe: only the visible tile triangles, never
  // a fabricated terrain intersection or a second retained-geometry cache.
  const raycast = ({ origin, direction, far, exclude = [] }) => {
    if (
      !supported ||
      !photorealTilesVisible(view) ||
      ![
        origin?.x,
        origin?.y,
        origin?.z,
        direction?.x,
        direction?.y,
        direction?.z,
        far,
      ].every(Number.isFinite) ||
      far <= 0
    )
      return undefined;
    const length = Math.hypot(direction.x, direction.y, direction.z);
    if (!length || !Number.isFinite(length)) return undefined;
    const ray = {
      origin,
      direction: {
        x: direction.x / length,
        y: direction.y / length,
        z: direction.z / length,
      },
      far,
    };
    const excluded = exclude.length ? new Set(exclude) : NO_EXCLUDE;
    shownMeshes.length = shownRoots.length = 0;
    let hit;
    try {
      for (const root of hooks.tileRoots())
        collectMeshes(root, excluded, true, shownMeshes, shownRoots, root);
      hit = nearestHit(shownMeshes, shownRoots, ray);
    } finally {
      shownMeshes.length = shownRoots.length = 0;
    }
    if (!Number.isFinite(hit.distance)) return undefined;
    return {
      distance: hit.distance,
      object: hit.root,
      position: {
        x: origin.x + ray.direction.x * hit.distance,
        y: origin.y + ray.direction.y * hit.distance,
        z: origin.z + ray.direction.z * hit.distance,
      },
    };
  };
  return {
    surface: {
      raycast,
      sampleHeight,
      sampleHeightDetailed,
      supported,
      terrainHeight,
      terrainHeightSupported: true,
      sampleTerrainMostDetailed: (positions) => sampleTerrain(positions),
      clampToHeight(position, exclude) {
        const place = cartographic.fromCartesian(position, WGS84);
        if (!place) return undefined;
        const height = sampleHeight(place, exclude);
        if (height === undefined) return undefined;
        return cartesian3.fromRadians(
          place.longitude,
          place.latitude,
          height,
          WGS84,
        );
      },
      clampToHeightSupported: supported,
      tilesLoaded: () => hooks.isIdle(),
    },
  };
}
