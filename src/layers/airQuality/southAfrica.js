/**
 * SAAQIS observations. Pure and portable: no network, scene, or UI imports.
 * A concentration is not an AQI; retain source units and never invent a band.
 */
import { AIR_QUALITY_UNRATED_COLOR } from './model.js';
export const SA_POLLUTANTS = Object.freeze([
  'PM2.5',
  'PM10',
  'NO2',
  'SO2',
  'O3',
  'CO',
]);
const UNITS = new Set([
  'µg/m³',
  'ug/m3',
  'µg/m3',
  'μg/m³',
  'ppb',
  'ppm',
  'mg/m³',
  'mg/m3',
]);
const text = (value) =>
  typeof value === 'string' ? value.trim().slice(0, 160) : '';
const numeric = (value) =>
  (typeof value === 'number' ||
    (typeof value === 'string' && value.trim() !== '')) &&
  Number.isFinite(Number(value))
    ? Number(value)
    : null;

/** Preserve the national catalog, including silent and inactive stations. */
export function normalizeSaStations(regions) {
  if (!Array.isArray(regions) || regions.length > 100)
    throw new Error('Malformed SAAQIS regions');
  const stations = new Map();
  const conflicting = new Set();
  let count = 0;
  for (const region of regions) {
    if (!Array.isArray(region?.stations))
      throw new Error('Malformed SAAQIS stations');
    count += region.stations.length;
  }
  if (count > 2000) throw new Error('SAAQIS catalog exceeds limit');
  for (const region of regions) {
    for (const station of region.stations) {
      const lat = numeric(station?.location?.latitude);
      const lon = numeric(station?.location?.longitude);
      if (
        lat === null ||
        lon === null ||
        Math.abs(lat) > 90 ||
        Math.abs(lon) > 180 ||
        !Number.isSafeInteger(station?.stationId) ||
        !text(station.name)
      )
        continue;
      const id = String(station.stationId);
      if (conflicting.has(id)) continue;
      const known = stations.get(id);
      if (known) {
        if (
          known.name !== text(station.name) ||
          known.lat !== lat ||
          known.lon !== lon
        ) {
          stations.delete(id);
          conflicting.add(id);
        }
        continue;
      }
      stations.set(id, {
        stationId: id,
        name: text(station.name),
        province: text(region.name),
        owner: text(station.owner),
        active: station.active === true,
        lat,
        lon,
      });
    }
  }
  if (!stations.size) throw new Error('Empty SAAQIS station catalog');
  return [...stations.values()];
}

/** Envista timestamps without an offset are South African local time, UTC+2. */
export function saObservationTime(value) {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?$/.test(
      value,
    )
  )
    return null;
  // Date.parse can roll impossible calendar dates (e.g. February 30) forward.
  const calendarDay = value.slice(0, 10);
  const midnight = new Date(`${calendarDay}T00:00:00Z`);
  if (
    !Number.isFinite(midnight.getTime()) ||
    midnight.toISOString().slice(0, 10) !== calendarDay ||
    Number(value.slice(11, 13)) > 23
  )
    return null;
  const time = Date.parse(
    /(?:Z|[+-]\d{2}:\d{2})$/.test(value) ? value : `${value}+02:00`,
  );
  return Number.isFinite(time) ? time : null;
}

/** Latest valid readings timed by the channel, else by the enclosing station. */
export function normalizeSaMeasurements(entries, stations) {
  if (!Array.isArray(entries) || entries.length > 2000)
    throw new Error('Malformed SAAQIS observations');
  const catalog = new Map(
    stations.map((station) => [station.stationId, station]),
  );
  const readings = new Map();
  for (const entry of entries) {
    const station = catalog.get(String(entry?.stationId));
    if (!station?.active || !entry.regionData) continue;
    if (
      !Array.isArray(entry.regionData.channels) ||
      entry.regionData.channels.length > 200
    )
      throw new Error('Malformed SAAQIS channels');
    for (const channel of entry.regionData.channels) {
      const parameter = text(channel?.name).toUpperCase();
      const value = numeric(channel?.value);
      const observedMs = saObservationTime(
        channel?.datetime ?? entry.regionData.datetime,
      );
      const units = text(channel?.units);
      if (
        channel?.valid !== true ||
        channel.active !== true ||
        !SA_POLLUTANTS.includes(parameter) ||
        !UNITS.has(units) ||
        value === null ||
        value < 0 ||
        observedMs === null
      )
        continue;
      const id = `saaqis:${station.stationId}:${parameter}`;
      const previous = readings.get(id);
      if (previous && previous.observedMs >= observedMs) continue;
      readings.set(id, {
        ...station,
        id,
        provider: 'saaqis',
        country: 'ZA',
        parameter,
        scale: parameter,
        units,
        value,
        observedMs,
        averagingMinutes: 60,
        kind: 'observation',
        band: null,
        color: AIR_QUALITY_UNRATED_COLOR,
        label: `${value.toFixed(2)} ${units}`,
        zone: station.province,
        note: 'Provisional SAAQIS hourly concentration; not an air quality index or an emissions estimate.',
      });
    }
  }
  return [...readings.values()];
}
