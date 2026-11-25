import { t } from '../../i18n/index.js';
import { msg } from '../../i18n/marker.js';
import { flowBucket } from '../../data/trafficFlowStyle.js';
import { CONTEXT_LINES, contextLine } from '../../data/contextGeometry.js';
import { roadIdentity } from './retention.js';

/** A road's kind in words, by the layer's road type. */
const ROAD_WORDS = Object.freeze({
  motorway: msg('Motorway'),
  trunk: msg('Trunk road'),
  primary: msg('Major road'),
  secondary: msg('Secondary road'),
  tertiary: msg('Connecting road'),
  residential: msg('Local road'),
  unclassified: msg('Local road'),
});

const segments = new WeakMap();

/**
 * The renderer's undirected road identity and middle vertex in its
 * canonical direction, with its path for viewport clipping.
 */
function segmentOf(road) {
  let segment = segments.get(road);
  if (segment) return segment;
  const neutral = { directFlow: road.directFlow, type: road.type, oneway: 0 };
  const reversed = road.coords.slice().reverse();
  const forward = roadIdentity({ ...neutral, coords: road.coords });
  const reverse = roadIdentity({ ...neutral, coords: reversed });
  const line = forward <= reverse ? road.coords : reversed;
  segment = {
    id: forward <= reverse ? forward : reverse,
    lines: Object.freeze([
      contextLine(line.map(([lon, lat]) => ({ lat, lon }))),
    ]),
    at: line[Math.floor((line.length - 1) / 2)] || [],
  };
  segments.set(road, segment);
  return segment;
}

/**
 * Whether flow `a` is worse than flow `b`: a closure beats everything, then
 * the lower level (slower against free flow); any live flow beats none.
 */
function worseFlow(a, b) {
  if (!a) return false;
  if (!b) return true;
  if (Boolean(a.closure) !== Boolean(b.closure)) return Boolean(a.closure);
  if (!Number.isFinite(a.level)) return false;
  return !Number.isFinite(b.level) || a.level < b.level;
}

/** A record's flow fields, from a road's live flow or none. */
function flowFields(flow, state) {
  const level = Number.isFinite(flow?.level) ? flow.level : null;
  const simulatedSource = state._liveMode
    ? state._flowError
      ? 'simulated-flow-error'
      : 'simulated-unmatched'
    : state._flowStatusUnavailable
      ? 'simulated-unavailable'
      : 'simulated-keyless';
  return {
    flow: flow?.closure ? 'closed' : level === null ? null : flowBucket(level),
    // Current speed as a share of free-flow speed, 0-100.
    flowPct: level === null ? null : Math.round(level * 100),
    simulated: !flow,
    // A code; the card says it in words (entityContext.js CODE_WORDS).
    source: flow
      ? state._flowStale
        ? 'tomtom-cached'
        : 'tomtom-live'
      : simulatedSource,
  };
}

/**
 * The road segments the Traffic layer draws, as plain records for the analyst
 * and the Context panel: one per drawn segment (the two directions of a
 * two-way road are one record, with the worse of their flows).
 *
 * Simulated segments have `simulated` true and `flow` null. Their `source`
 * distinguishes unmatched roads, a failed TomTom flow read, an unreachable
 * traffic service and a missing TomTom key. Saved tiles use `tomtom-cached`.
 * Segments hidden by the uncovered roads setting are omitted.
 * @param {object} state The Traffic layer's state.
 * @param {number} [maxCount]
 * @returns {Array<object>}
 */
export function trafficAnalystRecords(state, maxCount = Infinity) {
  if (!state?._enabled) return [];
  const listed = new Map();
  const result = [];
  for (const road of state._roads || []) {
    const coords = road?.coords;
    if (!Array.isArray(coords) || coords.length < 2) continue;
    const live = state._liveMode === true;
    const flow = live ? ((road.source ?? road).flow ?? null) : null;
    if (live && !flow && state._uncoveredMode === 'hide') continue;
    const { id, at, lines } = segmentOf(road);
    const known = listed.get(id);
    if (known) {
      // The other direction: the record keeps the worse flow.
      if (worseFlow(flow, known.flow)) {
        known.flow = flow;
        Object.assign(known.record, flowFields(flow, state));
      }
      continue;
    }
    if (result.length >= maxCount) continue;
    const [lon, lat] = at;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const record = {
      id,
      name: ROAD_WORDS[road.type] ? t(ROAD_WORDS[road.type]) : t('Road'),
      roadType: road.type || null,
      lat,
      lon,
      ...flowFields(flow, state),
      roads: state._roadSource || null,
    };
    Object.defineProperty(record, CONTEXT_LINES, { value: lines });
    listed.set(id, { record, flow });
    result.push(record);
  }
  return result;
}
