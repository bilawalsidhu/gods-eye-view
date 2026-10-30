/**
 * @module layers/entsoeGrid/model
 *
 * European grid load, normalized. Pure — no Cesium, no network.
 *
 * A load figure is carried as a number WITH its unit rather than as a bare
 * number, because the Transparency Platform publishes some series in MW and
 * others in GWh, and a value of 40 means something different in each.
 */
// A portable export (package.json): no i18n here. The labels stay English
// data; the Layers panel shows them translated.
const msg = (text) => text;

export const ENTSOE_OVERLAY_SOURCE_ID = 'entsoe-grid';
export const ENTSOE_OVERLAY_COHORT_LIMIT = 64;
export const ENTSOE_OVERLAY_COLLISION_CAPACITY = 32;

/**
 * The key-registry id the Provider Settings panel knows the ENTSO-E token
 * by. The layer declares it so the panel can name the environment variable
 * from the one place that owns what each key is called.
 */
export const ENTSOE_KEY_ID = 'entsoe';

/**
 * The layer's own description of what it shows, and what it needs.
 */
export const ENTSOE_DESCRIPTION = msg(
  'European electricity load · ENTSO-E Transparency Platform (token required)',
);

/**
 * Relative load bands, used to colour a series against its own maximum.
 * The thresholds are fractions of the largest value in the snapshot.
 */
export const ENTSOE_LOAD_BANDS = Object.freeze([
  Object.freeze({ id: 'low', label: msg('Low'), color: '#3aa76d' }),
  Object.freeze({ id: 'moderate', label: msg('Moderate'), color: '#e6c300' }),
  Object.freeze({ id: 'high', label: msg('High'), color: '#ef7d1a' }),
  Object.freeze({ id: 'peak', label: msg('Peak'), color: '#d0271d' }),
]);

/**
 * Band a load against the largest load in the same snapshot.
 * @param {number} value Load in the row unit.
 * @param {number} max Largest load in the snapshot.
 * @returns {string} Band id.
 */
export function entsoeLoadBand(value, max) {
  const v = Number(value);
  const m = Number(max);
  if (!Number.isFinite(v) || !Number.isFinite(m) || m <= 0) return 'low';
  const ratio = v / m;
  if (ratio >= 0.75) return 'peak';
  if (ratio >= 0.5) return 'high';
  if (ratio >= 0.25) return 'moderate';
  return 'low';
}

/**
 * The valid time of one hourly point of the day's series.
 *
 * The proxy publishes the points by their POSITION in the UTC day (1..24),
 * so the valid time is the day's midnight plus that many hours. The hour
 * positions are the forecast's own valid times, not the time it was fetched.
 *
 * @param {string|null|undefined} day The UTC day, YYYY-MM-DD.
 * @param {number} position The hour position in the day.
 * @returns {string|null} An ISO timestamp, or null when the day is unusable.
 */
export function entsoePointValidTime(day, position) {
  const text = String(day ?? '').trim();
  if (!text) return null;
  const hour = Number(position);
  if (!Number.isFinite(hour) || hour < 1 || hour > 24) return null;
  const start = Date.parse(text + 'T00:00:00Z');
  if (!Number.isFinite(start)) return null;
  return new Date(start + (hour - 1) * 3_600_000).toISOString();
}

/**
 * Colour for a load band.
 * @param {string|null} band Band id.
 * @returns {string} Hex colour.
 */
export function entsoeBandColor(band) {
  const found = ENTSOE_LOAD_BANDS.find(
    (entry) => entry.id === String(band ?? ''),
  );
  return found ? found.color : ENTSOE_LOAD_BANDS[0].color;
}

/**
 * Validate a proxy payload into a list of series rows.
 *
 * Atomic: a structurally broken payload returns null so the caller keeps
 * its last good snapshot.
 *
 * @param {object} payload The proxy's JSON body.
 * @returns {{series: Array<object>, unit: string|null, day: string|null}|null}
 *   Null when malformed.
 */
export function normalizeEntsoePayload(payload) {
  if (!Array.isArray(payload?.points)) return null;
  const points = [];
  for (const raw of payload.points) {
    const position = Number(raw?.position);
    const value = Number(raw?.value);
    if (!Number.isFinite(position) || !Number.isFinite(value)) continue;
    points.push({ position, value });
  }
  if (!points.length) return null;
  const max = points.reduce((peak, point) => Math.max(peak, point.value), 0);
  const unit = String(payload?.unit ?? '').trim() || null;
  const series = points.map((point) => ({
    ...point,
    band: entsoeLoadBand(point.value, max),
  }));
  return {
    series,
    unit,
    day: String(payload?.day ?? '').trim() || null,
  };
}

/**
 * Map one grid point to a JSON-safe analyst record.
 * @param {object|null|undefined} raw Plain values.
 * @param {number} [index=0] Position in the snapshot (fallback id only).
 * @returns {object} Analyst record.
 */
export function mapEntsoeRecord(raw, index = 0) {
  const num = (v) => (Number.isFinite(v) ? v : null);
  const text = (v) => {
    const value = String(v ?? '').trim();
    return value || null;
  };
  return {
    id: text(raw?.id) || `GRID-${String(index).padStart(4, '0')}`,
    value: num(raw?.value),
    unit: text(raw?.unit),
    band: text(raw?.band),
    position: num(raw?.position),
  };
}
