/**
 * @file Flow→road matching: assign TomTom congestion levels to OpenStreetMap roads.
 *
 * In OpenStreetMap road mode the layer renders OpenFreeMap polylines, while
 * TomTom flow tiles carry their own (differently segmented) polylines with
 * `traffic_level`. This module snaps flow onto roads geometrically:
 *
 *  1. Every flow polyline is exploded into consecutive coord-pair SEGMENTS
 *     (pairs longer than one cell are subdivided so midpoint hashing can't
 *     miss their extremities) and hashed by midpoint into ~100 m grid cells,
 *     projected to local meters (degree cell size cos(lat)-adjusted).
 *  2. Each road is sampled at up to 7 evenly-spaced points along its length;
 *     each sample looks for the nearest flow segment within 35 m whose
 *     bearing agrees with the road travel direction within 30°. Two-way
 *     roads are represented as separate travel directions by the layer. A
 *     flow line whose `coverage` is `full` describes both directions of its
 *     road, so either travel bearing may match it.
 *  3. A road matches when at least half its samples (minimum 2) matched; its
 *     level is the MEDIAN of the matched samples' trafficLevels, and closure
 *     is true if ANY matched segment is closed.
 *
 * Pure and Cesium-free: inputs are plain [[lon,lat],…] polylines, so the
 * whole pipeline is unit-testable with synthetic geometry.
 *
 * @module data/flowMatch
 */

/** @const {number} Meters per degree of latitude (spherical approximation). */
const M_PER_DEG_LAT = 111320;
/** @const {number} Spatial-hash cell size in meters (~100 m per spec). */
const CELL_SIZE_M = 100;
/** @const {number} Max snap distance from a road sample to a flow segment. */
const MATCH_RADIUS_M = 35;
/** @const {number} Max travel-bearing disagreement (degrees). */
const BEARING_TOLERANCE_DEG = 30;
/** @const {number} Evenly-spaced samples per road. */
const ROAD_SAMPLES = 7;
/** @const {number} Minimum matched samples for a road to count as matched. */
const MIN_MATCHED_SAMPLES = 2;

/**
 * Median of a numeric array (even count averages the two middles).
 * @param {number[]} values
 * @returns {number|null} Median, or null for an empty array.
 */
export function median(values) {
  if (!Array.isArray(values) || values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Bearing (degrees, 0 = north, clockwise) of a projected dx/dy vector. */
function bearingDeg(dx, dy) {
  return (Math.atan2(dx, dy) * 180) / Math.PI;
}

/**
 * Travel-bearing disagreement; opposing flow never matches.
 * @param {number} a - Bearing (degrees). @param {number} b - Bearing (degrees).
 * @returns {number} Angular difference in [0, 180].
 */
function bearingDiffDeg(a, b) {
  let d = Math.abs(a - b) % 360;
  if (d > 180) d = 360 - d;
  return d;
}

/** Squared distance from point (px,py) to segment (ax,ay)-(bx,by), meters². */
function pointSegDist2(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const qx = ax + t * dx;
  const qy = ay + t * dy;
  return (px - qx) * (px - qx) + (py - qy) * (py - qy);
}

/**
 * Index flow polylines for nearest-segment queries in local meters.
 *
 * Shared by congestion matching and the Hybrid road-source dedupe, so both
 * use one distance, bearing and direction rule.
 *
 * @param {Array<{coords:number[][], trafficLevel:number, closure:boolean, coverage?:string}>} flowSegments
 * @returns {null|{
 *   project: (lon:number, lat:number) => [number, number],
 *   nearest: (x:number, y:number, bearing:number, radiusFor?:(segment:object) => number) => {best:object|null, ambiguous:boolean, candidate:boolean},
 * }} Null when no usable segment exists.
 */
export function createFlowSegmentIndex(flowSegments) {
  if (!Array.isArray(flowSegments)) return null;
  // Local equirectangular projection anchored at the first flow coordinate —
  // over a ≤0.05° fetch box the distortion is negligible.
  const anchor = flowSegments.find(
    (f) => Array.isArray(f?.coords) && f.coords.length >= 2,
  );
  if (!anchor) return null;
  const [refLon, refLat] = anchor.coords[0];
  const mPerDegLon = M_PER_DEG_LAT * Math.cos((refLat * Math.PI) / 180);
  const project = (lon, lat) => [
    (lon - refLon) * mPerDegLon,
    (lat - refLat) * M_PER_DEG_LAT,
  ];

  // Spatial hash of flow segments (midpoint-keyed 100 m cells).
  const grid = new Map();
  const cellKey = (cx, cy) => (cx + 0x8000) * 0x10000 + (cy + 0x8000);
  for (const flow of flowSegments) {
    const coords = flow?.coords;
    if (!Array.isArray(coords) || coords.length < 2) continue;
    const level = flow.trafficLevel;
    const closure = flow.closure === true;
    const bothDirections = flow.coverage === 'full';
    const roadType = flow.roadType;
    for (let i = 0; i < coords.length - 1; i++) {
      const [ax, ay] = project(coords[i][0], coords[i][1]);
      const [bx, by] = project(coords[i + 1][0], coords[i + 1][1]);
      const segLen = Math.hypot(bx - ax, by - ay);
      if (!(segLen > 0)) continue;
      const bearing = bearingDeg(bx - ax, by - ay);
      // Subdivide long pairs so every piece is ≤ one cell — midpoint hashing
      // then guarantees a 3×3 cell probe sees everything within 35 m.
      const pieces = Math.max(1, Math.ceil(segLen / CELL_SIZE_M));
      for (let p = 0; p < pieces; p++) {
        const t0 = p / pieces;
        const t1 = (p + 1) / pieces;
        const seg = {
          ax: ax + (bx - ax) * t0,
          ay: ay + (by - ay) * t0,
          bx: ax + (bx - ax) * t1,
          by: ay + (by - ay) * t1,
          bearing,
          bothDirections,
          roadType,
          level,
          closure,
        };
        const key = cellKey(
          Math.floor((seg.ax + seg.bx) / 2 / CELL_SIZE_M),
          Math.floor((seg.ay + seg.by) / 2 / CELL_SIZE_M),
        );
        let bucket = grid.get(key);
        if (!bucket) {
          bucket = [];
          grid.set(key, bucket);
        }
        bucket.push(seg);
      }
    }
  }
  if (grid.size === 0) return null;

  const radius2 = MATCH_RADIUS_M * MATCH_RADIUS_M;
  /**
   * Nearest direction-compatible segment within 35 m of a projected point.
   * `radiusFor(segment)` may tighten the radius per segment (never widen it).
   */
  function nearest(px, py, bearing, radiusFor = null) {
    const cx = Math.floor(px / CELL_SIZE_M);
    const cy = Math.floor(py / CELL_SIZE_M);
    let best = null;
    let bestDist2 = radius2;
    let ambiguous = false;
    let candidate = false;
    for (let gy = cy - 1; gy <= cy + 1; gy++) {
      for (let gx = cx - 1; gx <= cx + 1; gx++) {
        const bucket = grid.get(cellKey(gx, gy));
        if (!bucket) continue;
        for (const seg of bucket) {
          const d2 = pointSegDist2(px, py, seg.ax, seg.ay, seg.bx, seg.by);
          if (d2 > radius2) continue;
          candidate = true; // within radius, bearing not yet checked
          if (radiusFor) {
            const radius = Math.min(MATCH_RADIUS_M, radiusFor(seg));
            if (d2 > radius * radius) continue;
          }
          const diff = bearingDiffDeg(seg.bearing, bearing);
          if (
            diff >= BEARING_TOLERANCE_DEG &&
            !(seg.bothDirections && 180 - diff < BEARING_TOLERANCE_DEG)
          )
            continue;
          if (d2 < bestDist2 - 1) {
            bestDist2 = d2;
            best = seg;
            ambiguous = false;
          } else if (Math.abs(d2 - bestDist2) <= 1) {
            if (
              best &&
              (best.level !== seg.level || best.closure !== seg.closure)
            )
              ambiguous = true;
            else if (!best) best = seg;
          }
        }
      }
    }
    return { best, ambiguous, candidate };
  }
  return { project, nearest };
}

/**
 * Match flow segments onto roads.
 *
 * @param {Array<{coords:number[][], type:string, oneway?:number}>} roads
 *   Parsed OpenStreetMap road objects ([[lon,lat],…] polylines).
 * @param {Array<{coords:number[][], trafficLevel:number, roadType:string, closure:boolean, coverage?:string}>} flowSegments
 *   Decoded flow polylines from `flowDecode.js`.
 * @returns {{
 *   matches: Array<{level:number, closure:boolean}|null>,
 *   matchedCount: number,
 *   candidateCount: number,
 * }}
 *   `matches` is PARALLEL to `roads` (index i describes roads[i]; null = no
 *   flow data for that road, render it exactly as today). `candidateCount` is
 *   the number of roads with at least one flow segment inside the 35 m search
 *   radius regardless of bearing before bearing rejection.
 */
export function matchFlowToRoads(roads, flowSegments) {
  const roadCount = Array.isArray(roads) ? roads.length : 0;
  const matches = new Array(roadCount).fill(null);
  const empty = { matches, matchedCount: 0, candidateCount: 0 };
  if (roadCount === 0) return empty;
  const index = createFlowSegmentIndex(flowSegments);
  if (!index) return empty;

  let matchedCount = 0;
  let candidateCount = 0;

  // Sample each road and vote.
  for (let r = 0; r < roadCount; r++) {
    const coords = roads[r]?.coords;
    if (!Array.isArray(coords) || coords.length < 2) continue;

    // Project the road once; accumulate arc length for even sampling.
    const xs = new Array(coords.length);
    const ys = new Array(coords.length);
    const cum = new Array(coords.length);
    cum[0] = 0;
    for (let i = 0; i < coords.length; i++) {
      [xs[i], ys[i]] = index.project(coords[i][0], coords[i][1]);
      if (i > 0)
        cum[i] = cum[i - 1] + Math.hypot(xs[i] - xs[i - 1], ys[i] - ys[i - 1]);
    }
    const totalLen = cum[coords.length - 1];
    if (!(totalLen > 0)) continue;

    let hadCandidate = false;
    const matchedLevels = [];
    let matchedClosure = false;

    let cursor = 1; // cum[] is monotonic; samples advance monotonically too
    for (let s = 0; s < ROAD_SAMPLES; s++) {
      // Midpoint-biased fractions keep samples off road endpoints, where
      // cross-street flow lines meet at intersections.
      const target = (totalLen * (s + 0.5)) / ROAD_SAMPLES;
      while (cursor < coords.length - 1 && cum[cursor] < target) cursor++;
      const segT =
        (target - cum[cursor - 1]) / (cum[cursor] - cum[cursor - 1] || 1);
      const px = xs[cursor - 1] + (xs[cursor] - xs[cursor - 1]) * segT;
      const py = ys[cursor - 1] + (ys[cursor] - ys[cursor - 1]) * segT;
      const sampleBearing =
        (roads[r].oneway === -1 ? 180 : 0) +
        bearingDeg(xs[cursor] - xs[cursor - 1], ys[cursor] - ys[cursor - 1]);

      const { best, ambiguous, candidate } = index.nearest(
        px,
        py,
        sampleBearing,
      );
      if (candidate) hadCandidate = true;
      if (best && !ambiguous) {
        matchedLevels.push(best.level);
        if (best.closure) matchedClosure = true;
      }
    }

    if (hadCandidate) candidateCount++;
    if (
      matchedLevels.length >= Math.max(MIN_MATCHED_SAMPLES, ROAD_SAMPLES / 2)
    ) {
      matches[r] = { level: median(matchedLevels), closure: matchedClosure };
      matchedCount++;
    }
  }

  return { matches, matchedCount, candidateCount };
}
