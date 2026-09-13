/**
 * @file Pure helpers for the WiGLE Wi-Fi network layer.
 *
 * Shared by the `/api/wigle` vite plugin (server-side: viewport validation,
 * daily-budget day-key) and `src/data/wigleNetworks.js` (client-side: result
 * normalization, freshness bucketing). Zero dependencies, so both sides can
 * unit-test against it with node:test.
 * @module data/wigleApi
 */

/** Max bounding-box span (degrees) the proxy will query in one request — WiGLE's
 * own daily query allowance is small and account-dependent, so requests stay tight. */
export const WIGLE_MAX_VIEWPORT_DEGREES = 0.4;

/** @param {{south:number,west:number,north:number,east:number}|null} box */
export function isValidWigleViewport(box) {
  if (!box) return false;
  const { south, west, north, east } = box;
  if (![south, west, north, east].every(Number.isFinite)) return false;
  if (east <= west || north <= south) return false;
  return (north - south) <= WIGLE_MAX_VIEWPORT_DEGREES && (east - west) <= WIGLE_MAX_VIEWPORT_DEGREES;
}

/**
 * Map one raw WiGLE `results[]` entry to a plain, JSON-safe network record.
 * Null for anything missing coordinates — WiGLE occasionally returns
 * untriangulated rows with trilat/trilong at 0.
 * @param {object} raw
 * @returns {object|null}
 */
export function normalizeWigleNetwork(raw) {
  const lat = Number(raw?.trilat);
  const lon = Number(raw?.trilong);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || (lat === 0 && lon === 0)) return null;
  const text = (v) => { const t = String(v ?? '').trim(); return t || null; };
  // `Number('')` is 0, not NaN — a blank field must read as missing.
  const num = (v) => {
    if (v === '' || v == null) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  return {
    id: text(raw?.netid) || `wigle:${lat.toFixed(6)},${lon.toFixed(6)}`,
    netid: text(raw?.netid),
    ssid: text(raw?.ssid),
    encryption: text(raw?.encryption),
    type: text(raw?.type),
    channel: num(raw?.channel),
    qos: num(raw?.qos),
    firstSeen: text(raw?.firsttime),
    lastSeen: text(raw?.lasttime),
    latitude: lat,
    longitude: lon,
  };
}

/**
 * How long ago a network was last observed, bucketed for presentation —
 * crowdsourced observations, not live RF detections, so this is about
 * showing age honestly rather than gating a hard filter.
 * @param {string|null} lastSeenIso WiGLE `lasttime` (ISO 8601).
 * @param {number} [nowMs]
 * @returns {'recent'|'aged'|'old'|'unknown'}
 */
export function wigleNetworkFreshness(lastSeenIso, nowMs = Date.now()) {
  const t = lastSeenIso ? Date.parse(lastSeenIso) : NaN;
  if (!Number.isFinite(t)) return 'unknown';
  const ageDays = (nowMs - t) / 86_400_000;
  if (ageDays <= 90) return 'recent';
  if (ageDays <= 365) return 'aged';
  return 'old';
}

/** WiGLE's own daily query counter resets at US/Pacific midnight, not UTC. */
export function wiglePacificDayKey(nowMs = Date.now()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(nowMs);
}

/**
 * Backoff progression for the unavailable-state retry: 30 s, doubling to a
 * 240 s ceiling. Pure so the progression is pinnable without booting the layer.
 */
export function wigleRetryDelayMs(prevDelayMs) {
  const RETRY_MIN_MS = 30000;
  const RETRY_CEIL_MS = 240000;
  if (!Number.isFinite(prevDelayMs) || prevDelayMs <= 0) return RETRY_MIN_MS;
  return Math.min(prevDelayMs * 2, RETRY_CEIL_MS);
}
