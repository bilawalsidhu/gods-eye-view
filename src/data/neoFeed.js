/**
 * NeoWs (NASA Near Earth Object Web Service) feed normalization — shared by the
 * /api/neo dev proxy (vite.config.js) and the near-earth-objects layer. Pure
 * JS, no Cesium imports, so both runtimes (browser bundle and node:test) can
 * use it. API docs: https://api.nasa.gov (NeoWs REST, /neo/rest/v1/feed).
 * Only the fields this app surfaces are kept; everything else is dropped at
 * the seam.
 *
 * @module data/neoFeed
 */

const AU_KM = 149_597_870.7;

/** Clamp a number, or null when absent/NaN (NeoWs ships numbers as strings; null must not coerce to 0). */
function finiteOrNull(value) {
  if (value === null || value === undefined || typeof value === 'boolean') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Build the NeoWs feed query params for a trailing + forward window (max 7
 * days upstream). Exposed for tests; the proxy appends api_key.
 * @param {number} nowMs - Reference epoch ms (injected for tests).
 * @param {number} [days=7] - Window length in days (NeoWs hard cap: 7).
 * @returns {{start_date: string, end_date: string}} YYYY-MM-DD window.
 */
export function neoFeedWindow(nowMs, days = 7) {
  const span = Math.min(7, Math.max(1, Math.floor(days)));
  const toIsoDay = (ms) => new Date(ms).toISOString().slice(0, 10);
  return { start_date: toIsoDay(nowMs), end_date: toIsoDay(nowMs + span * 86_400_000) };
}

/**
 * Validate and normalize one NeoWs feed response into a flat, JSON-safe list
 * of close-approach rows. Mirrors normalizeEarthquakeSnapshot's contract:
 * a structurally malformed feed returns null (the caller keeps its last good
 * snapshot), while rows that merely miss optional fields are skipped.
 *
 * Row shape:
 *   { id, name, sizeM, missKm, missLunar, velocityKph, approachMs,
 *     hazardous, absMag }
 * @param {Object|null} payload - Parsed NeoWs /feed JSON.
 * @returns {Array<Object>|null} Rows sorted by approach time, or null.
 */
export function normalizeNeoFeed(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const byDay = payload.near_earth_objects;
  if (!byDay || typeof byDay !== 'object' || Array.isArray(byDay)) return null;
  const rows = [];
  const ids = new Set();
  for (const dayList of Object.values(byDay)) {
    if (!Array.isArray(dayList)) return null;
    for (const neo of dayList) {
      if (!neo || typeof neo !== 'object' || Array.isArray(neo)) return null;
      const id = typeof neo.neo_reference_id === 'string' && neo.neo_reference_id
        ? neo.neo_reference_id
        : null;
      const name = typeof neo.name === 'string' && neo.name.trim() ? neo.name.trim() : null;
      if (!id || !name) continue;
      const approaches = neo.close_approach_data;
      if (!Array.isArray(approaches) || approaches.length === 0) continue;
      const approach = approaches[0];
      if (!approach || typeof approach !== 'object' || Array.isArray(approach)) continue;
      const missKm = finiteOrNull(approach.miss_distance?.kilometers);
      const missLunar = finiteOrNull(approach.miss_distance?.lunar);
      const velocityKph = finiteOrNull(approach.relative_velocity?.kilometers_per_hour);
      const approachMs = finiteOrNull(approach.epoch_date_close_approach);
      if (missKm === null || approachMs === null) continue;
      if (ids.has(id)) return null; // duplicate id — treat as malformed feed
      ids.add(id);
      const est = neo.estimated_diameter?.kilometers;
      const sizeMin = finiteOrNull(est?.estimated_diameter_min);
      const sizeMax = finiteOrNull(est?.estimated_diameter_max);
      rows.push({
        id,
        name,
        sizeM: sizeMin !== null && sizeMax !== null
          ? Math.round(((sizeMin + sizeMax) / 2) * 2000) / 2
          : null,
        missKm,
        missLunar,
        velocityKph,
        approachMs,
        hazardous: neo.is_potentially_hazardous_asteroid === true,
        absMag: finiteOrNull(neo.absolute_magnitude_h),
      });
    }
  }
  rows.sort((a, b) => a.approachMs - b.approachMs || a.id.localeCompare(b.id));
  return rows;
}
