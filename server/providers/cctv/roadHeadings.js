/**
 * Turn OSM way geometry into a road axis, for packs whose upstream publishes
 * no camera bearing.
 *
 * These functions are pure and fetch nothing; the lookup belongs to an offline
 * precompute under `scripts/`. `server/providers/cctv` may not import the
 * overpass package (check:boundaries), and one `around` query per camera on
 * every catalog refresh is the API sweep the Overpass usage policy asks heavy
 * consumers to replace with a local extract.
 */
import {
  ROAD_HEADING_MATCH_RADIUS_M,
  ROAD_HEADING_HIGHWAY_FILTER,
  ROAD_HEADING_QL_TIMEOUT_S,
} from './constants.js';
import { directionToHeading } from '../../../src/data/directionText.js';

/**
 * Initial great-circle bearing from one point to another, in degrees [0..360).
 *
 * @param {{lat:number, lon:number}} from
 * @param {{lat:number, lon:number}} to
 * @returns {number}
 */
export function bearingDeg(from, to) {
  const rad = (deg) => (deg * Math.PI) / 180;
  const dLon = rad(to.lon - from.lon);
  const y = Math.sin(dLon) * Math.cos(rad(to.lat));
  const x =
    Math.cos(rad(from.lat)) * Math.sin(rad(to.lat)) -
    Math.sin(rad(from.lat)) * Math.cos(rad(to.lat)) * Math.cos(dLon);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

/**
 * Squared distance in metres from a point to a segment, on a local
 * equirectangular projection. Squared because only ordering matters.
 *
 * @param {{lat:number, lon:number}} point
 * @param {{lat:number, lon:number}} a - Segment start.
 * @param {{lat:number, lon:number}} b - Segment end.
 * @returns {number}
 */
export function segmentDistanceSqM(point, a, b) {
  const mPerDegLat = 111320;
  const mPerDegLon = mPerDegLat * Math.cos((point.lat * Math.PI) / 180);
  const px = (point.lon - a.lon) * mPerDegLon;
  const py = (point.lat - a.lat) * mPerDegLat;
  const bx = (b.lon - a.lon) * mPerDegLon;
  const by = (b.lat - a.lat) * mPerDegLat;
  const lenSq = bx * bx + by * by;
  // A zero-length segment is just its start point.
  const t =
    lenSq > 0 ? Math.max(0, Math.min(1, (px * bx + py * by) / lenSq)) : 0;
  const dx = px - bx * t;
  const dy = py - by * t;
  return dx * dx + dy * dy;
}

/**
 * Axis of the road nearest one camera, or null when nothing is close enough.
 *
 * Uses the nearest SEGMENT, not the way as a whole: a way can run for
 * kilometres and curve through 90 degrees, so its endpoint-to-endpoint bearing
 * describes the corridor rather than the stretch the camera overlooks.
 *
 * @param {{lat:number, lon:number}} camera
 * @param {Array<{geometry:Array<{lat:number,lon:number}>}>} ways
 * @param {number} [radiusM]
 * @returns {?number} Bearing in degrees [0..360), or null.
 */
export function nearestRoadAxis(
  camera,
  ways,
  radiusM = ROAD_HEADING_MATCH_RADIUS_M,
) {
  let bestDistSq = radiusM * radiusM;
  let bestAxis = null;
  for (const way of Array.isArray(ways) ? ways : []) {
    const geometry = Array.isArray(way?.geometry) ? way.geometry : [];
    for (let i = 0; i < geometry.length - 1; i++) {
      const a = geometry[i];
      const b = geometry[i + 1];
      if (!Number.isFinite(a?.lat) || !Number.isFinite(b?.lat)) continue;
      const distSq = segmentDistanceSqM(camera, a, b);
      if (distSq >= bestDistSq) continue;
      bestDistSq = distSq;
      bestAxis = bearingDeg(a, b);
    }
  }
  return bestAxis;
}

/**
 * Resolve the 180-degree ambiguity in a road axis.
 *
 * An axis says which LINE the camera looks along, never which way down it. A
 * travel bearing in the name ("I-80: Kearney WB DMS") picks the matching end;
 * otherwise the id-hash prior chooses the nearer one, which keeps co-sited
 * masts fanned apart while still putting every cone along the roadway.
 *
 * @param {number} axisDeg - Bearing of the nearest road segment.
 * @param {string} name - Camera title.
 * @param {number} priorDeg - Existing heading prior.
 * @returns {number} Bearing in degrees [0..360).
 */
export function resolveAxisDirection(axisDeg, name, priorDeg) {
  const opposite = (axisDeg + 180) % 360;
  const angleBetween = (a, b) => {
    const diff = Math.abs(((a - b + 540) % 360) - 180);
    return diff;
  };

  // Only a standalone EB/WB/NB/SB token is a travel bearing; "E of Lincoln"
  // and "3 Mi W of Kimball" are positional and must never steer a facing.
  const travel = /\b(EB|WB|NB|SB)\b/.exec(String(name || ''))?.[1];
  if (travel) {
    // Whole token: directionToHeading knows "WB" but not a bare "W".
    const wanted = directionToHeading(travel, true);
    if (Number.isFinite(wanted)) {
      return angleBetween(axisDeg, wanted) <= angleBetween(opposite, wanted)
        ? axisDeg
        : opposite;
    }
  }

  if (!Number.isFinite(priorDeg)) return axisDeg;
  return angleBetween(axisDeg, priorDeg) <= angleBetween(opposite, priorDeg)
    ? axisDeg
    : opposite;
}

/**
 * Stable key for where a camera sits, used to expire a shipped heading.
 *
 * A precomputed bearing describes one mast at one spot, so a moved or reused
 * id must drop its entry rather than aim with stale geometry. Five decimals is
 * ~1 m: finer than the placement is meaningful, coarse enough that float noise
 * in the feed does not churn the table.
 *
 * @param {{lat:number, lon:number}} camera
 * @returns {string}
 */
export function positionKey(camera) {
  const lat = Number(camera?.lat);
  const lon = Number(camera?.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return '';
  return `${lat.toFixed(5)},${lon.toFixed(5)}`;
}

/**
 * Overpass QL asking for every road near any of these cameras.
 *
 * A union of independent `around` clauses, one per camera. NOT the
 * `around:r,lat1,lon1,lat2,lon2,...` list form: Overpass reads that as a
 * polyline and matches within r of the path joining the points, which for
 * scattered cameras is both wrong and pathologically slow.
 *
 * @param {Array<{lat:number, lon:number}>} cameras
 * @param {number} [radiusM]
 * @returns {string} URL-encoded request body.
 */
export function buildRoadQuery(cameras, radiusM = ROAD_HEADING_MATCH_RADIUS_M) {
  const clauses = cameras
    .map(
      (camera) =>
        `way(around:${radiusM},${camera.lat.toFixed(6)},${camera.lon.toFixed(6)})` +
        `${ROAD_HEADING_HIGHWAY_FILTER};`,
    )
    .join('');
  const ql =
    `[out:json][timeout:${ROAD_HEADING_QL_TIMEOUT_S}];` +
    `(${clauses});` +
    `out geom;`;
  return `data=${encodeURIComponent(ql)}`;
}
