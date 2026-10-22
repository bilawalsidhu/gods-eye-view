/**
 * WSL/SLF IMIS adapter — the Swiss avalanche-warning measurement grid.
 *
 * Roughly 200 automatic stations, most above the tree line between 2,000 and
 * 3,000 m, publishing every 30 minutes. Keyless and CC BY 4.0.
 *
 * Two upstream calls have to be joined, and the join belongs here rather than
 * in the browser: the measurements endpoint returns a rolling window for the
 * whole network in one response (~9,500 rows, ~3 MB) and the client only needs
 * the newest row per station.
 *
 * Units are taken from the published OpenAPI schema at
 * measurement-api.slf.ch/openapi.json and are NOT guessed:
 *   HS              snow height, cm
 *   TA_30MIN_MEAN   air temperature, °C
 *   RH_30MIN_MEAN   relative humidity, %
 *   VW_30MIN_MEAN   wind speed, vectorial mean, m/s
 *   VW_30MIN_MAX    wind speed, 5 s maximum, m/s
 *   DW_30MIN_MEAN   wind direction, degrees
 *   elevation       metres above sea level, with WGS84 lon/lat
 *
 * IMIS publishes neither precipitation nor pressure, which is why the registry
 * entry lists only snow, wind and temperature.
 */

import { SLF_NETWORK_ID } from '../networks.js';
import { finiteOrNull, isoOrNull, textOrNull } from '../records.js';

/**
 * Normalize one entry from `/public/api/imis/stations`.
 *
 * The network's own station TYPE (snow field, slope, wind mast, FlowCapt) is
 * read and dropped: the canonical record is network-neutral, nothing
 * downstream can present an SLF-only label, and carrying a field no consumer
 * reads only invites someone to trust it later.
 */
export function normalizeSlfStation(raw) {
  const code = textOrNull(raw?.code);
  if (!code) return null;
  return {
    networkId: SLF_NETWORK_ID,
    code,
    label: textOrNull(raw?.label) || code,
    lat: finiteOrNull(raw?.lat),
    lon: finiteOrNull(raw?.lon),
    elevationM: finiteOrNull(raw?.elevation),
    region: textOrNull(raw?.canton_code),
    country: textOrNull(raw?.country_code) || 'CH',
  };
}

/** Normalize one 30-minute measurement row into canonical fields. */
export function normalizeSlfMeasurement(raw) {
  const code = textOrNull(raw?.station_code);
  if (!code) return null;
  return {
    code,
    measuredAt: isoOrNull(raw?.measure_date),
    snowDepthCm: finiteOrNull(raw?.HS),
    airTempC: finiteOrNull(raw?.TA_30MIN_MEAN),
    humidityPct: finiteOrNull(raw?.RH_30MIN_MEAN),
    windSpeedMs: finiteOrNull(raw?.VW_30MIN_MEAN),
    windGustMs: finiteOrNull(raw?.VW_30MIN_MAX),
    windDirDeg: finiteOrNull(raw?.DW_30MIN_MEAN),
  };
}

/**
 * Reduce the rolling measurement window to the newest row per station.
 *
 * This is the join's hot path, so the comparison is a string compare on the
 * ISO 8601 UTC timestamp, which sorts lexicographically and allocates nothing.
 * A row whose date did not parse loses to any row that did.
 */
export function latestSlfMeasurements(rows) {
  const latest = new Map();
  for (const raw of Array.isArray(rows) ? rows : []) {
    const row = normalizeSlfMeasurement(raw);
    if (!row) continue;
    const held = latest.get(row.code);
    if (!held || (row.measuredAt || '') > (held.measuredAt || ''))
      latest.set(row.code, row);
  }
  return latest;
}

/**
 * Join stations to their newest measurement.
 *
 * A station with no measurement is still returned. The map should show the
 * network as it really is rather than silently hiding boxes that are down, and
 * a high-Alpine network always has some.
 */
export function joinSlfStations(stations, measurements) {
  const latest = latestSlfMeasurements(measurements);
  const joined = [];
  for (const raw of Array.isArray(stations) ? stations : []) {
    const station = normalizeSlfStation(raw);
    if (!station) continue;
    const reading = latest.get(station.code);
    joined.push({
      ...station,
      measuredAt: reading?.measuredAt ?? null,
      airTempC: reading?.airTempC ?? null,
      snowDepthCm: reading?.snowDepthCm ?? null,
      humidityPct: reading?.humidityPct ?? null,
      windSpeedMs: reading?.windSpeedMs ?? null,
      windGustMs: reading?.windGustMs ?? null,
      windDirDeg: reading?.windDirDeg ?? null,
      precipMm: null,
      pressureQffHpa: null,
    });
  }
  return joined;
}
