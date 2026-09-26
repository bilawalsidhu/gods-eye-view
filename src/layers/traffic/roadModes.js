import { createFlowSegmentIndex } from '../../data/flowMatch.js';

/**
 * @file Street Traffic road-source modes: which geometry the dots run on.
 *
 * - `tomtom`: TomTom flow-tile lines only, each coloured by its own flow.
 * - `osm`: OpenFreeMap (OpenStreetMap) lines, TomTom flow matched onto them.
 * - `hybrid`: TomTom lines where TomTom has a road, OpenFreeMap lines only
 *   where it does not (simulated).
 *
 * Pure and Cesium-free so selection and dedupe are unit-testable.
 *
 * @module layers/traffic/roadModes
 */

export const TRAFFIC_ROAD_MODES = Object.freeze(['tomtom', 'osm', 'hybrid']);

/** Status-line names for the geometry each mode draws. */
export const ROAD_SOURCE_LABELS = Object.freeze({
  tomtom: 'TomTom',
  osm: 'OpenStreetMap',
  hybrid: 'TomTom + OpenStreetMap',
});

/** Sample spacing along OpenFreeMap roads when testing TomTom overlap. */
const DEDUPE_STEP_M = 10;
/** A partly duplicated road keeps only uncovered stretches at least this long. */
const MIN_FILL_M = 40;
/**
 * Overlap radius when exactly one side is a controlled-access road
 * (motorway/trunk mainline) and the other is not. The same road drawn by
 * both sources agrees within a few metres (z12 flow tiles quantize to about
 * 2.4 m), while frontage and service roads beside a freeway run 20-40 m
 * from its line; 15 m keeps the first a duplicate and the second a road.
 * Same-class overlap keeps the full 35 m matcher radius.
 */
const CLASS_MISMATCH_RADIUS_M = 15;
const CONTROLLED_ACCESS_FLOW = new Set(['Motorway', 'International road']);
const CONTROLLED_ACCESS_OSM = new Set(['motorway', 'trunk']);

/**
 * Validate an explicit choice.
 * @param {*} value - Candidate mode.
 * @returns {'tomtom'|'osm'|'hybrid'|null} Null means "use the default".
 */
export function normalizeRoadMode(value) {
  return TRAFFIC_ROAD_MODES.includes(value) ? value : null;
}

/**
 * Resolve the mode actually drawn. Without a TomTom key every choice draws
 * OpenStreetMap roads; with one, an explicit choice wins over Hybrid.
 * @param {*} value - Requested mode (null for the default).
 * @param {boolean} hasKey - The server reported a TomTom key.
 * @returns {'tomtom'|'osm'|'hybrid'}
 */
export function resolveRoadMode(value, hasKey) {
  return hasKey ? normalizeRoadMode(value) || 'hybrid' : 'osm';
}

const FLOW_ROAD_TYPES = Object.freeze({
  Motorway: 'motorway',
  'International road': 'trunk',
  'Major road': 'primary',
  'Secondary road': 'secondary',
  'Connecting road': 'tertiary',
  'Major local road': 'tertiary',
  'Local road': 'residential',
  'Minor local road': 'residential',
});

/**
 * Convert decoded TomTom flow lines into road records that carry their own
 * flow. A line with `coverage: 'full'` describes both travel directions;
 * `one_side` lines describe the direction they are drawn in.
 * @param {Array<{coords:number[][], trafficLevel:number, roadType:string, closure:boolean, coverage?:string}>} segments
 * @returns {Array<object>} Road records (`directFlow: true`).
 */
export function flowSegmentsToRoads(segments) {
  return (segments || [])
    .filter((segment) => segment?.coords?.length >= 2)
    .map((segment) => ({
      coordinates: segment.coords,
      type: FLOW_ROAD_TYPES[segment.roadType] || 'unclassified',
      oneway: segment.coverage === 'full' ? 0 : 1,
      flow: { level: segment.trafficLevel, closure: segment.closure === true },
      directFlow: true,
    }));
}

/** Cut a projected polyline to the arc-length interval [from, to]. */
function slicePolyline(coords, cum, from, to) {
  const out = [];
  const at = (i, distance) => {
    const span = cum[i + 1] - cum[i] || 1;
    const t = (distance - cum[i]) / span;
    return [
      coords[i][0] + (coords[i + 1][0] - coords[i][0]) * t,
      coords[i][1] + (coords[i + 1][1] - coords[i][1]) * t,
    ];
  };
  for (let i = 0; i < coords.length - 1; i++) {
    if (cum[i + 1] < from || cum[i] > to) continue;
    if (!out.length) out.push(cum[i] >= from ? coords[i] : at(i, from));
    if (cum[i + 1] <= to) out.push(coords[i + 1]);
    else {
      out.push(at(i, to));
      break;
    }
  }
  return out.length >= 2 ? out : null;
}

/**
 * Stretches of one travel direction of an OpenFreeMap road that no TomTom
 * line covers. A sample is covered when a TomTom line lies within the flow
 * matcher's 35 m radius (15 m across a controlled-access class mismatch)
 * and agrees with its travel bearing (30 degrees).
 * Flow values are ignored: any geometric overlap counts, so an uncertain
 * duplicate is dropped from OpenFreeMap, never from TomTom.
 * @returns {number[][][]|'all'} Uncovered polylines, or 'all' when untouched.
 */
function uncoveredStretches(coords, direction, index, radiusFor) {
  const xs = [],
    ys = [],
    cum = [0];
  for (let i = 0; i < coords.length; i++) {
    const [x, y] = index.project(coords[i][0], coords[i][1]);
    xs.push(x);
    ys.push(y);
    if (i) cum.push(cum[i - 1] + Math.hypot(x - xs[i - 1], y - ys[i - 1]));
  }
  const length = cum[cum.length - 1];
  if (!(length > 0)) return [];
  const count = Math.max(2, Math.ceil(length / DEDUPE_STEP_M));
  const step = length / count;
  const runs = [];
  let runStart = null;
  let cursor = 1;
  for (let s = 0; s < count; s++) {
    const target = (s + 0.5) * step;
    while (cursor < coords.length - 1 && cum[cursor] < target) cursor++;
    const t = (target - cum[cursor - 1]) / (cum[cursor] - cum[cursor - 1] || 1);
    const dx = xs[cursor] - xs[cursor - 1];
    const dy = ys[cursor] - ys[cursor - 1];
    const bearing =
      (Math.atan2(dx, dy) * 180) / Math.PI + (direction === -1 ? 180 : 0);
    const covered = Boolean(
      index.nearest(
        xs[cursor - 1] + dx * t,
        ys[cursor - 1] + dy * t,
        bearing,
        radiusFor,
      ).best,
    );
    if (!covered && runStart === null) runStart = s;
    if (covered && runStart !== null) {
      runs.push([runStart * step, s * step]);
      runStart = null;
    }
  }
  if (runStart === 0) return 'all';
  if (runStart !== null) runs.push([runStart * step, length]);
  return runs
    .filter(([from, to]) => to - from >= MIN_FILL_M)
    .map(([from, to]) => slicePolyline(coords, cum, from, to))
    .filter(Boolean);
}

/**
 * Build the Hybrid OpenFreeMap fill for a set of TomTom flow lines: every
 * OpenFreeMap road or travel direction that TomTom does not already draw,
 * marked simulated. Returns a function so callers can memoize per road.
 * @param {Array<object>} segments - Decoded TomTom flow lines.
 * @returns {(road:object) => Array<object>} Fill records for one OSM road.
 */
export function createHybridFill(segments) {
  const index = createFlowSegmentIndex(segments);
  return (road) => {
    const coords = road?.coordinates;
    if (!Array.isArray(coords) || coords.length < 2) return [];
    const fill = { ...road, simulatedOnly: true };
    if (!index) return [fill];
    // Ramps leave the mainline, so they compare as ordinary roads.
    const controlled = CONTROLLED_ACCESS_OSM.has(road.type) && !road.ramp;
    const radiusFor = (segment) =>
      CONTROLLED_ACCESS_FLOW.has(segment.roadType) === controlled
        ? Infinity
        : CLASS_MISMATCH_RADIUS_M;
    const directions = road.oneway ? [road.oneway] : [1, -1];
    const stretches = directions.map((direction) =>
      uncoveredStretches(coords, direction, index, radiusFor),
    );
    if (stretches.every((result) => result === 'all')) return [fill];
    return directions.flatMap((direction, i) =>
      (stretches[i] === 'all' ? [coords] : stretches[i]).map((piece) => ({
        ...fill,
        coordinates: piece,
        oneway: direction,
        // A two-way road's single direction keeps its half share of dots.
        densityWeight: road.oneway ? 1 : 0.5,
      })),
    );
  };
}

/**
 * Select the roads a mode draws from already-fetched inputs.
 * @param {Array<object>} osmRoads - OpenFreeMap road records.
 * @param {Array<object>} segments - Decoded TomTom flow lines.
 * @param {'tomtom'|'osm'|'hybrid'} mode - Resolved mode.
 * @returns {Array<object>} Road records for `parseRoads`.
 */
export function selectTrafficRoads(osmRoads, segments, mode) {
  if (mode === 'osm') return osmRoads;
  const tomtom = flowSegmentsToRoads(segments);
  if (mode === 'tomtom') return tomtom;
  const fill = createHybridFill(segments);
  return [...tomtom, ...osmRoads.flatMap(fill)];
}
