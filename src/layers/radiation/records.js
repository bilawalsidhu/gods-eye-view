/**
 * Ambient gamma dose rate readings.
 *
 * Two keyless networks, normalised to one record per station or device:
 * - BfS ODL (Germany's official network): the latest 1-hour mean per
 *   station, already in µSv/h.
 * - Safecast realtime (volunteer sensors worldwide): the latest reading per
 *   device in counts per minute, converted with Safecast's published factor
 *   for the LND 7318 tube. Other tubes have no published factor and are
 *   dropped.
 *
 * Only the fields the layer shows survive; Safecast's device records also
 * carry owner contact details, which never leave these normalisers.
 */

export const RADIATION_SOURCES = Object.freeze(['bfs', 'safecast']);

export const RADIATION_SOURCE_NAMES = Object.freeze({
  bfs: 'BfS ODL',
  safecast: 'Safecast',
});

/** Dose-rate bands (µSv/h lower bounds), from the highest down. */
export const RADIATION_BANDS = Object.freeze([
  Object.freeze({
    id: 'high',
    min: 1,
    name: 'High',
    label: 'High · 1 µSv/h or more',
  }),
  Object.freeze({
    id: 'raised',
    min: 0.5,
    name: 'Raised',
    label: 'Raised · 0.5–1 µSv/h',
  }),
  Object.freeze({
    id: 'elevated',
    min: 0.2,
    name: 'Elevated',
    label: 'Elevated · 0.2–0.5 µSv/h',
  }),
  Object.freeze({
    id: 'typical',
    min: 0,
    name: 'Typical',
    label: 'Typical · under 0.2 µSv/h',
  }),
]);

export const RADIATION_BAND_COLORS = Object.freeze({
  high: '#ff4d4d',
  raised: '#ff9f1c',
  elevated: '#e6d23c',
  typical: '#4cc764',
});

/**
 * Safecast: 334 CPM = 1 µSv/h for the LND 7318 pancake tube. Safecast's own
 * ingest applies 334 to both `lnd_7318u` and `lnd_7318c` (the unshielded and
 * energy-compensated variants of the same tube): `mapview_schema.sql` in
 * Safecast/ingest and `conversion.go` in Safecast/safecast-new-map. Their
 * factors for the LND 712 / 7128 tubes disagree, so those are left out.
 */
export const SAFECAST_CPM_PER_USVH = 334;
const SAFECAST_TUBES = Object.freeze(['lnd_7318u', 'lnd_7318c']);

/** A BfS reading older than this is no longer the latest hour. */
export const BFS_MAX_AGE_MS = 6 * 3_600_000;
/** A Safecast device silent for longer than this is left out. */
export const SAFECAST_MAX_AGE_MS = 24 * 3_600_000;
/** Clock skew tolerated for readings stamped in the future. */
const FUTURE_SLACK_MS = 10 * 60_000;
/** Anything above this is a broken sensor, not a reading. */
const MAX_USVH = 1_000;
const MAX_TEXT = 80;

const text = (value) =>
  typeof value === 'string'
    ? value.replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT)
    : '';

const round = (value, digits) => {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
};

/** The display name of the band a dose rate falls in. */
export function radiationBandName(usvh) {
  const id = radiationBand(usvh);
  return RADIATION_BANDS.find((band) => band.id === id).name;
}

/** How old a source's reading may be and still count as current. */
export function radiationMaxAgeMs(source) {
  return source === 'bfs' ? BFS_MAX_AGE_MS : SAFECAST_MAX_AGE_MS;
}

/** The band a dose rate falls in. */
export function radiationBand(usvh) {
  return (
    RADIATION_BANDS.find((band) => usvh >= band.min) || RADIATION_BANDS.at(-1)
  ).id;
}

const validPosition = (lon, lat) =>
  Number.isFinite(lon) &&
  Number.isFinite(lat) &&
  Math.abs(lat) <= 90 &&
  Math.abs(lon) <= 180 &&
  !(lon === 0 && lat === 0);

const parseTime = (value) => {
  if (typeof value !== 'string' || !value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
};

const fresh = (atMs, nowMs, maxAgeMs) =>
  atMs !== null && atMs <= nowMs + FUTURE_SLACK_MS && nowMs - atMs <= maxAgeMs;

const validDose = (usvh) =>
  Number.isFinite(usvh) && usvh > 0 && usvh <= MAX_USVH;

/**
 * Normalise one BfS ODL WFS feature, or null when the station is not in
 * operation, has no current value, or lacks an identity or position.
 */
export function normalizeBfsFeature(feature, nowMs) {
  const p = feature?.properties;
  if (!p || p.site_status !== 1) return null;
  const station = typeof p.id === 'string' ? p.id : '';
  if (!/^DE[A-Z0-9]{3,12}$/.test(station)) return null;
  const [lon, lat] = Array.isArray(feature.geometry?.coordinates)
    ? feature.geometry.coordinates
    : [];
  if (feature.geometry?.type !== 'Point' || !validPosition(lon, lat))
    return null;
  if (p.unit !== 'µSv/h' || !validDose(p.value)) return null;
  const atMs = parseTime(p.end_measure);
  if (!fresh(atMs, nowMs, BFS_MAX_AGE_MS)) return null;
  return {
    id: `bfs-${station}`,
    source: 'bfs',
    name: text(p.name) || station,
    country: 'DE',
    lon,
    lat,
    usvh: round(p.value, 3),
    cpm: null,
    atMs,
  };
}

/**
 * Normalise one Safecast realtime device record, or null when it is a test
 * device, has no LND 7318 reading, is stale, or lacks an identity or
 * position.
 */
export function normalizeSafecastDevice(device, nowMs) {
  if (!device || device.dev_test === true) return null;
  const id = Number(device.device);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  const lon = device.loc_lon;
  const lat = device.loc_lat;
  if (!validPosition(lon, lat)) return null;
  const tube = SAFECAST_TUBES.find((key) => Number.isFinite(device[key]));
  if (!tube) return null;
  // Some firmware reports a fractional count; the dose keeps it, the
  // displayed count is rounded.
  const cpm = device[tube];
  const usvh = cpm / SAFECAST_CPM_PER_USVH;
  if (!validDose(usvh)) return null;
  const atMs = parseTime(device.when_captured);
  if (!fresh(atMs, nowMs, SAFECAST_MAX_AGE_MS)) return null;
  const country = text(device.loc_country).toUpperCase();
  return {
    id: `safecast-${id}`,
    source: 'safecast',
    name: text(device.loc_name) || `Safecast ${id}`,
    country: /^[A-Z]{2}$/.test(country) ? country : '',
    lon: round(lon, 4),
    lat: round(lat, 4),
    usvh: round(usvh, 3),
    cpm: Math.round(cpm),
    atMs,
  };
}

/** Normalise the BfS WFS FeatureCollection, or null when it is not one. */
export function normalizeBfsCollection(payload, nowMs) {
  if (!Array.isArray(payload?.features)) return null;
  const byId = new Map();
  for (const feature of payload.features) {
    const record = normalizeBfsFeature(feature, nowMs);
    if (record && !byId.has(record.id)) byId.set(record.id, record);
  }
  return [...byId.values()];
}

/**
 * Normalise the Safecast device list, one record per device (the latest
 * reading wins), or null when it is not a list.
 */
export function normalizeSafecastDevices(payload, nowMs) {
  if (!Array.isArray(payload)) return null;
  const byId = new Map();
  for (const device of payload) {
    const record = normalizeSafecastDevice(device, nowMs);
    if (!record) continue;
    const previous = byId.get(record.id);
    if (!previous || record.atMs > previous.atMs) byId.set(record.id, record);
  }
  return [...byId.values()];
}

/** Highest dose rate first, then the most recent. */
export function compareRadiationReadings(a, b) {
  return b.usvh - a.usvh || b.atMs - a.atMs || a.id.localeCompare(b.id);
}

/**
 * Validate readings that crossed the proxy boundary. Only the fields the
 * normalisers produce survive, re-checked; a row without a matching
 * identity, a known source, a position or a plausible dose rate is dropped.
 */
export function sanitizeRadiationReadings(rows) {
  if (!Array.isArray(rows)) return null;
  const seen = new Set();
  const readings = [];
  for (const row of rows) {
    if (
      !row ||
      !RADIATION_SOURCES.includes(row.source) ||
      typeof row.id !== 'string' ||
      !row.id.startsWith(`${row.source}-`) ||
      row.id.length > 40 ||
      seen.has(row.id) ||
      !validPosition(row.lon, row.lat) ||
      !validDose(row.usvh) ||
      !Number.isFinite(row.atMs)
    )
      continue;
    seen.add(row.id);
    const country = text(row.country);
    readings.push({
      id: row.id,
      source: row.source,
      name: text(row.name) || row.id,
      country: /^[A-Z]{2}$/.test(country) ? country : '',
      lon: row.lon,
      lat: row.lat,
      usvh: row.usvh,
      cpm:
        row.source === 'safecast' && Number.isInteger(row.cpm) ? row.cpm : null,
      atMs: row.atMs,
    });
  }
  return readings.sort(compareRadiationReadings);
}
