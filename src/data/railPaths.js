/**
 * @module railPaths
 * @description Track geometry for the Rail layer: a railway line as an indexed
 * polyline measured by arc length, with projection of a position onto it and
 * the point at a given arc length.
 *
 * Paths come from per-feed path packs (scripts/build-rail-paths.mjs), served by
 * `/api/rail/paths/<feedId>`. A pack holds each unique shape as a flat
 * `[lat, lon, lat, lon, ...]` array with its cumulative distances in metres.
 *
 * Distances are measured in one local equirectangular frame per path, centred
 * on the path's middle latitude. Over the extent of a commuter network (a few
 * hundred kilometres) the east-west scale error stays within a few per cent,
 * which moves a projection by metres, well under what a marker shows.
 *
 * Pure: no Cesium, no DOM, no Node built-ins.
 */

/** Metres per degree of latitude (and of longitude at the equator). */
const M_PER_DEG = 111_320;
/** Segments per bounding box in the whole-path search index. */
const CHUNK = 32;

/** Longitude difference wrapped into (-180, 180]. */
function wrapLon(delta) {
  return ((((delta + 180) % 360) + 360) % 360) - 180;
}

/**
 * Build an indexed path from a flat lat/lon array.
 * @param {ArrayLike<number>} coords `[lat, lon, lat, lon, ...]`, at least two points.
 * @param {ArrayLike<number>} [dist] Cumulative metres per point. When absent,
 *   wrong-sized or decreasing, the distances are measured in the local frame.
 * @returns {object|null} The path, or null when the input is not a polyline.
 */
export function createRailPath(coords, dist = null) {
  const n = Math.floor((coords?.length ?? 0) / 2);
  if (n < 2) return null;
  const lat = new Float64Array(n);
  const lon = new Float64Array(n);
  let minLat = Infinity;
  let maxLat = -Infinity;
  for (let i = 0; i < n; i++) {
    const a = Number(coords[2 * i]);
    const o = Number(coords[2 * i + 1]);
    if (!Number.isFinite(a) || !Number.isFinite(o) || Math.abs(a) > 90)
      return null;
    lat[i] = a;
    lon[i] = o;
    if (a < minLat) minLat = a;
    if (a > maxLat) maxLat = a;
  }
  const lat0 = (minLat + maxLat) / 2;
  const lon0 = lon[0];
  const kx = M_PER_DEG * Math.cos((lat0 * Math.PI) / 180);
  const ky = M_PER_DEG;
  const x = new Float64Array(n);
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    x[i] = wrapLon(lon[i] - lon0) * kx;
    y[i] = (lat[i] - lat0) * ky;
  }
  const s = new Float64Array(n);
  let given = dist?.length === n && Number(dist[0]) >= 0;
  for (let i = 0; given && i < n; i++) {
    const d = Number(dist[i]);
    if (!Number.isFinite(d) || (i > 0 && d < s[i - 1])) given = false;
    else s[i] = d;
  }
  if (!given) {
    s[0] = 0;
    for (let i = 1; i < n; i++)
      s[i] = s[i - 1] + Math.hypot(x[i] - x[i - 1], y[i] - y[i - 1]);
  }
  const chunks = Math.ceil((n - 1) / CHUNK);
  const box = new Float64Array(chunks * 4);
  for (let c = 0; c < chunks; c++) {
    let x0 = Infinity;
    let x1 = -Infinity;
    let y0 = Infinity;
    let y1 = -Infinity;
    const end = Math.min(n - 1, (c + 1) * CHUNK);
    for (let i = c * CHUNK; i <= end; i++) {
      if (x[i] < x0) x0 = x[i];
      if (x[i] > x1) x1 = x[i];
      if (y[i] < y0) y0 = y[i];
      if (y[i] > y1) y1 = y[i];
    }
    box[4 * c] = x0;
    box[4 * c + 1] = x1;
    box[4 * c + 2] = y0;
    box[4 * c + 3] = y1;
  }
  return Object.freeze({
    n,
    lat,
    lon,
    x,
    y,
    s,
    box,
    lat0,
    lon0,
    kx,
    ky,
    length: s[n - 1],
  });
}

/** Index of the segment [i, i+1] whose arc range holds `s`, clamped. */
function segmentAt(path, s) {
  const arc = path.s;
  let lo = 0;
  let hi = path.n - 2;
  if (!(s > arc[0])) return 0;
  if (s >= arc[hi + 1]) return hi;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (arc[mid] <= s) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * Squared distance from (px, py) to segment i, writing the parameter to `hit`.
 * @returns {number}
 */
function segmentDistance2(path, i, px, py, hit) {
  const { x, y } = path;
  const dx = x[i + 1] - x[i];
  const dy = y[i + 1] - y[i];
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((px - x[i]) * dx + (py - y[i]) * dy) / len2 : 0;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  const ex = x[i] + dx * t - px;
  const ey = y[i] + dy * t - py;
  hit.t = t;
  return ex * ex + ey * ey;
}

/**
 * Project a position onto a path.
 *
 * With a hint, only the segments whose arc range overlaps
 * `[hintS - windowM, hintS + windowM]` are searched: a train known to be near
 * arc `hintS` cannot jump to the far side of a loop or to a parallel branch
 * that the same shape passes later. Without one, the whole path is searched.
 *
 * @param {object} path From createRailPath.
 * @param {number} lat
 * @param {number} lon
 * @param {number} [hintS] Expected arc length (m).
 * @param {number} [windowM] Half-width of the search window around the hint (m).
 * @param {{s?: number, offsetM?: number, index?: number}} [out]
 * @returns {{s: number, offsetM: number, index: number}|null}
 */
export function projectOnPath(path, lat, lon, hintS, windowM, out = {}) {
  if (!path || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const px = wrapLon(lon - path.lon0) * path.kx;
  const py = (lat - path.lat0) * path.ky;
  const hit = { t: 0 };
  let best = Infinity;
  let bestIndex = -1;
  let bestT = 0;
  if (Number.isFinite(hintS) && Number.isFinite(windowM) && windowM >= 0) {
    const first = segmentAt(path, hintS - windowM);
    const last = segmentAt(path, hintS + windowM);
    for (let i = first; i <= last; i++) {
      const d2 = segmentDistance2(path, i, px, py, hit);
      if (d2 < best) {
        best = d2;
        bestIndex = i;
        bestT = hit.t;
      }
    }
  } else {
    const { box } = path;
    const chunks = box.length / 4;
    for (let c = 0; c < chunks; c++) {
      const ox = Math.max(box[4 * c] - px, 0, px - box[4 * c + 1]);
      const oy = Math.max(box[4 * c + 2] - py, 0, py - box[4 * c + 3]);
      if (ox * ox + oy * oy >= best) continue;
      const end = Math.min(path.n - 2, (c + 1) * CHUNK - 1);
      for (let i = c * CHUNK; i <= end; i++) {
        const d2 = segmentDistance2(path, i, px, py, hit);
        if (d2 < best) {
          best = d2;
          bestIndex = i;
          bestT = hit.t;
        }
      }
    }
  }
  if (bestIndex < 0) return null;
  const s = path.s;
  out.s = s[bestIndex] + (s[bestIndex + 1] - s[bestIndex]) * bestT;
  out.offsetM = Math.sqrt(best);
  out.index = bestIndex;
  return out;
}

/**
 * The position and direction of travel at an arc length, clamped to the path.
 * @param {object} path From createRailPath.
 * @param {number} s Arc length (m).
 * @param {{lat?: number, lon?: number, bearingDeg?: number}} [out]
 * @returns {{lat: number, lon: number, bearingDeg: number}|null}
 */
export function pointAtS(path, s, out = {}) {
  if (!path || !Number.isFinite(s)) return null;
  const clamped = Math.max(0, Math.min(path.length, s));
  let i = segmentAt(path, clamped);
  // A zero-length segment has no direction; borrow its neighbour's.
  while (i < path.n - 2 && path.s[i + 1] === path.s[i]) i++;
  const span = path.s[i + 1] - path.s[i];
  const t =
    span > 0 ? Math.max(0, Math.min(1, (clamped - path.s[i]) / span)) : 0;
  out.lat = path.lat[i] + (path.lat[i + 1] - path.lat[i]) * t;
  let lon = path.lon[i] + wrapLon(path.lon[i + 1] - path.lon[i]) * t;
  if (lon > 180) lon -= 360;
  else if (lon < -180) lon += 360;
  out.lon = lon;
  const dx = path.x[i + 1] - path.x[i];
  const dy = path.y[i + 1] - path.y[i];
  out.bearingDeg =
    dx === 0 && dy === 0
      ? NaN
      : ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360;
  return out;
}

/** Path-pack format this module reads. */
export const RAIL_PATH_PACK_VERSION = 1;

/**
 * Wrap a decoded path pack for lookups. Shapes are indexed lazily, the first
 * time a train asks for one.
 * @param {object} raw The JSON body of `/api/rail/paths/<feedId>`.
 * @returns {{feedId: string, shapeCount: number,
 *   pathAt: (index: number) => object|null,
 *   shapeForTrip: (tripId: string) => number|null,
 *   shapesForRoute: (routeId: string) => number[]}}
 */
export function createRailPathPack(raw) {
  if (
    !raw ||
    raw.version !== RAIL_PATH_PACK_VERSION ||
    typeof raw.feedId !== 'string' ||
    !Array.isArray(raw.shapes) ||
    !Array.isArray(raw.dist) ||
    raw.dist.length !== raw.shapes.length
  )
    throw new TypeError('Malformed rail path pack');
  const shapes = raw.shapes;
  const dist = raw.dist;
  const trips = raw.trips && typeof raw.trips === 'object' ? raw.trips : {};
  const routes = raw.routes && typeof raw.routes === 'object' ? raw.routes : {};
  const built = new Map();
  const validIndex = (value) =>
    Number.isInteger(value) && value >= 0 && value < shapes.length
      ? value
      : null;
  return Object.freeze({
    feedId: raw.feedId,
    /** When the pack was built (ISO), matched by a schedule's pathsBuiltAt. */
    builtAt: typeof raw.builtAt === 'string' ? raw.builtAt : null,
    shapeCount: shapes.length,
    pathAt(index) {
      if (validIndex(index) === null) return null;
      if (!built.has(index))
        built.set(index, createRailPath(shapes[index], dist[index]));
      return built.get(index);
    },
    shapeForTrip(tripId) {
      const id = String(tripId ?? '');
      return id && Object.hasOwn(trips, id) ? validIndex(trips[id]) : null;
    },
    shapesForRoute(routeId) {
      const id = String(routeId ?? '');
      const list = id && Object.hasOwn(routes, id) ? routes[id] : null;
      return Array.isArray(list)
        ? list.filter((value) => validIndex(value) !== null)
        : [];
    },
  });
}
