/**
 * GeoSphere Austria TAWES adapter — the Austrian automatic network.
 *
 * Roughly 285 active stations publishing every 10 minutes through the Data Hub
 * API. Keyless and CC BY 4.0.
 *
 * Two upstream calls, for two different reasons. The metadata call carries the
 * station names, states and altitudes, none of which the observation call
 * returns; the observation call requires an explicit `station_ids` list, so the
 * id set has to be read from metadata first.
 *
 * Units are taken from the dataset's own `/metadata` parameter descriptions:
 *   TL      air temperature, °C
 *   RF      relative humidity, %
 *   FF      wind speed over 10 minutes, m/s
 *   FFX     wind peak over 10 minutes, m/s
 *   DD      wind direction, degrees
 *   RR      precipitation over the last 10 minutes, mm
 *   SCHNEE  total snow depth, cm
 *
 * Pressure is deliberately absent. Neither published column is comparable
 * between stations: `P` is station level, and `PRED` is reduced only to a local
 * datum, correcting Sonnblick (3109 m) by 11 hPa where it corrects Wien
 * (198 m) by 25. See the registry entry and the pressure rule in
 * `../records.js`.
 */

import { TAWES_NETWORK_ID } from '../networks.js';
import { finiteOrNull, isoOrNull, textOrNull } from '../records.js';

/** The parameters requested, and the canonical field each becomes. */
export const TAWES_PARAMETERS = Object.freeze({
  TL: 'airTempC',
  RF: 'humidityPct',
  FF: 'windSpeedMs',
  FFX: 'windGustMs',
  DD: 'windDirDeg',
  RR: 'precipMm',
  SCHNEE: 'snowDepthCm',
});

/** The `parameters` query value, fixed by the table above. */
export const TAWES_PARAMETER_QUERY = Object.keys(TAWES_PARAMETERS).join(',');

/**
 * Station ids to request observations for.
 *
 * Only active stations: the metadata list retains decommissioned boxes, and
 * asking for them costs query length for columns that are always null.
 */
export function tawesStationIds(metadata) {
  const ids = [];
  for (const raw of Array.isArray(metadata?.stations)
    ? metadata.stations
    : []) {
    const id = textOrNull(raw?.id);
    if (id && raw.is_active !== false && /^[0-9A-Za-z-]{1,16}$/.test(id))
      ids.push(id);
  }
  return ids;
}

/** Normalize the metadata station list into partial records, keyed by id. */
export function normalizeTawesStations(metadata) {
  const stations = new Map();
  for (const raw of Array.isArray(metadata?.stations)
    ? metadata.stations
    : []) {
    const code = textOrNull(raw?.id);
    if (!code || raw.is_active === false) continue;
    stations.set(code, {
      networkId: TAWES_NETWORK_ID,
      code,
      label: titleCase(textOrNull(raw?.name)) || code,
      lat: finiteOrNull(raw?.lat),
      lon: finiteOrNull(raw?.lon),
      elevationM: finiteOrNull(raw?.altitude),
      region: textOrNull(raw?.state),
      country: 'AT',
    });
  }
  return stations;
}

/**
 * Station names are published in upper case (`ACHENKIRCH CAMPINGPLATZ`).
 *
 * Shouting every label would be the loudest thing on the map, so they are cased
 * for display. Separators inside a name are preserved, which matters for the
 * hyphenated and apostrophed names this network has.
 */
export function titleCase(value) {
  if (!value) return null;
  return value
    .toLocaleLowerCase('de-AT')
    .replace(
      /(^|[\s(/-])(\p{L})/gu,
      (_, lead, letter) => lead + letter.toLocaleUpperCase('de-AT'),
    );
}

/**
 * The index at which one station's readings sit.
 *
 * This is the trap in this feed. `timestamps` is the UNION of observation times
 * across every station requested, ascending, and each station's `data` arrays
 * align to it positionally while carrying a value at only ONE index: its own
 * latest. Reading `data[0]` therefore returns null for almost every station —
 * measured live, 275 of 285 stations sat at the last index and `data[0]` was
 * non-null for exactly one of them.
 *
 * So the index is discovered per station, and a null at the chosen index then
 * means a genuinely absent sensor rather than a stale slot.
 *
 * @returns {number} The index, or -1 when the station reported nothing.
 */
export function tawesReadingIndex(parameters, length) {
  let index = -1;
  for (const key of Object.keys(TAWES_PARAMETERS)) {
    const data = parameters?.[key]?.data;
    if (!Array.isArray(data)) continue;
    for (let at = Math.min(data.length, length) - 1; at > index; at--) {
      if (data[at] !== null && data[at] !== undefined) {
        index = at;
        break;
      }
    }
  }
  return index;
}

/**
 * Readings from one observation response, keyed by station code.
 *
 * Kept separate from the join because the observation call is chunked: a
 * `data` index is only meaningful against the `timestamps` array of the
 * response it arrived in, so each response must be read before any merging.
 */
export function tawesReadings(observations) {
  const timestamps = Array.isArray(observations?.timestamps)
    ? observations.timestamps.map(isoOrNull)
    : [];
  const readings = new Map();
  for (const feature of Array.isArray(observations?.features)
    ? observations.features
    : []) {
    const code = textOrNull(feature?.properties?.station);
    if (!code) continue;
    const parameters = feature.properties.parameters;
    const index = tawesReadingIndex(parameters, timestamps.length);
    const coordinates = feature.geometry?.coordinates;
    const reading = {
      measuredAt: index < 0 ? null : timestamps[index],
      lat: finiteOrNull(coordinates?.[1]),
      lon: finiteOrNull(coordinates?.[0]),
    };
    for (const [key, field] of Object.entries(TAWES_PARAMETERS)) {
      reading[field] =
        index < 0 ? null : finiteOrNull(parameters?.[key]?.data?.[index]);
    }
    readings.set(code, reading);
  }
  return readings;
}

const SILENT_READING = Object.freeze({
  measuredAt: null,
  airTempC: null,
  snowDepthCm: null,
  precipMm: null,
  pressureQffHpa: null,
  humidityPct: null,
  windSpeedMs: null,
  windGustMs: null,
  windDirDeg: null,
});

/**
 * Join readings onto the metadata stations.
 *
 * A station in metadata with no reading is still returned, silent, for the
 * same reason the SLF adapter keeps its silent boxes: the network as it is,
 * not only the part that answered. A station with a reading but no metadata
 * entry keeps the position the observation feature carries.
 */
export function joinTawesStationRecords(metadata, readings) {
  const stations = normalizeTawesStations(metadata);
  for (const [code, reading] of readings) {
    if (stations.has(code)) continue;
    stations.set(code, {
      networkId: TAWES_NETWORK_ID,
      code,
      label: code,
      lat: reading.lat,
      lon: reading.lon,
      elevationM: null,
      region: null,
      country: 'AT',
    });
  }
  return [...stations.values()].map((station) => {
    const {
      lat: _lat,
      lon: _lon,
      ...reading
    } = readings.get(station.code) ?? {};
    return { ...station, ...SILENT_READING, ...reading };
  });
}
