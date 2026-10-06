/**
 * @module meshcoreNodes
 * @description Pure parsing/trimming logic for the MeshCore public node feed
 * (https://map.meshcore.io/api/v1/nodes?short=1). Kept separate from
 * server/providers/meshcore.js (which owns caching/HTTP) so the record shape
 * this app depends on is unit-testable without a network call, mirroring
 * firmsCsv.js's split from firms.js.
 */

/** MeshCore node "type" enum, from the upstream schema. */
export const MESHCORE_NODE_TYPE_LABELS = Object.freeze({
  1: 'Client',
  2: 'Repeater',
  3: 'Room Server',
  4: 'Sensor',
});

/** Round a numeric radio param to `digits` decimals, or null when absent/invalid. */
function roundedOrNull(value, digits) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const factor = 10 ** digits;
  return Math.round(n * factor) / factor;
}

/**
 * Trim one raw upstream node record down to only what the globe renders and
 * labels. Drops the embedded `meshcore://` deep link, inserted/updated-by
 * public keys, and duplicate coordinate fields — the biggest contributors to
 * the raw feed's size (tens of megabytes for ~60k nodes).
 *
 * @param {object} raw - One element of the upstream `?short=1` JSON array.
 * @returns {object|null} Normalized node, or null when the record has no
 *   usable type or position (dropped rather than rendered at a wrong/default
 *   location).
 */
export function normalizeMeshcoreNode(raw) {
  const id = String(raw?.public_key || '').trim();
  const type = Number(raw?.type);
  // `Number(null)` is 0 (a legitimate equatorial latitude), so a missing
  // adv_lat/adv_lon must be rejected explicitly rather than relying on
  // Number.isFinite() alone to catch it.
  if (raw?.adv_lat == null || raw?.adv_lon == null) return null;
  const lat = Number(raw.adv_lat);
  const lon = Number(raw.adv_lon);
  if (
    !id ||
    !MESHCORE_NODE_TYPE_LABELS[type] ||
    !Number.isFinite(lat) ||
    !Number.isFinite(lon) ||
    lat < -90 ||
    lat > 90 ||
    lon < -180 ||
    lon > 180
  ) {
    return null;
  }
  const updated = Date.parse(raw?.updated_date);
  const params = raw?.params || {};
  return {
    id,
    type,
    name:
      String(raw?.adv_name || '')
        .trim()
        .slice(0, 80) || null,
    lat,
    lon,
    updatedAt: Number.isFinite(updated) ? updated : null,
    source: String(raw?.source || '').trim() || null,
    freq: roundedOrNull(params.freq, 3),
    bandwidth: roundedOrNull(params.bw, 2),
    spreadingFactor: roundedOrNull(params.sf, 0),
    codingRate: roundedOrNull(params.cr, 0),
  };
}

/**
 * Normalize a full upstream array, dropping unusable records.
 * @param {Array<object>} rawNodes
 * @returns {Array<object>}
 */
export function normalizeMeshcoreNodes(rawNodes) {
  const nodes = [];
  if (!Array.isArray(rawNodes)) return nodes;
  for (const raw of rawNodes) {
    const node = normalizeMeshcoreNode(raw);
    if (node) nodes.push(node);
  }
  return nodes;
}
