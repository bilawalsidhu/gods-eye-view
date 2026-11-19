import { OBSERVATION_MAX_AGE_MS, AIR_QUALITY_UNKNOWN_COLOR } from './model.js';

export const CPCB_POLLUTANTS = Object.freeze([
  'PM2.5',
  'PM10',
  'NO2',
  'SO2',
  'CO',
  'OZONE',
  'NH3',
]);

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
 * Preserve OGD avg_value (legacy pollutant_avg) as a reported value, without inventing an AQI,
 * concentration unit or health category. One pollutant is displayed at a time.
 * The resource's last_update is a publication timestamp, not a sampling time.
 */
export function normalizeCpcbRecords(
  payload,
  { pollutant = 'PM2.5', now = Date.now() } = {},
) {
  if (!Array.isArray(payload?.records) || !CPCB_POLLUTANTS.includes(pollutant))
    return null;
  const stations = new Map();
  for (const row of payload.records) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
    if (row.country !== 'India' || row.pollutant_id !== pollutant) continue;
    const lat = number(row.latitude);
    const lon = number(row.longitude);
    const value = number(row.avg_value ?? row.pollutant_avg);
    const observedMs = cpcbObservationTime(row.last_update);
    if (
      lat === null ||
      lon === null ||
      Math.abs(lat) > 90 ||
      Math.abs(lon) > 180 ||
      value === null ||
      value < 0 ||
      observedMs === null ||
      observedMs > now + 5 * 60_000 ||
      now - observedMs > OBSERVATION_MAX_AGE_MS
    )
      continue;
    if (
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
    if ((stations.get(stationId)?.observedMs ?? -Infinity) >= observedMs)
      continue;
    stations.set(stationId, {
      id: `cpcb:${stationId}:${pollutant}`,
      provider: 'cpcb',
      scale: pollutant,
      value,
      band: null,
      stationId,
      name: row.station.trim(),
      zone: `${row.city.trim()}, ${row.state.trim()}`,
      lat,
      lon,
      observedMs,
      color: AIR_QUALITY_UNKNOWN_COLOR,
      label: String(value),
      risk: null,
      note: 'OGD reported average; not an overall AQI. Timestamp is source last_update.',
    });
  }
  return [...stations.values()].sort(
    (a, b) => b.value - a.value || a.stationId.localeCompare(b.stationId),
  );
}
