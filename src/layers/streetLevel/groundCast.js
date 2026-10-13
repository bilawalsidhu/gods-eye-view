/**
 * Ground casting for street-level overlays on Google 3D. Draped overlays land
 * on the mesh top (trees, overpasses), so casting places them at bare-earth
 * (DEM) height plus a lift and lets the mesh hide what is behind buildings.
 * Heights come from a coarse grid shared with the ground-floor service; a
 * geoid fallback (terrain proxy down) counts as unknown and stays draped.
 */

import { wrapLon } from './tileMath.js';

/** Grid spacing in degrees (~111 m north-south): the ground-floor grid. */
export const GROUND_CAST_STEP_DEG = 0.001;
/** Longest line segment left undivided, in degrees, so lines follow the grid. */
export const GROUND_CAST_DENSIFY_DEG = 0.0005;
/** Metres above the bare earth, so lines sit on the road instead of in it. */
export const GROUND_CAST_LIFT_M = 2;
/** Grid corners one prepare call may request; more stays draped. */
export const GROUND_CAST_MAX_CORNERS = 1024;
/** Cached grid corners before the oldest are dropped to make room. */
const GROUND_CAST_CACHE_MAX = 50_000;

/**
 * Mesh refinement, where the Google 3D surface was sampled (the DEM grid
 * misses trenches, steep streets and roads under trees):
 *   - mesh up to MESH_ROAD_ABOVE_M above bare earth is the road: follow it;
 *   - higher mesh is over the road (canopy, deck): interpolate the road's
 *     offset from the nearest road samples on both sides;
 *   - otherwise bare earth plus GROUND_CAST_LIFT_M.
 */
export const MESH_ROAD_ABOVE_M = 3;
/** A sample this far below bare earth is a bad probe, not a road. */
export const MESH_ROAD_BELOW_M = 30;
/** Metres above the sampled road surface. */
export const MESH_LIFT_M = 1;
/** Longest run of covered points bridged from the road on either side. */
export const MESH_BRIDGE_MAX_POINTS = 8;
/** Line spacing, in degrees (~22 m), while the mesh refines heights. */
export const MESH_DENSIFY_DEG = 0.0002;

/**
 * Heights for a line's points by the rule above.
 * @param {Array<{dem: number, mesh?: number|null}>} points
 * @param {{lift?: number}} [options]
 * @returns {Array<number>}
 */
export function refineHeights(points, { lift = GROUND_CAST_LIFT_M } = {}) {
  const road = points.map(({ dem, mesh }) =>
    Number.isFinite(mesh) &&
    mesh <= dem + MESH_ROAD_ABOVE_M &&
    mesh >= dem - MESH_ROAD_BELOW_M
      ? mesh - dem
      : null,
  );
  return points.map(({ dem, mesh }, i) => {
    if (road[i] !== null) return dem + road[i] + MESH_LIFT_M;
    if (Number.isFinite(mesh) && mesh > dem + MESH_ROAD_ABOVE_M) {
      let a = i - 1;
      while (a >= 0 && i - a <= MESH_BRIDGE_MAX_POINTS && road[a] === null) a--;
      let b = i + 1;
      while (
        b < points.length &&
        b - i <= MESH_BRIDGE_MAX_POINTS &&
        road[b] === null
      )
        b++;
      const left = a >= 0 && i - a <= MESH_BRIDGE_MAX_POINTS ? road[a] : null;
      const right =
        b < points.length && b - i <= MESH_BRIDGE_MAX_POINTS ? road[b] : null;
      if (left !== null && right !== null) {
        const t = (i - a) / (b - a);
        return dem + left + (right - left) * t + MESH_LIFT_M;
      }
    }
    return dem + lift;
  });
}

/** Camera height (m above ground) below which Google 3D switches to terrain mode. */
export const SURFACE_TERRAIN_ENTER_M = 1400;
/** Camera height above which terrain mode switches back to draped. */
export const SURFACE_TERRAIN_EXIT_M = 1800;

/**
 * Next surface mode: terrain only on Google 3D at street zoom, with
 * hysteresis between the enter and exit heights.
 * @param {'draped'|'terrain'} current
 * @param {{photoreal: boolean, heightM: number|null, available: boolean}} view
 * @returns {'draped'|'terrain'}
 */
export function nextSurfaceMode(current, { photoreal, heightM, available }) {
  if (!available || !photoreal || !Number.isFinite(heightM)) return 'draped';
  if (current === 'terrain')
    return heightM > SURFACE_TERRAIN_EXIT_M ? 'draped' : 'terrain';
  return heightM < SURFACE_TERRAIN_ENTER_M ? 'terrain' : 'draped';
}

/**
 * Split long segments so a line follows the terrain. Segments across ±180°
 * go the short way round, with added points wrapped into [-180, 180].
 * @param {Array<[number, number]>} coords [lon, lat] pairs
 * @param {number} [maxStep] longest segment, in degrees
 * @returns {Array<[number, number]>}
 */
export function densifyLine(coords, maxStep = GROUND_CAST_DENSIFY_DEG) {
  if (!Array.isArray(coords) || coords.length < 2) return coords || [];
  const out = [coords[0]];
  for (let i = 1; i < coords.length; i++) {
    const [lon0, lat0] = coords[i - 1];
    const [lon1, lat1] = coords[i];
    const dLon = wrapLon(lon1 - lon0);
    const span = Math.max(Math.abs(dLon), Math.abs(lat1 - lat0));
    const parts = Math.min(64, Math.ceil(span / maxStep - 1e-9));
    for (let k = 1; k < parts; k++) {
      const t = k / parts;
      out.push([wrapLon(lon0 + dLon * t), lat0 + (lat1 - lat0) * t]);
    }
    out.push(coords[i]);
  }
  return out;
}

/**
 * A bare-earth height cache over the terrain service.
 * @param {{terrain: {resolveEllipsoidalGround: Function}, step?: number, lift?: number, maxCorners?: number, cacheMax?: number}} options
 */
export function createGroundCaster({
  terrain,
  step = GROUND_CAST_STEP_DEG,
  lift = GROUND_CAST_LIFT_M,
  maxCorners = GROUND_CAST_MAX_CORNERS,
  cacheMax = GROUND_CAST_CACHE_MAX,
}) {
  if (typeof terrain?.resolveEllipsoidalGround !== 'function')
    throw new TypeError('Ground casting requires a terrain service');
  /** "i,j" grid corner → ellipsoidal ground height in metres. */
  const heights = new Map();
  /** Prepares run one at a time, so neighbouring tiles share their corners. */
  let queue = Promise.resolve();

  const cornerKey = (i, j) => `${i},${j}`;

  function missingCorners(points) {
    const missing = new Map();
    for (const point of points) {
      const [lon, lat] = point;
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
      const i0 = Math.floor(lon / step);
      const j0 = Math.floor(lat / step);
      for (let di = 0; di <= 1; di++)
        for (let dj = 0; dj <= 1; dj++) {
          const key = cornerKey(i0 + di, j0 + dj);
          if (!heights.has(key) && !missing.has(key))
            missing.set(key, { i: i0 + di, j: j0 + dj });
        }
    }
    return [...missing.entries()];
  }

  async function resolve(points, signal) {
    if (signal?.aborted) return false;
    // Evict before counting, or we could drop corners this request counted
    // as cached. Oldest first, so the tiles still on screen keep theirs.
    for (const key of heights.keys()) {
      if (heights.size + maxCorners <= cacheMax) break;
      heights.delete(key);
    }
    const missing = missingCorners(points);
    if (!missing.length) return true;
    if (missing.length > maxCorners) return false;
    // A corner east of 180° is asked for at its wrapped longitude.
    const results = await terrain.resolveEllipsoidalGround(
      missing.map(([, { i, j }]) => ({
        lon: Number(wrapLon(i * step).toFixed(6)),
        lat: Number((j * step).toFixed(6)),
      })),
      { signal },
    );
    let complete = true;
    missing.forEach(([key], n) => {
      const result = results?.[n];
      if (result?.source === 'reearth' && Number.isFinite(result.ellipsoid))
        heights.set(key, result.ellipsoid);
      else complete = false;
    });
    return complete && !signal?.aborted;
  }

  /**
   * Fetch the grid corners around the points. True when all can be cast;
   * false when some are unknown, too many, or aborted. Never rejects.
   * @param {Array<[number, number]>} points [lon, lat] pairs
   * @param {{signal?: AbortSignal}} [options]
   */
  function prepare(points, { signal } = {}) {
    const run = queue.then(() => resolve(points, signal)).catch(() => false);
    queue = run;
    return run;
  }

  /**
   * `prepare` for lines at both densities: the finer mesh points can fall in
   * cells the coarse ones skip, and a missing cell leaves the line draped.
   */
  function prepareLines(lines, options) {
    return prepare(
      lines.flatMap((coords) => [
        ...densifyLine(coords),
        ...densifyLine(coords, MESH_DENSIFY_DEG),
      ]),
      options,
    );
  }

  /** Bare-earth ellipsoidal height at a point, from cached corners only; null when unknown. */
  function groundAt(lon, lat) {
    const x = lon / step;
    const y = lat / step;
    const i0 = Math.floor(x);
    const j0 = Math.floor(y);
    const h00 = heights.get(cornerKey(i0, j0));
    const h10 = heights.get(cornerKey(i0 + 1, j0));
    const h01 = heights.get(cornerKey(i0, j0 + 1));
    const h11 = heights.get(cornerKey(i0 + 1, j0 + 1));
    if (h00 === undefined || h10 === undefined) return null;
    if (h01 === undefined || h11 === undefined) return null;
    const fx = x - i0;
    const fy = y - j0;
    const south = h00 + (h10 - h00) * fx;
    const north = h01 + (h11 - h01) * fx;
    return south + (north - south) * fy;
  }

  /**
   * Densified line as flat [lon, lat, height, ...]; null until every corner is
   * cached. With `meshAt` it is densified finer and refined by `refineHeights`.
   * @param {Array<[number, number]>} coords
   * @param {{meshAt?: (lon: number, lat: number) => number|null|undefined}} [options]
   */
  function castLine(coords, { meshAt = null } = {}) {
    const rows = [];
    const points = meshAt
      ? densifyLine(coords, MESH_DENSIFY_DEG)
      : densifyLine(coords);
    for (const [lon, lat] of points) {
      const dem = groundAt(lon, lat);
      if (dem === null) return null;
      rows.push({ lon, lat, dem, mesh: meshAt ? meshAt(lon, lat) : null });
    }
    const heights = refineHeights(rows, { lift });
    const flat = [];
    rows.forEach(({ lon, lat }, i) => flat.push(lon, lat, heights[i]));
    return flat;
  }

  return { prepare, prepareLines, groundAt, castLine };
}
