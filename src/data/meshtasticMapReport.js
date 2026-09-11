/**
 * @file Pure helpers for the Meshtastic public MapReport layer — shared by
 * the server-side MQTT proxy (vite.config.js) and the client layer
 * (meshtasticNodes.js). No protobuf/MQTT imports here on purpose: this file
 * is safe to bundle into the browser. Decoding lives in meshtasticDecode.js.
 * @module data/meshtasticMapReport
 */

/** A node not heard from within this window renders at reduced (STALE) opacity. */
export const MESHTASTIC_NODE_STALE_MS = 6 * 60 * 60 * 1000;
/** A node not heard from within this window is dropped from the cache entirely. */
export const MESHTASTIC_NODE_EVICT_MS = 24 * 60 * 60 * 1000;

/** The standard Meshtastic node-id string: '!' + zero-padded 8-hex-digit id. */
export function formatMeshtasticNodeId(nodeNum) {
  return `!${(nodeNum >>> 0).toString(16).padStart(8, '0')}`;
}

/**
 * Approximate radius (meters) of the location uncertainty a MapReport's
 * `position_precision` implies.
 *
 * `position_precision` is the count of most-significant bits Meshtastic kept
 * of the `sfixed32 * 1e-7`-degree lat/lon fields before zeroing the rest, so
 * the true position can be anywhere within a `2^(32-bits) * 1e-7` degree
 * cell from the reported point. ponytail: this halves that cell width into a
 * single "radius" (rather than modeling the lat/lon-asymmetric cell exactly)
 * and uses a constant meters-per-degree — it's an approximation, not an
 * official formula, but it lands within a few percent of Meshtastic's own
 * published reference points (bits=11 -> "~11 km", bits=16 -> "~350 m").
 * Upgrade to an exact per-axis ellipse if that precision ever matters.
 * @param {number} precisionBits 0 (unset/no precision reported) to 32 (exact).
 * @returns {number} Meters; 0 when precisionBits is missing, 0, or exact (32+).
 */
export function positionUncertaintyRadiusM(precisionBits) {
  if (!Number.isFinite(precisionBits) || precisionBits <= 0 || precisionBits >= 32) return 0;
  const METERS_PER_DEGREE_LAT = 111320;
  const errorDeg = (2 ** (32 - precisionBits)) * 1e-7;
  return (errorDeg * METERS_PER_DEGREE_LAT) / 2;
}

/**
 * Per-node freshness bucket — the same honest LIVE/STALE/gone vocabulary
 * every God's Eye View layer uses, applied per-node rather than per-layer
 * since one MQTT stream carries nodes of wildly different report ages.
 * @param {number|null|undefined} lastSeenMs Epoch ms of the last MapReport.
 * @param {number} [nowMs]
 * @returns {'live'|'stale'|'expired'}
 */
export function meshtasticNodeFreshness(lastSeenMs, nowMs = Date.now()) {
  if (!Number.isFinite(lastSeenMs)) return 'expired';
  const age = nowMs - lastSeenMs;
  if (age <= MESHTASTIC_NODE_STALE_MS) return 'live';
  if (age <= MESHTASTIC_NODE_EVICT_MS) return 'stale';
  return 'expired';
}
