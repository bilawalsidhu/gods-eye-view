/**
 * @file Global-tier source selection for the ocean-current field.
 *
 * The field's non-radar tier has to cover every ocean on Earth, so it is the
 * source that decides what the layer means almost everywhere. Two products can
 * serve it, and they are NOT interchangeable physics:
 *
 * | source            | dynamics                                   | grid            | cadence   | lag           |
 * |-------------------|--------------------------------------------|-----------------|-----------|---------------|
 * | HYCOM ESPC-D-V02  | full primitive equations: geostrophic +     | 0.04° lat ×     | 3-hourly  | −10 d … +5 d  |
 * | (preferred)       | wind-driven + **tides** (8 forced           | 0.08° lon       |           | (a forecast)  |
 * |                   | constituents) + submesoscale                |                 |           |               |
 * | CoastWatch        | absolute geostrophic velocity ONLY — no     | 0.25°           | daily     | ~3 d stale    |
 * | blended altimetry | Ekman, no tides, ~300 km resolved           |                 |           |               |
 *
 * HYCOM is preferred because the altimetry product omits the two dominant
 * shallow-water terms. Measured against OSCAR (geostrophic + Ekman + buoyancy),
 * the altimetry tier's missing ageostrophic component is 0.176 m/s RMS globally
 * and 0.351 m/s within 10° of the equator, where the omitted signal is
 * comparable to the retained one; and its own near-real-time vs delayed-time
 * versions differ by 0.228 m/s RMS, which is 2–3× the HF-radar tier's reported
 * error. Its 0.25° grid also resolves only ~300 km, so it cannot represent the
 * shelf and coastal flow a globe viewer zooms into.
 *
 * The altimetry product is kept as an automatic FALLBACK rather than deleted:
 * HYCOM is a single operational forecast system, and a tier that covers the
 * whole ocean should degrade rather than disappear when one upstream is down.
 * Which one actually served is always named in the payload's provenance and on
 * the legend, together with its physics — a viewer must never have to guess
 * whether the field they are looking at contains tides.
 *
 * @module server/ocean/globalTier
 */

import { fetchHycomCurrents, fetchHycomTimeAxis } from './hycomCurrents.js';
import { fetchGlobalCurrents as fetchAltimetryCurrents } from './globalCurrents.js';

/**
 * @const {number} Time-axis cache TTL, ms.
 *
 * Resolving HYCOM's time axis costs two extra probe requests (`.das` for the
 * epoch, `.ascii?time` for the steps) on every field fetch. The axis only moves
 * when a new model run is aggregated — observed advancing about twice daily —
 * so caching it for three hours removes two round trips per request while never
 * being more than one run behind. A miss simply re-probes.
 */
const TIME_AXIS_TTL_MS = 3 * 3600_000;

/** @type {?{axis: Object, cachedAt: number}} */
let _timeAxis = null;
/** @type {?Promise<?Object>} In-flight probe, so concurrent callers share one. */
let _timeAxisInFlight = null;

/**
 * The HYCOM time axis, memoized for {@link TIME_AXIS_TTL_MS}.
 *
 * Returns null rather than throwing when the probe fails — the caller then lets
 * `fetchHycomCurrents` resolve the axis itself, which is slower but correct.
 *
 * @param {Object} options - `{fetchImpl, signal}`.
 * @returns {Promise<?Object>} The axis, or null.
 */
export async function cachedHycomTimeAxis({ fetchImpl, signal } = {}) {
  const now = Date.now();
  if (_timeAxis && now - _timeAxis.cachedAt <= TIME_AXIS_TTL_MS) return _timeAxis.axis;
  if (_timeAxisInFlight) return _timeAxisInFlight;
  _timeAxisInFlight = (async () => {
    try {
      const axis = await fetchHycomTimeAxis({ fetchImpl, signal });
      if (axis) _timeAxis = { axis, cachedAt: Date.now() };
      return axis;
    } catch {
      return null;
    } finally {
      _timeAxisInFlight = null;
    }
  })();
  return _timeAxisInFlight;
}

/** Drop the memoized axis. Tests only. */
export function _resetTimeAxisCache() {
  _timeAxis = null;
  _timeAxisInFlight = null;
}

/**
 * Physics descriptors attached to whichever source serves. These ride through
 * `fieldGrid`'s provenance onto the legend, so they are user-facing text and
 * are deliberately explicit about what is ABSENT — the omission is the thing a
 * reader needs to know.
 * @const {Object}
 */
export const GLOBAL_TIER_PHYSICS = Object.freeze({
  hycom: Object.freeze({
    kind: 'modeled',
    method: 'HYCOM ESPC-D-V02 primitive-equation ocean forecast: geostrophic and wind-driven flow '
      + 'plus eight astronomically forced tidal constituents; surface layer (depth 0 m), 3-hourly',
  }),
  altimetry: Object.freeze({
    kind: 'derived',
    method: 'absolute geostrophic velocity from multi-mission altimetry (f-plane, beta-plane at the '
      + 'equator); NO Ekman or wind-driven component and NO tides',
  }),
});

/**
 * Fetch the global tier, preferring HYCOM and falling back to altimetry.
 *
 * Drop-in for the shape `fieldGrid` consumes, so switching the tier is a change
 * of import rather than of the consumer. The returned `source` gains `kind` and
 * `method` describing the physics actually served, plus `fallbackFrom` when the
 * preferred source failed.
 *
 * A HYCOM failure is NOT propagated: it is recorded and the altimetry source is
 * tried, because a degraded global field beats an empty one. Both failing
 * returns null, which the caller already treats as "this tier cannot serve".
 *
 * @param {Object} options - Passed through to whichever fetcher runs.
 * @param {Object} options.box - `{latMin, lonMin, latMax, lonMax}` in degrees.
 * @param {number} options.targetCells - Cell budget for stride selection.
 * @param {Function} options.fetchImpl - Injectable fetch.
 * @param {number} [options.nowMs] - Clock the returned `ageMs` is measured against.
 * @param {AbortSignal} [options.signal] - Cancellation.
 * @param {Object} [options.deps] - Test seams: `{fetchHycom, fetchAltimetry}`.
 * @returns {Promise<?Object>} The tier field, or null when neither source served.
 */
export async function fetchGlobalCurrents({ deps = {}, ...options } = {}) {
  const hycom = deps.fetchHycom ?? fetchHycomCurrents;
  const altimetry = deps.fetchAltimetry ?? fetchAltimetryCurrents;

  let hycomReason = null;
  try {
    // Hand the memoized axis down so the common path is ONE round trip rather
    // than three. A null axis is fine — the fetcher resolves it itself.
    const timeAxis = deps.timeAxis !== undefined
      ? deps.timeAxis
      : await cachedHycomTimeAxis({ fetchImpl: options.fetchImpl, signal: options.signal });
    const field = await hycom(timeAxis ? { ...options, timeAxis } : options);
    if (field) return describe(field, 'hycom', null);
    hycomReason = 'HYCOM returned no field for this view';
  } catch (error) {
    // An abort is the caller giving up, not an upstream failure — do not burn a
    // second request retrying a request nobody is waiting for.
    if (options.signal?.aborted) throw error;
    hycomReason = `HYCOM unavailable: ${String(error?.message ?? error)}`;
  }

  const field = await altimetry(options);
  return field ? describe(field, 'altimetry', hycomReason) : null;
}

/**
 * Attach the physics descriptor and any fallback reason to a fetched field.
 * @param {Object} field - Fetcher output.
 * @param {'hycom'|'altimetry'} which - Source that served.
 * @param {?string} fallbackFrom - Why the preferred source did not serve.
 * @returns {Object} The field with `source.kind`, `source.method`, `source.fallbackFrom`.
 */
function describe(field, which, fallbackFrom) {
  const physics = GLOBAL_TIER_PHYSICS[which];
  return {
    ...field,
    source: {
      ...field.source,
      kind: physics.kind,
      method: physics.method,
      fallbackFrom: fallbackFrom ?? null,
    },
  };
}
