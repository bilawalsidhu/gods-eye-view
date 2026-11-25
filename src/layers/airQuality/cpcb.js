/**
 * CPCB observations from the OGD resource. Pure and portable: no network,
 * scene or UI imports; the local India route normalizes with it.
 */
import { AIR_QUALITY_UNRATED_COLOR, OBSERVATION_MAX_AGE_MS } from './model.js';

/** OGD pollutant ids that have a view in the layer, as the layer's ids. */
const POLLUTANT_IDS = Object.freeze({
  'PM2.5': 'PM2.5',
  PM10: 'PM10',
  NO2: 'NO2',
  SO2: 'SO2',
  CO: 'CO',
  OZONE: 'O3',
});

/** The pollutants India offers to the layer's views. */
export const CPCB_POLLUTANTS = Object.freeze(Object.values(POLLUTANT_IDS));

/** OGD timestamps have no offset: interpret DD-MM-YYYY HH:mm:ss as IST. */
export function cpcbObservationTime(value) {
  const match = /^(\d{2})-(\d{2})-(\d{4}) (\d{2}):(\d{2}):(\d{2})$/.exec(
    String(value ?? ''),
  );
  if (!match) return null;
  const [, day, month, year, hour, minute, second] = match.map(Number);
  const wall = Date.UTC(year, month - 1, day, hour, minute, second);
  const check = new Date(wall);
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day ||
    check.getUTCHours() !== hour ||
    check.getUTCMinutes() !== minute ||
    check.getUTCSeconds() !== second
  )
    return null;
  return wall - 330 * 60_000;
}

function number(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && !value.trim()) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * The OGD rows as an air-quality snapshot's station catalog and readings,
 * one reading per station and pollutant (the newest).
 *
 * Preserves OGD avg_value (legacy pollutant_avg) as a reported value, without
 * inventing an AQI. The resource's last_update is a publication timestamp, not
 * a sampling time. Units and averaging period are unconfirmed. Readings stay unrated.
 * Returns null for a malformed payload.
 */
export function normalizeCpcbRecords(payload, { now = Date.now() } = {}) {
  if (!Array.isArray(payload?.records)) return null;
  const placedAt = new Map();
  const stations = new Map();
  const readings = new Map();
  for (const row of payload.records) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
    if (row.country !== 'India') continue;
    const lat = number(row.latitude);
    const lon = number(row.longitude);
    if (
      lat === null ||
      lon === null ||
      Math.abs(lat) > 90 ||
      Math.abs(lon) > 180 ||
      ![row.state, row.city, row.station].every(
        (v) => typeof v === 'string' && v.trim(),
      )
    )
      continue;
    const stationId = JSON.stringify([
      row.state.trim(),
      row.city.trim(),
      row.station.trim(),
    ]);
    const observedMs = cpcbObservationTime(row.last_update);
    const placed =
      observedMs !== null && observedMs <= now + 300_000
        ? observedMs
        : -Infinity;
    if (!stations.has(stationId) || placed > placedAt.get(stationId)) {
      placedAt.set(stationId, placed);
      stations.set(stationId, {
        stationId,
        name: row.station.trim(),
        zone: `${row.city.trim()}, ${row.state.trim()}`,
        country: 'IN',
        lat,
        lon,
      });
    }
    const parameter = POLLUTANT_IDS[row.pollutant_id];
    const value = number(row.avg_value ?? row.pollutant_avg);
    if (
      !parameter ||
      value === null ||
      value < 0 ||
      observedMs === null ||
      observedMs > now + 5 * 60_000 ||
      now - observedMs > OBSERVATION_MAX_AGE_MS
    )
      continue;
    const id = `cpcb:${stationId}:${parameter}`;
    if ((readings.get(id)?.observedMs ?? -Infinity) >= observedMs) continue;
    readings.set(id, {
      stationId,
      id,
      provider: 'cpcb',
      parameter,
      scale: parameter,
      value,
      units: null,
      observedMs,
      kind: 'observation',
      band: null,
      rated: false,
      aqi: null,
      color: AIR_QUALITY_UNRATED_COLOR,
      label: String(value),
      note: 'OGD reported average; not an overall AQI. Timestamp is source last_update.',
    });
  }
  return {
    stations: [...stations.values()].sort(
      (a, b) =>
        a.name.localeCompare(b.name) || a.stationId.localeCompare(b.stationId),
    ),
    readings: [...readings.values()]
      .map((r) => ({ ...stations.get(r.stationId), ...r }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  };
}
