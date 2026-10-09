/**
 * MeteoSwiss SwissMetNet adapter — the Swiss federal automatic network.
 *
 * 159 stations publishing every 10 minutes as Open Government Data under
 * CC BY 4.0. Keyless.
 *
 * TWO fixed files, and deliberately no per-station requests:
 *
 *   ogd-smn_meta_stations.csv  identity, canton, elevation and WGS84 position
 *   VQHA80.csv                 the whole network's current readings, ~16 KB
 *
 * The obvious route through the STAC collection costs one CSV per station —
 * about 160 upstream requests for a single refresh of a single network. These
 * two files carry the same identity and the same current values in two
 * requests, and the metadata half changes so rarely it is cached for a day.
 *
 * The price is snow depth: `htoauts0` is published per station but is NOT a
 * VQHA80 column, so SwissMetNet contributes no snow here. That is why its
 * registry entry omits `snow`. Swiss snow depth comes from SLF IMIS, which is
 * the network built for it and sits above the tree line where it matters.
 *
 * Units come from the published parameter inventory
 * (ogd-smn_meta_parameters.csv) and are NOT guessed:
 *   tre200s0  air temperature 2 m, °C
 *   rre150z0  precipitation, ten minute total, mm
 *   ure200s0  relative humidity 2 m, %
 *   dkl010z0  wind direction, ten minute mean, degrees
 *   fu3010z0  wind speed, ten minute mean, KM/H
 *   fu3010z1  gust peak (one second), KM/H
 *   pp0qffs0  pressure reduced to sea level (QFF), hPa
 *
 * The wind columns are the trap: the `fu3` family is km/h while the `fkl`
 * family is m/s, and both exist for the same quantity. Canonical records store
 * m/s, so these are converted rather than passed through.
 */

import { SMN_NETWORK_ID } from '../networks.js';
import { finiteOrNull, textOrNull } from '../records.js';

/** VQHA80 column to the canonical field it becomes. */
export const SMN_OBSERVATION_COLUMNS = Object.freeze({
  tre200s0: 'airTempC',
  rre150z0: 'precipMm',
  ure200s0: 'humidityPct',
  dkl010z0: 'windDirDeg',
  pp0qffs0: 'pressureQffHpa',
});

/** Columns in km/h that become m/s. */
export const SMN_WIND_COLUMNS = Object.freeze({
  fu3010z0: 'windSpeedMs',
  fu3010z1: 'windGustMs',
});

/**
 * Pressure columns this adapter must never read.
 *
 * `prestas0` is station level (QFE), a map of altitude rather than of weather.
 * `pp0qnhs0` reduces to sea level through the ICAO standard atmosphere, so it
 * carries an altitude bias of its own. Only `pp0qffs0` is comparable between
 * stations. Named here so the exclusion is a stated decision with a test
 * behind it, not an omission someone later "fixes".
 */
export const SMN_REJECTED_PRESSURE_COLUMNS = Object.freeze([
  'prestas0',
  'pp0qnhs0',
]);

/**
 * Read a semicolon-delimited MeteoSwiss CSV into header-keyed rows.
 *
 * Both files are plain: one header line, no quoting, no embedded separators.
 * An absent reading is `-`, which `finiteOrNull` already treats as absent.
 *
 * @param {string} text Already decoded. The metadata file is ISO-8859-1, not
 *   UTF-8, so its bytes must be decoded by the caller that has them; decoding
 *   it as UTF-8 mangles Oberägeri, Bière, Lötschental and Château-d'Oex.
 */
export function readSemicolonCsv(text) {
  if (typeof text !== 'string' || !text.trim()) return [];
  const lines = text.split(/\r?\n/).filter((line) => line.trim());
  if (lines.length < 2) return [];
  const header = lines[0].split(';').map((name) => name.trim());
  return lines.slice(1).map((line) => {
    const cells = line.split(';');
    const row = {};
    header.forEach((name, index) => {
      row[name] = (cells[index] ?? '').trim();
    });
    return row;
  });
}

/**
 * Parse VQHA80's `YYYYMMDDHHMM` stamp as UTC.
 *
 * Both halves of this are traps. `new Date(text)` cannot read the layout at
 * all, and any local-time reading is one or two hours out in Switzerland,
 * which is enough to make a current reading look stale or a stale one current.
 */
export function parseSmnTimestamp(value) {
  const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(
    String(value ?? '').trim(),
  );
  if (!match) return null;
  const [, year, month, day, hour, minute] = match.map(Number);
  const stamp = Date.UTC(year, month - 1, day, hour, minute);
  if (!Number.isFinite(stamp)) return null;
  const iso = new Date(stamp).toISOString();
  // Reject a date that does not round-trip, which catches 2026-02-31.
  return iso.slice(0, 16).replace(/[-:T]/g, '') ===
    `${match[1]}${match[2]}${match[3]}${match[4]}${match[5]}`
    ? iso
    : null;
}

/** Normalize the station metadata CSV into partial records, keyed by code. */
export function normalizeSmnStations(csv) {
  const stations = new Map();
  for (const row of readSemicolonCsv(csv)) {
    const code = textOrNull(row.station_abbr);
    const lat = finiteOrNull(row.station_coordinates_wgs84_lat);
    const lon = finiteOrNull(row.station_coordinates_wgs84_lon);
    if (!code || lat === null || lon === null) continue;
    stations.set(code, {
      networkId: SMN_NETWORK_ID,
      code,
      label: textOrNull(row.station_name) || code,
      lat,
      lon,
      elevationM: finiteOrNull(row.station_height_masl),
      region: textOrNull(row.station_canton),
      country: 'CH',
    });
  }
  return stations;
}

/** Normalize one VQHA80 row into canonical fields. */
export function normalizeSmnObservation(row) {
  const code = textOrNull(row?.['Station/Location']);
  if (!code) return null;
  const reading = { code, measuredAt: parseSmnTimestamp(row.Date) };
  for (const [column, field] of Object.entries(SMN_OBSERVATION_COLUMNS))
    reading[field] = finiteOrNull(row[column]);
  for (const [column, field] of Object.entries(SMN_WIND_COLUMNS)) {
    const kmh = finiteOrNull(row[column]);
    reading[field] = kmh === null ? null : Math.round((kmh / 3.6) * 100) / 100;
  }
  return reading;
}

/**
 * Join the current-values file onto the metadata stations.
 *
 * Only metadata supplies a position, so a reading for a station absent from it
 * is dropped: there is nowhere on the globe to draw it. Measured live, the two
 * files disagreed by exactly one station in each direction out of 159.
 */
export function joinSmnStations(metadataCsv, observationsCsv) {
  const stations = normalizeSmnStations(metadataCsv);
  const readings = new Map();
  for (const row of readSemicolonCsv(observationsCsv)) {
    const reading = normalizeSmnObservation(row);
    if (reading) readings.set(reading.code, reading);
  }
  return [...stations.values()].map((station) => {
    const reading = readings.get(station.code);
    return {
      ...station,
      measuredAt: reading?.measuredAt ?? null,
      airTempC: reading?.airTempC ?? null,
      precipMm: reading?.precipMm ?? null,
      pressureQffHpa: reading?.pressureQffHpa ?? null,
      humidityPct: reading?.humidityPct ?? null,
      windSpeedMs: reading?.windSpeedMs ?? null,
      windGustMs: reading?.windGustMs ?? null,
      windDirDeg: reading?.windDirDeg ?? null,
      snowDepthCm: null,
    };
  });
}
