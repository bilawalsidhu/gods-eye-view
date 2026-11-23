/**
 * CPCB observations from the OGD resource. Pure and portable: no network,
 * scene or UI imports; the local India route normalizes with it.
 */
import { OBSERVATION_MAX_AGE_MS } from './model.js';

/**
 * Whether the feed's units are confirmed to follow CPCB's convention
 * (`CPCB_UNITS`), checked against another copy of the same stations.
 */
export const CPCB_UNITS_VERIFIED = false;

/**
 * The averaging period of the feed's `avg_value`, in minutes, or null while
 * it is not confirmed. The resource does not state it.
 */
export const CPCB_AVERAGING_MINUTES = null;

/**
 * Whether India's readings may be rated: only with verified units AND a known
 * averaging period. Unrated readings (`rated: false`) keep the neutral colour,
 * get no category and contribute to no index (`aqi: null`); units are shown
 * only once verified.
 */
export function cpcbRated({
  unitsVerified = CPCB_UNITS_VERIFIED,
  averagingMinutes = CPCB_AVERAGING_MINUTES,
} = {}) {
  return unitsVerified === true && Number.isFinite(averagingMinutes);
}

/** CPCB's convention for these pollutants; applied only once verified. */
export const CPCB_UNITS = Object.freeze({
  'PM2.5': 'µg/m³',
  PM10: 'µg/m³',
  NO2: 'µg/m³',
  SO2: 'µg/m³',
  CO: 'mg/m³',
  O3: 'µg/m³',
});

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

/** The colour of a station no index rates; the layer recolours rated ones. */
const UNRATED_COLOR = '#8cb4ce';

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
 * a sampling time. A reading is marked rated only when `cpcbRated` allows it;
 * its colour and category then come from the layer's normal interpretation.
 * `unitsVerified` and `averagingMinutes` default to the module settings.
 * Returns null for a malformed payload.
 */
export function normalizeCpcbRecords(
  payload,
  {
    now = Date.now(),
    unitsVerified = CPCB_UNITS_VERIFIED,
    averagingMinutes = CPCB_AVERAGING_MINUTES,
  } = {},
) {
  if (!Array.isArray(payload?.records)) return null;
  const rated = cpcbRated({ unitsVerified, averagingMinutes });
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
    if (!stations.has(stationId))
      stations.set(stationId, {
        stationId,
        name: row.station.trim(),
        zone: `${row.city.trim()}, ${row.state.trim()}`,
        country: 'IN',
        lat,
        lon,
      });
    const parameter = POLLUTANT_IDS[row.pollutant_id];
    const value = number(row.avg_value ?? row.pollutant_avg);
    const observedMs = cpcbObservationTime(row.last_update);
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
    const units = unitsVerified === true ? CPCB_UNITS[parameter] : null;
    readings.set(id, {
      ...stations.get(stationId),
      id,
      provider: 'cpcb',
      parameter,
      scale: parameter,
      value,
      units,
      ...(Number.isFinite(averagingMinutes) ? { averagingMinutes } : {}),
      observedMs,
      kind: 'observation',
      band: null,
      risk: null,
      rated,
      aqi: null,
      color: UNRATED_COLOR,
      label: units ? `${value} ${units}` : String(value),
      note: 'OGD reported average; not an overall AQI. Timestamp is source last_update.',
    });
  }
  return {
    stations: [...stations.values()].sort(
      (a, b) =>
        a.name.localeCompare(b.name) || a.stationId.localeCompare(b.stationId),
    ),
    readings: [...readings.values()].sort((a, b) => a.id.localeCompare(b.id)),
  };
}
