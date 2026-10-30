import { regionalDistanceM } from '../../../src/data/regionalModel.js';

export const SMN_SOURCE_URL = 'https://www.smn.gob.ar/descarga-de-datos';
export const SMN_MAX_DISTANCE_KM = 50;
// The feed omits its time zone. This source-clock expiry guard is deliberately
// conservative for UTC/Argentina clocks; it does not establish an instant.
const SOURCE_CLOCK_WINDOW_MS = 6 * 60 * 60_000;
const MONTHS =
  'enero febrero marzo abril mayo junio julio agosto septiembre octubre noviembre diciembre'.split(
    ' ',
  );
const WIND = {
  norte: 0,
  noreste: 45,
  este: 90,
  sudeste: 135,
  sur: 180,
  sudoeste: 225,
  oeste: 270,
  noroeste: 315,
};
// Explicit name differences checked against the official station catalog (WMO).
// Airport and observatory names are never fuzzily merged.
const ALIASES = {
  'aeroparque buenos aires': '87582',
  'buenos aires': '87585',
  'pcia roque saenz pena': '87148',
  'esc aviacion militar': '87347',
  'pilar obs': '87349',
  'villa maria del rio seco': '87244',
  mercedes: '87281',
  'la quiaca': '87007',
  'jujuy universidad nacional': '87043',
  'santa rosa del conlara': '87444',
  'santa fe': '87371',
  'base carlini': '89053',
};

function nameKey(name) {
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[.]/g, '')
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/ aero$/, '');
}

function number(value, min, max) {
  if (!/^[+-]?\d+(?:[.,]\d+)?$/.test(value)) return null;
  const n = Number(value.replace(',', '.'));
  return n >= min && n <= max ? n : null;
}

/** Parse the official fixed-width station catalog; ignore headers/wrapped text. */
export function parseSmnStations(text) {
  const stations = new Map();
  const duplicates = new Set();
  for (const line of text.split(/\r?\n/)) {
    const match = line
      .slice(67)
      .trim()
      .match(
        /^(-?\d+)\s+(\d+)\s+(-?\d+)\s+(\d+)\s+(-?\d+)\s+(\d{5})(?:\s+([A-Z]{4}))?$/,
      );
    if (!match) continue;
    const [, lat, latMin, lon, lonMin, altitude, id, icao] = match;
    if (Number(latMin) >= 60 || Number(lonMin) >= 60) continue;
    const degrees = (d, m) =>
      (Number(d) < 0 || d === '-0' ? -1 : 1) *
      (Math.abs(Number(d)) + Number(m) / 60);
    const latitude = degrees(lat, latMin);
    const longitude = degrees(lon, lonMin);
    const name = line.slice(0, 30).trim();
    if (!name || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) continue;
    if (stations.has(id)) duplicates.add(id);
    stations.set(id, {
      id,
      name,
      province: line.slice(30, 67).trim(),
      latitude,
      longitude,
      elevationM: Number(altitude),
      icao: icao || null,
    });
  }
  for (const id of duplicates) stations.delete(id);
  return [...stations.values()];
}

function reportedTime(date, time) {
  const match = date.toLowerCase().match(/^(\d{1,2})-([a-z]+)-(\d{4})$/);
  if (!match || !/^\d{2}:\d{2}$/.test(time)) return null;
  const month = MONTHS.indexOf(match[2]);
  const [hour, minute] = time.split(':').map(Number);
  if (month < 0 || hour > 23 || minute > 59) return null;
  const calendar = new Date(
    Date.UTC(Number(match[3]), month, Number(match[1]), hour, minute),
  );
  if (
    calendar.getUTCFullYear() !== Number(match[3]) ||
    calendar.getUTCMonth() !== month ||
    calendar.getUTCDate() !== Number(match[1])
  )
    return null;
  return calendar.toISOString().slice(0, 16); // Wall time only: intentionally no Z.
}

/** Parse semicolon-separated present-weather rows and join only known stations. */
export function parseSmnObservations(text, stations) {
  const byId = new Map(stations.map((station) => [station.id, station]));
  const byName = new Map();
  for (const station of stations) {
    const key = nameKey(station.name);
    byName.set(key, byName.has(key) ? null : station);
  }
  const observations = [];
  for (const line of text.split(/\r?\n/)) {
    const fields = line.split(';').map((field) => field.trim());
    if (fields.length !== 10) continue;
    const [
      name,
      date,
      time,
      condition,
      visibility,
      temperature,
      apparent,
      humidity,
      wind,
      pressure,
    ] = fields;
    const key = nameKey(name);
    const station = Object.hasOwn(ALIASES, key)
      ? byId.get(ALIASES[key])
      : byName.get(key);
    const reportedAt = reportedTime(date, time);
    const temperatureC = number(temperature, -90, 60);
    if (!station || !reportedAt || temperatureC === null) continue;
    const windMatch = wind
      .toLowerCase()
      .match(
        /^(norte|noreste|este|sudeste|sur|sudoeste|oeste|noroeste)\s+(\d+(?:[.,]\d+)?)$/,
      );
    const visibilityMatch = visibility.match(/^(\d+(?:[.,]\d+)?)\s*km$/i);
    const visibilityKm = visibilityMatch
      ? number(visibilityMatch[1], 0, 200)
      : null;
    observations.push({
      source: 'smn',
      sourceUrl: SMN_SOURCE_URL,
      kind: 'station-observation',
      station,
      reportedAt,
      timeZone: null,
      observedAt: null,
      temperatureC,
      apparentTemperatureC: number(apparent, -100, 80),
      humidityPct: number(humidity, 0, 100),
      stationPressureHpa: number(pressure.replace(/\s*\/$/, ''), 300, 1100),
      windKph: /^calma$/i.test(wind)
        ? 0
        : windMatch
          ? number(windMatch[2], 0, 400)
          : null,
      windDirectionDeg: windMatch ? WIND[windMatch[1]] : null,
      visibilityM: visibilityKm === null ? null : visibilityKm * 1000,
      conditionText:
        condition &&
        condition.length <= 200 &&
        !/^(sin datos|s\/d|-)$/i.test(condition)
          ? condition
          : null,
      // A description is not a measured amount or a WMO code.
      precipitationMm: null,
      cloudCoverPct: null,
      weatherCode: null,
    });
  }
  return observations;
}

/** Recheck source-clock expiry and recompute distance for this query point. */
export function smnWeatherAtPoint(weather, point, now = Date.now()) {
  if (
    !weather?.station ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d$/.test(weather.reportedAt || '')
  )
    return null;
  const clockAge = now - Date.parse(`${weather.reportedAt}:00Z`);
  const distanceKm = regionalDistanceM(point, weather.station) / 1000;
  if (
    !Number.isFinite(clockAge) ||
    clockAge < -5 * 60_000 ||
    clockAge > SOURCE_CLOCK_WINDOW_MS ||
    !Number.isFinite(distanceKm) ||
    distanceKm > SMN_MAX_DISTANCE_KM
  )
    return null;
  return { ...weather, station: { ...weather.station, distanceKm } };
}

/** Select the closest usable observation; prefer the newest row at a station. */
export function selectSmnObservation(observations, point, now = Date.now()) {
  return (
    observations
      .map((weather) => smnWeatherAtPoint(weather, point, now))
      .filter(Boolean)
      .sort(
        (a, b) =>
          a.station.distanceKm - b.station.distanceKm ||
          b.reportedAt.localeCompare(a.reportedAt) ||
          a.station.id.localeCompare(b.station.id),
      )[0] || null
  );
}
