/** Pure proximity helpers for Global Context. No capability modeling. */

export const AWARENESS_RADIUS_M = 250000;
export const AWARENESS_MAX_FLIGHT_SEARCH_RADIUS_M = 16000000;
export const AWARENESS_RELATIONSHIP = Object.freeze({
  NEARBY: 'NEARBY',
  OUTSIDE_RANGE: 'OUTSIDE_RANGE',
  UNKNOWN: 'UNKNOWN',
});

/**
 * Search an expanding area synchronously, doubling the radius after each miss.
 * The maximum covers the farthest possible Earth-surface chord while keeping
 * an empty feed bounded.
 *
 * @template T
 * @param {(radiusM: number) => T|null|undefined} search Search callback.
 * @param {{initialRadiusM?: number, maxRadiusM?: number}} [options] Bounds.
 * @returns {{candidate: T, radiusM: number}|null} First match and radius used.
 */
export function findByDoublingRadius(search, {
  initialRadiusM = AWARENESS_RADIUS_M,
  maxRadiusM = AWARENESS_MAX_FLIGHT_SEARCH_RADIUS_M,
} = {}) {
  if (typeof search !== 'function') return null;
  if (!Number.isFinite(initialRadiusM) || initialRadiusM <= 0) return null;
  if (!Number.isFinite(maxRadiusM) || maxRadiusM < initialRadiusM) return null;

  let radiusM = initialRadiusM;
  while (radiusM <= maxRadiusM) {
    const candidate = search(radiusM);
    if (candidate) return { candidate, radiusM };
    if (radiusM === maxRadiusM) break;
    radiusM = Math.min(radiusM * 2, maxRadiusM);
  }
  return null;
}

/**
 * Format a metric distance for HUD/label display, collapsing non-finite and
 * negative inputs to the em-dash placeholder the summary panels render for
 * unknown values.
 *
 * @param {number} meters Distance in metres.
 * @returns {string} Human-readable distance (`"m"` under 1 km, `"km"` above).
 */
export function formatAwarenessDistance(meters) {
  if (!Number.isFinite(meters) || meters < 0) return '—';
  return meters < 1000 ? `${Math.round(meters)} m` : `${(meters / 1000).toFixed(meters < 10000 ? 1 : 0)} km`;
}

/**
 * Return a stable visible label without leaking missing values into UI text.
 *
 * Accepts a raw contact object or any candidate field; objects are probed in
 * `callsign → name → label → id → icao24 → mmsi` order (recursing so a nested
 * object falls through to the next candidate) and everything unrenderable
 * collapses to `—`.
 *
 * @param {*} value Contact object, string, number, or missing field.
 * @returns {string} Trimmed display label, or `'—'` when nothing is usable.
 */
export function formatAwarenessLabel(value) {
  if (value && typeof value === 'object') {
    for (const candidate of [value.callsign, value.name, value.label, value.id, value.icao24, value.mmsi]) {
      const label = formatAwarenessLabel(candidate);
      if (label !== '—') return label;
    }
    return '—';
  }
  if (typeof value === 'string') return value.trim() || '—';
  if (Number.isFinite(value)) return String(value);
  return '—';
}

/**
 * Summarize sorted nearby results without promoting missing/stale feeds to a
 * negative finding. `UNKNOWN` is an input-data state, never an out-of-range
 * claim in this MVP.
 *
 * Rows are normalized to a finite non-negative `distanceM` (accepting the
 * legacy `distance` spelling), sorted ascending, and truncated to `limit`.
 *
 * @param {Array<{distanceM?: number, distance?: number, [key: string]: *}>} items
 *   Nearby candidates emitted by the per-layer proximity search.
 * @param {object} [options] Feed-state switches supplied by the caller.
 * @param {boolean} [options.available=true] False when the source feed failed to load.
 * @param {boolean} [options.stale=false] True when the feed is older than its freshness window.
 * @param {number} [options.limit=3] Maximum contacts kept in `nearest`.
 * @returns {{relationship: string, count: number|null, nearest: Array<{distanceM: number}>, reason: string}}
 *   Cohort verdict: `NEARBY` with ranked contacts, or `UNKNOWN` plus the
 *   explanatory `reason` (unavailable feed, stale feed, or genuinely empty).
 */
export function summarizeAwarenessCohort(items, { available = true, stale = false, limit = 3 } = {}) {
  if (!available) return { relationship: AWARENESS_RELATIONSHIP.UNKNOWN, count: null, nearest: [], reason: 'feed unavailable' };
  if (stale) return { relationship: AWARENESS_RELATIONSHIP.UNKNOWN, count: null, nearest: [], reason: 'feed stale' };
  const normalized = (Array.isArray(items) ? items : [])
    .filter((item) => Number.isFinite(item?.distanceM ?? item?.distance)
      && (item.distanceM ?? item.distance) >= 0)
    .map((item) => ({ ...item, distanceM: item.distanceM ?? item.distance }))
    .sort((a, b) => a.distanceM - b.distanceM);
  return {
    relationship: normalized.length ? AWARENESS_RELATIONSHIP.NEARBY : AWARENESS_RELATIONSHIP.UNKNOWN,
    count: normalized.length,
    nearest: normalized.slice(0, limit),
    reason: normalized.length ? 'observed or mapped nearby context' : 'no observed or mapped objects in current feeds',
  };
}

/**
 * Return selectable nearby targets in a stable, subject-first order.
 * @param {Array<{id: string, summary?: {nearest?: Array<object>}}>} cohorts Awareness cohorts.
 * @param {{layerId?: string}|null} [subject] Current subject.
 * @param {Iterable<string>} [visitedKeys] Previously visited layer/id keys.
 * @returns {Array<{layerId: string, id: string, item: object}>} Selectable targets.
 */
export function getAwarenessNavigationTargets(cohorts, subject = null, visitedKeys = []) {
  const visited = new Set(visitedKeys);
  const targets = [];
  for (const cohort of Array.isArray(cohorts) ? cohorts : []) {
    const layerId = cohort?.id;
    if (!['flights', 'military', 'ais-live-vessels', 'military-installations'].includes(layerId)) continue;
    const sourceItems = Array.isArray(cohort?.summary?.navigationNearest)
      ? cohort.summary.navigationNearest
      : (Array.isArray(cohort?.summary?.nearest) ? cohort.summary.nearest : []);
    for (const item of sourceItems) {
      const id = item?.icao24 || item?.mmsi || item?.id;
      if (!id) continue;
      const key = `${layerId}:${id}`;
      if (key === `${subject?.layerId}:${subject?.id}`) continue;
      targets.push({ layerId, id: String(id), item, visited: visited.has(key) });
    }
  }
  targets.sort((a, b) => {
    // UNVISITED outranks layer affinity. Ordering subject-layer first put
    // already-visited same-layer contacts ahead of unvisited contacts in every
    // other layer, so NEXT ping-ponged inside the subject's own layer and never
    // reached vessels, installations, or the other flight layer at all.
    const visitedOrder = Number(a.visited) - Number(b.visited);
    if (visitedOrder) return visitedOrder;
    const subjectOrder = Number(a.layerId !== subject?.layerId) - Number(b.layerId !== subject?.layerId);
    if (subjectOrder) return subjectOrder;
    return (a.item.distanceM ?? Infinity) - (b.item.distanceM ?? Infinity);
  });
  return targets;
}
