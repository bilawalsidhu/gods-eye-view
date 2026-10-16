// GlobeSurface on Navara (S2): the height of the rendered scene is a CPU ray
// straight down the ellipsoid normal against the 3D-tile meshes Navara shows.
// Where the shown tiles do not reach (outside the frustum), the loaded
// tiles Navara hides answer, the finest first. Tile positions are float32
// relative to the tile centre, which sits in the
// float64 matrixWorld with no rotation, so a ray taken into a mesh's local
// frame gives Earth-fixed metres. Navara frees the CPU arrays after upload;
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
  const normal = WGS84.geodeticSurfaceNormal(origin, cartesian3.create());
  return {
    origin,
    direction: cartesian3.negate(normal, cartesian3.create()),
    far: RAY_START_HEIGHT + RAY_BELOW_ELLIPSOID,
  };
}

/** Height above the ellipsoid of a hit `distance` metres down a surfaceRay. */
export const heightAlongRay = (ray, distance) =>
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

// Meshes with CPU positions under the tile roots, minus `exclude`: the
// shown ones, and the loaded ones Navara hides (outside the frustum, or
// parents of the tiles it shows), which still hold their geometry.
function tileMeshes(roots, exclude) {
  const shown = [];
  const hidden = [];
  const stack = roots
    .filter((root) => !exclude.has(root))
    .map((root) => [root, root.visible]);
  while (stack.length) {
    const [object, visible] = stack.pop();
    if (object.isMesh && object.geometry?.attributes?.position?.array)
      (visible ? shown : hidden).push(object);
    for (const child of object.children)
      if (!exclude.has(child)) stack.push([child, visible && child.visible]);
  }
  return { shown, hidden };
}

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
// spheres; stops once the next sphere starts below the best hit.
function nearestHit(meshes, ray) {
  worldRay.origin.set(ray.origin.x, ray.origin.y, ray.origin.z);
  worldRay.direction.set(ray.direction.x, ray.direction.y, ray.direction.z);
  const candidates = [];
  for (const mesh of meshes) {
    const geometry = mesh.geometry;
    if (!geometry.boundingSphere) geometry.computeBoundingSphere();
    sphere.copy(geometry.boundingSphere).applyMatrix4(mesh.matrixWorld);
    if (!worldRay.intersectSphere(sphere, entry)) continue;
    candidates.push([worldRay.origin.distanceTo(entry), mesh]);
  }
  candidates.sort((x, y) => x[0] - y[0]);
  let nearest = Infinity;
  for (const [enter, mesh] of candidates) {
    if (enter > nearest) break;
    nearest = Math.min(nearest, meshHitDistance(mesh, ray.far));
  }
  return nearest;
}

// Among hidden tiles several levels of detail overlap: the hit on the
// finest tiles (bounding radius within 1.5 times the smallest hit: a
// quadtree parent is about twice its child), the top one
// among them. The tiles the ray passes are tried finest first, and coarser
// ones stop being tried once a hit sets the limit, so the coarse parents'
// triangles are never walked.
function finestHit(meshes, ray) {
  worldRay.origin.set(ray.origin.x, ray.origin.y, ray.origin.z);
  worldRay.direction.set(ray.direction.x, ray.direction.y, ray.direction.z);
  const candidates = [];
  for (const mesh of meshes) {
    const geometry = mesh.geometry;
    if (!geometry.boundingSphere) geometry.computeBoundingSphere();
    sphere.copy(geometry.boundingSphere).applyMatrix4(mesh.matrixWorld);
    if (worldRay.intersectsSphere(sphere))
      candidates.push([sphere.radius, mesh]);
  }
  candidates.sort((x, y) => x[0] - y[0]);
  let limit = Infinity;
  let nearest = Infinity;
  for (const [radius, mesh] of candidates) {
    if (radius > limit) break;
    const distance = meshHitDistance(mesh, ray.far);
    if (!Number.isFinite(distance)) continue;
    if (limit === Infinity) limit = 1.5 * radius;
    nearest = Math.min(nearest, distance);
  }
  return nearest;
}

/**
 * @param {{ sampleTerrainHeight: (place: { lat: number, lng: number }) => number | undefined }} view
 * @param {{
 *   tileRoots: () => object[],
 *   isIdle: () => boolean,
 *   retainTileGeometry: () => void,
 * }} hooks Navara internals (internals.js).
 * @returns {{ surface: import('../contract.js').GlobeSurface }}
 */
export function createNavaraSurface(view, hooks) {
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
  const sampleHeight = (place, exclude) => {
    if (!supported) return undefined;
    const ray = surfaceRay(place);
    const { shown, hidden } = tileMeshes(
      hooks.tileRoots(),
      new Set(exclude ?? []),
    );
    // The tiles on screen first; where they do not reach (the ground under
    // a camera looking ahead is outside the frustum), the loaded hidden ones.
    let distance = nearestHit(shown, ray);
    if (!Number.isFinite(distance)) distance = finestHit(hidden, ray);
    return heightAlongRay(ray, distance) ?? terrainHeight(place);
  };
  return {
    surface: {
      sampleHeight,
      supported,
      terrainHeight,
      terrainHeightSupported: true,
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
