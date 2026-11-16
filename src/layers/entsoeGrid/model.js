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
export const ENTSOE_ZONE_PICK_PREFIX = 'entsoe-zone:';
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
    zone: text(raw?.zone),
    value: num(raw?.value),
    unit: text(raw?.unit),
    band: text(raw?.band),
    position: num(raw?.position),
  };
}

/**
 * The bidding zones the layer draws, each at the centre of its country.
 *
 * The codes are the ones the proxy accepts (`server/providers/entsoe.js`
 * ENTSOE_ZONES). A zone is a market area, not a point: the pin marks which
 * country the reading belongs to.
 */
export const ENTSOE_ZONE_PINS = Object.freeze([
  Object.freeze({ code: 'FR', name: msg('France'), lat: 46.6, lon: 2.5 }),
  Object.freeze({ code: 'DE', name: msg('Germany'), lat: 51.1, lon: 10.4 }),
  Object.freeze({ code: 'ES', name: msg('Spain'), lat: 40.2, lon: -3.7 }),
  Object.freeze({ code: 'IT', name: msg('Italy'), lat: 42.8, lon: 12.5 }),
  Object.freeze({
    code: 'GB',
    name: msg('Great Britain'),
    lat: 54.0,
    lon: -2.5,
  }),
  Object.freeze({ code: 'BE', name: msg('Belgium'), lat: 50.6, lon: 4.7 }),
  Object.freeze({ code: 'NL', name: msg('Netherlands'), lat: 52.2, lon: 5.5 }),
  Object.freeze({ code: 'PT', name: msg('Portugal'), lat: 39.6, lon: -8.0 }),
  Object.freeze({ code: 'AT', name: msg('Austria'), lat: 47.6, lon: 14.1 }),
  Object.freeze({ code: 'CH', name: msg('Switzerland'), lat: 46.8, lon: 8.2 }),
  Object.freeze({ code: 'PL', name: msg('Poland'), lat: 52.1, lon: 19.4 }),
]);

/** The zone the row's hour rail shows until another pin is chosen. */
export const ENTSOE_DEFAULT_FOCUS = 'FR';

/** The zone code a picked entity id names, or null. */
export function entsoeZoneFromPick(pickId) {
  const text = typeof pickId === 'string' ? pickId : '';
  if (!text.startsWith(ENTSOE_ZONE_PICK_PREFIX)) return null;
  const code = text.slice(ENTSOE_ZONE_PICK_PREFIX.length);
  return ENTSOE_ZONE_PINS.some((zone) => zone.code === code) ? code : null;
}

/**
 * Combine per-zone payloads into one snapshot.
 *
 * A zone whose payload is unusable is left out; the snapshot is null only
 * when no zone is usable, so one flaky country does not blank the layer.
 *
 * @param {Array<{code: string, payload: object}>} results
 * @returns {{zones: Array<object>, unit: string|null, day: string|null}|null}
 */
export function normalizeEntsoeSnapshot(results) {
  const zones = [];
  for (const { code, payload } of results ?? []) {
    const pin = ENTSOE_ZONE_PINS.find((zone) => zone.code === code);
    const normalized = pin ? normalizeEntsoePayload(payload) : null;
    if (!normalized) continue;
    zones.push({ ...pin, ...normalized });
  }
  if (!zones.length) return null;
  return {
    zones,
    unit: zones[0].unit,
    day: zones[0].day,
  };
}

/**
 * The reading a zone is at right now: the latest hour already started, or
 * the first hour when none has started yet (a day-ahead series read early).
 *
 * @param {{series: Array<object>, day: string|null}} zone
 * @param {number} [now]
 * @returns {object|null} The series row, with its `validTime`.
 */
export function entsoeCurrentPoint(zone, now = Date.now()) {
  const rows = (zone?.series ?? [])
    .map((point) => ({
      ...point,
      validTime: entsoePointValidTime(zone.day, point.position),
    }))
    .filter((point) => point.validTime)
    .sort((a, b) => a.position - b.position);
  if (!rows.length) return null;
  let current = rows[0];
  for (const row of rows) {
    if (Date.parse(row.validTime) <= now) current = row;
  }
  return current;
}

/** A one-line bar chart of a series: eight block heights, low to high. */
export function entsoeSparkline(values) {
  const nums = (values ?? []).map(Number).filter(Number.isFinite);
  if (!nums.length) return '';
  const min = Math.min(...nums);
  const span = Math.max(...nums) - min;
  const blocks = '▁▂▃▄▅▆▇█';
  return nums
    .map(
      (v) =>
        blocks[
          span > 0 ? Math.round(((v - min) / span) * (blocks.length - 1)) : 3
        ],
    )
    .join('');
}

/**
 * The card for one zone pin.
 * @param {object} zone A zone of the snapshot.
 * @param {(key: string, params?: object) => string} t Translator.
 * @param {number} [now]
 * @returns {{title: string, details: string[], accent: string}}
 */
export function buildEntsoeZoneCopy(zone, t, now = Date.now()) {
  const unit = zone.unit || 'MW';
  const current = entsoeCurrentPoint(zone, now);
  const values = zone.series.map((point) => point.value);
  const round = (v) => String(Math.round(v));
  const hour = (iso) => iso.slice(11, 16);
  return {
    title: t(zone.name),
    details: [
      t('Electricity load · ENTSO-E'),
      ...(current
        ? [
            t('{value} {unit} at {hour} UTC', {
              value: round(current.value),
              unit,
              hour: hour(current.validTime),
            }),
            t(
              ENTSOE_LOAD_BANDS.find((b) => b.id === current.band)?.label ??
                'Low',
            ),
          ]
        : []),
      entsoeSparkline(values),
      t('Day low {low} · peak {high} {unit}', {
        low: round(Math.min(...values)),
        high: round(Math.max(...values)),
        unit,
      }),
      `${zone.lat.toFixed(1)}°, ${zone.lon.toFixed(1)}°`,
    ],
    accent: entsoeBandColor(current?.band),
  };
}
