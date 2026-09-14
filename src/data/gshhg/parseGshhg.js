// src/data/gshhg/parseGshhg.js — GSHHG v2.3.7 native .b binary parser.
//
// Format (per-polygon, repeated to end of stream): 11 big-endian int32 header
// `id, n, flag, west, east, south, north` (micro-degrees), `area, area_full`
// (1/10 km^2), `container, ancestor`; flag packs `level = flag & 255`
// (1 land, 2 lake, 3 island-in-lake, 4 pond, 5 Antarctica ice front,
// 6 Antarctica grounding line), `greenwich = (flag >> 16) & 1`,
// `river = (flag >> 25) & 1`; then n big-endian (lon, lat) int32
// micro-degree pairs in the -180/+180 range.
// Source: GSHHG v2.3.7 README, SOEST Hawaii (soest.hawaii.edu/pwessel/gshhg/),
// transcribed 2026-08-29. Data license: LGPL-3.0 (Wessel & Smith, GSHHG).
//
// Zero dependencies by design: the mask build script must run on a bare
// `node scripts/...` with only the downloaded gshhs_i.b file.

const HEADER_INT32S = 11;
const HEADER_BYTES = HEADER_INT32S * 4;
const MICRO = 1e-6;
// gshhs_f.b's largest polygon (Eurasia) is ~1.2M points; anything at or past
// 10M means a corrupt or misaligned stream, not real data.
const MAX_POINTS = 10_000_000;
// Antarctica grounding line — the ice front (level 5) is the land boundary.
const LEVEL_GROUNDING_LINE = 6;

/**
 * @typedef {object} GshhgPolygon
 * @property {number} id
 * @property {number} n            Vertex count.
 * @property {number} level        1 land, 2 lake, 3 island-in-lake, 4 pond,
 *                                 5 Antarctica ice front (level 6 is skipped).
 * @property {boolean} greenwich   Ring crosses the Greenwich meridian.
 * @property {boolean} river       Ring is a river-lake.
 * @property {number} west         Bounds in degrees.
 * @property {number} east
 * @property {number} south
 * @property {number} north
 * @property {number} area         1/10 km^2, as stored.
 * @property {number} areaFull
 * @property {number} container
 * @property {number} ancestor
 * @property {Float64Array} points [lon0, lat0, lon1, lat1, ...] in degrees.
 */

/**
 * Parses a full GSHHG v2.3.7 native .b stream into polygon records with
 * points converted from micro-degrees to degrees. Level-6 polygons
 * (Antarctica grounding line) are skipped entirely; level 5 (ice front) is
 * the land boundary used downstream. Throws on truncation or an insane
 * per-polygon point count.
 * @param {ArrayBuffer|ArrayBufferView} input Raw .b bytes (node Buffer ok).
 * @returns {GshhgPolygon[]}
 */
export function parseGshhg(input) {
  const view = ArrayBuffer.isView(input)
    ? new DataView(input.buffer, input.byteOffset, input.byteLength)
    : new DataView(input);
  const polygons = [];
  let offset = 0;
  while (offset < view.byteLength) {
    if (offset + HEADER_BYTES > view.byteLength) {
      throw new Error(
        `parseGshhg: truncated header at byte ${offset} — ` +
          `${view.byteLength - offset} bytes left, need ${HEADER_BYTES}`
      );
    }
    const id = view.getInt32(offset, false);
    const n = view.getInt32(offset + 4, false);
    const flag = view.getInt32(offset + 8, false);
    if (n <= 0 || n >= MAX_POINTS) {
      throw new Error(
        `parseGshhg: insane point count n=${n} for polygon id=${id} at byte ${offset}`
      );
    }
    const pointBytes = n * 8;
    if (offset + HEADER_BYTES + pointBytes > view.byteLength) {
      throw new Error(
        `parseGshhg: truncated points for polygon id=${id} at byte ${offset} — ` +
          `header declares ${n} points (${pointBytes} B), ` +
          `${view.byteLength - offset - HEADER_BYTES} B left`
      );
    }
    const level = flag & 255;
    if (level === LEVEL_GROUNDING_LINE) {
      offset += HEADER_BYTES + pointBytes;
      continue;
    }
    const points = new Float64Array(n * 2);
    const base = offset + HEADER_BYTES;
    for (let i = 0; i < n * 2; i += 1) {
      points[i] = view.getInt32(base + i * 4, false) * MICRO;
    }
    polygons.push({
      id,
      n,
      level,
      greenwich: ((flag >> 16) & 1) === 1,
      river: ((flag >> 25) & 1) === 1,
      west: view.getInt32(offset + 12, false) * MICRO,
      east: view.getInt32(offset + 16, false) * MICRO,
      south: view.getInt32(offset + 20, false) * MICRO,
      north: view.getInt32(offset + 24, false) * MICRO,
      area: view.getInt32(offset + 28, false),
      areaFull: view.getInt32(offset + 32, false),
      container: view.getInt32(offset + 36, false),
      ancestor: view.getInt32(offset + 40, false),
      points,
    });
    offset += HEADER_BYTES + pointBytes;
  }
  return polygons;
}
