import { msg } from '../../i18n/marker.js';

/** A station reporting within this long is current. */
export const SEA_LEVEL_REPORTING_MS = 3 * 3_600_000;
/** A station with no reading for longer than this is silent. */
export const SEA_LEVEL_SILENT_MS = 24 * 3_600_000;
/** IOC station codes as the proxy serves them (lower case). */
export const SEA_LEVEL_CODE = /^[a-z0-9]{1,10}$/;

/**
 * How recently a station reported, which is all the points show: each gauge
 * measures against its own local datum, so levels are never compared between
 * stations and never drive a colour.
 */
export const SEA_LEVEL_FRESHNESS = Object.freeze(
  [
    {
      id: 'reporting',
      label: msg('Reporting (within 3 h)'),
      color: '#38c6f4',
      size: 7,
    },
    {
      id: 'late',
      label: msg('Late (3 to 24 h)'),
      color: '#e0a23a',
      size: 6,
    },
    {
      id: 'silent',
      label: msg('Silent (over 24 h)'),
      color: '#6b7178',
      size: 4,
      dim: true,
    },
  ].map((band, rank) => Object.freeze({ ...band, rank })),
);
const BY_ID = new Map(SEA_LEVEL_FRESHNESS.map((band) => [band.id, band]));

/**
 * The freshness band for a reading `ageMs` old; no reading is silent.
 * @param {number|null} ageMs
 */
export function seaLevelFreshness(ageMs) {
  if (!Number.isFinite(ageMs)) return BY_ID.get('silent');
  if (ageMs <= SEA_LEVEL_REPORTING_MS) return BY_ID.get('reporting');
  return ageMs <= SEA_LEVEL_SILENT_MS ? BY_ID.get('late') : BY_ID.get('silent');
}

const finiteOrNull = (value) => (Number.isFinite(value) ? value : null);
const textOrNull = (value, max = 120) =>
  typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null;
const timeOrNull = (value) =>
  typeof value === 'string' && Number.isFinite(Date.parse(value))
    ? value
    : null;

/**
 * Validate the `/api/sea-level/stations` snapshot into layer records. Rows
 * without a code or a position are dropped; null when the payload is not a
 * snapshot. A station's `ageMs` is its reading's age when the snapshot
 * arrived, on the server's clock (station age plus snapshot age).
 * @param {object} payload Server snapshot.
 * @returns {{stations: Array<object>, generatedAt: string|null,
 *   stale: boolean}|null}
 */
export function normalizeSeaLevelSnapshot(payload) {
  if (!payload || !Array.isArray(payload.stations)) return null;
  const snapshotAgeMs = Math.max(0, finiteOrNull(payload.snapshotAgeMs) ?? 0);
  const stations = [];
  for (const raw of payload.stations) {
    const code = typeof raw?.code === 'string' ? raw.code : '';
    if (!SEA_LEVEL_CODE.test(code)) continue;
    if (
      !Number.isFinite(raw.lat) ||
      !Number.isFinite(raw.lon) ||
      Math.abs(raw.lat) > 90 ||
      Math.abs(raw.lon) > 180
    )
      continue;
    // A reading is a time and a value; either alone is no reading.
    const lastIso = Number.isFinite(raw.lastValue)
      ? timeOrNull(raw.lastIso)
      : null;
    const ageMs =
      lastIso && Number.isFinite(raw.ageMs) && raw.ageMs >= 0
        ? raw.ageMs + snapshotAgeMs
        : null;
    stations.push({
      id: `sea-level:${code}`,
      code,
      name: textOrNull(raw.name) || code,
      country: textOrNull(raw.country, 60),
      lat: raw.lat,
      lon: raw.lon,
      sensor: textOrNull(raw.sensor, 8),
      lastIso,
      lastValue: lastIso ? raw.lastValue : null,
      ageMs,
    });
  }
  return {
    stations,
    generatedAt: timeOrNull(payload.generatedAt),
    stale: payload.stale === true,
  };
}

/**
 * Validate one `/api/sea-level/station/<code>` answer; null when it is not
 * that station's series.
 * @param {object} payload Server answer.
 * @param {string} code The station asked for.
 */
export function normalizeSeaLevelSeries(payload, code) {
  if (!payload || payload.code !== code || !Array.isArray(payload.points))
    return null;
  const points = payload.points.filter(
    (p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]),
  );
  const latest =
    payload.latest &&
    timeOrNull(payload.latest.iso) &&
    Number.isFinite(payload.latest.value)
      ? { iso: payload.latest.iso, value: payload.latest.value }
      : null;
  const min = finiteOrNull(payload.min);
  const max = finiteOrNull(payload.max);
  const valid = latest && min !== null && max !== null && min <= max;
  return {
    code,
    sensor: textOrNull(payload.sensor, 8),
    count: valid ? Math.max(0, finiteOrNull(payload.count) ?? 0) : 0,
    min: valid ? min : null,
    max: valid ? max : null,
    latest: valid ? latest : null,
    points: valid ? points : [],
  };
}

/**
 * Where `value` sits in `[min, max]`, 0 to 100, or null for a flat or
 * missing range.
 */
export function percentOfRange(value, min, max) {
  if (![value, min, max].every(Number.isFinite) || !(max > min)) return null;
  const share = (value - min) / (max - min);
  return Math.round(Math.min(1, Math.max(0, share)) * 100);
}

/** Stations per freshness band, every band present. */
export function countSeaLevelStations(stations) {
  const counts = Object.fromEntries(SEA_LEVEL_FRESHNESS.map((b) => [b.id, 0]));
  for (const station of stations) counts[seaLevelFreshness(station.ageMs).id]++;
  return counts;
}

/** The newest reading time among `stations`, in epoch ms, or null. */
export function newestSeaLevelReading(stations) {
  let newest = null;
  for (const station of stations) {
    const ms = Date.parse(station.lastIso);
    if (Number.isFinite(ms) && (newest === null || ms > newest)) newest = ms;
  }
  return newest;
}

/**
 * The facility's page for a station, built from a validated code only.
 * @param {string} code Station code.
 * @returns {string|null}
 */
export function seaLevelStationPageUrl(code) {
  return SEA_LEVEL_CODE.test(code)
    ? `https://www.ioc-sealevelmonitoring.org/station.php?code=${code}`
    : null;
}
