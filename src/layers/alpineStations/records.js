/**
 * The canonical Alpine station record, and the operations over a whole set.
 *
 * Every network adapter produces THIS shape, in THESE units, so nothing
 * downstream is network-aware:
 *
 *   id             `${networkId}:${code}` — globally unique across networks
 *   networkId      a registered network id
 *   code           the operator's own station code
 *   label          display name, never the bare code when a name is published
 *   lat, lon       WGS84 degrees
 *   elevationM     metres above sea level, or null
 *   region         canton / state, or null
 *   country        ISO 3166-1 alpha-2
 *   measuredAt     ISO 8601 UTC string, or null when the station is silent
 *   airTempC       °C
 *   snowDepthCm    cm
 *   precipMm       mm over the network's own reporting interval
 *   pressureQffHpa hPa, reduced to sea level with the actual temperature
 *   humidityPct    %
 *   windSpeedMs    m/s, mean over the reporting interval
 *   windGustMs     m/s, peak over the reporting interval
 *   windDirDeg     degrees, the direction the wind blows FROM (WMO convention)
 *
 * Two rules hold throughout.
 *
 * **Absent is not zero.** 0 °C, 0 mm and 0 cm are all real, common readings,
 * and a station without a given sensor leaves its column empty. Conflating the
 * two would invent measurements, so an absent reading stays `null` end to end.
 *
 * **Pressure is QFF, never station level.** Station-level pressure (QFE) is a
 * map of ALTITUDE, not weather: measured across SwissMetNet it spanned
 * 663-991 hPa on a day whose real synoptic spread was under 3 hPa. Only a
 * sea-level reduction using the actual temperature is comparable between
 * stations, and the ICAO-standard-atmosphere reduction (QNH) carries its own
 * altitude bias, so it is not an acceptable substitute.
 */

import { greatCircleKm } from '../../data/routePlausible.js';
import { alpineNetwork } from './networks.js';
import {
  formatParameter,
  msToKmh,
  parameterValue,
  parameterView,
  staleAfterMs,
  windCompass,
} from './parameters.js';

/** The reading fields a record carries, in card order. */
export const READING_FIELDS = Object.freeze([
  'airTempC',
  'snowDepthCm',
  'precipMm',
  'pressureQffHpa',
  'humidityPct',
  'windSpeedMs',
  'windGustMs',
  'windDirDeg',
]);

/** Coerce to a finite number; blank, null, '-' and non-numeric all mean absent. */
export function finiteOrNull(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const text = String(value).trim();
  if (!text || text === '-' || text === '--') return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Trim to a non-empty string, or null. */
export function textOrNull(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

/** An ISO 8601 UTC instant, or null. Rejects a date that does not round-trip. */
export function isoOrNull(value) {
  const parsed = Date.parse(typeof value === 'string' ? value : '');
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

const inRange = (value, limit) =>
  Number.isFinite(value) && Math.abs(value) <= limit;

/**
 * Build one canonical record, or null when it cannot be drawn.
 *
 * A record without identity or a usable position is dropped individually
 * rather than failing the network: one degenerate station must never blank a
 * whole country, because a failed first update makes the lifecycle disable the
 * layer outright.
 */
export function alpineStationRecord(raw) {
  const networkId = textOrNull(raw?.networkId);
  const code = textOrNull(raw?.code);
  const lat = finiteOrNull(raw?.lat);
  const lon = finiteOrNull(raw?.lon);
  if (!networkId || !alpineNetwork(networkId) || !code) return null;
  if (!inRange(lat, 90) || !inRange(lon, 180)) return null;
  const network = alpineNetwork(networkId);
  const readings = {};
  for (const field of READING_FIELDS)
    readings[field] = finiteOrNull(raw[field]);
  // A direction outside the compass is a broken vane, not a bearing to draw.
  if (readings.windDirDeg !== null && !inRange(readings.windDirDeg - 180, 180))
    readings.windDirDeg = null;
  const measuredAt = isoOrNull(raw?.measuredAt);
  return {
    id: `${networkId}:${code}`,
    networkId,
    code,
    label: textOrNull(raw?.label) || code,
    lat,
    lon,
    elevationM: finiteOrNull(raw?.elevationM),
    region: textOrNull(raw?.region),
    country: textOrNull(raw?.country) || network.country,
    measuredAt,
    ...readings,
  };
}

/** Whether a record carries any reading at all. */
export function isReporting(station) {
  return READING_FIELDS.some((field) => Number.isFinite(station?.[field]));
}

/**
 * Whether a reading is too old to present as current.
 *
 * A silent station is NOT stale: it has no reading to be out of date, and the
 * two read differently on the card.
 */
export function isStale(station, now = Date.now()) {
  const measured = Date.parse(station?.measuredAt ?? '');
  // A reading whose time will not parse cannot be shown as current: there is
  // no way to tell whether it is ten minutes or ten days old. A SILENT station
  // is still not stale, because it has no reading to be out of date.
  if (!Number.isFinite(measured)) return isReporting(station);
  return now - measured > staleAfterMs(alpineNetwork(station?.networkId));
}

/**
 * Combine per-network record arrays into one set, in stable id order.
 *
 * Stable order matters because the layer rebuilds entities from this array and
 * the rail card lists from it: an unstable order would reshuffle the list on
 * every poll with nothing having changed.
 */
export function mergeNetworkStations(groups) {
  const byId = new Map();
  for (const group of Array.isArray(groups) ? groups : []) {
    for (const raw of Array.isArray(group) ? group : []) {
      const record = alpineStationRecord(raw);
      if (record && !byId.has(record.id)) byId.set(record.id, record);
    }
  }
  return [...byId.values()].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
}

/**
 * Counts for the row and the card.
 *
 * `reporting` is the honest denominator. It is normal for part of a
 * high-Alpine network to be offline through a winter, and the panel should say
 * so rather than quietly shrinking the network to the boxes that answered.
 *
 * `stale` is NOT reported here. `layerFeedState()` renders a row as STALE on
 * any truthy `stats.stale`, so a count of late stations placed there made a
 * healthy 157-station feed read STALE. Late stations are `staleStations`; the
 * feed-level `stale` means only that the proxy served a cached payload.
 */
export function summarizeStations(
  stations,
  { parameterId, now = Date.now() } = {},
) {
  const list = Array.isArray(stations) ? stations : [];
  const view = parameterId ? parameterView(parameterId) : null;
  const byNetwork = new Map();
  let reporting = 0;
  let staleStations = 0;
  let measuring = 0;
  let newest = null;
  const values = [];
  for (const station of list) {
    const counts = byNetwork.get(station.networkId) || {
      total: 0,
      reporting: 0,
    };
    counts.total++;
    if (isReporting(station)) {
      counts.reporting++;
      reporting++;
      if (isStale(station, now)) staleStations++;
      const measured = Date.parse(station.measuredAt ?? '');
      if (Number.isFinite(measured) && (newest === null || measured > newest))
        newest = measured;
    }
    byNetwork.set(station.networkId, counts);
    // Only readings the MAP is willing to draw count toward the card's range.
    // A station the markers show as offline must not quietly set the network
    // minimum or maximum from a week-old figure.
    if (view && !isStale(station, now)) {
      const value = parameterValue(station, view);
      if (Number.isFinite(value)) {
        measuring++;
        values.push(value);
      }
    }
  }
  return {
    total: list.length,
    reporting,
    staleStations,
    measuring,
    networks: [...byNetwork.entries()].map(([id, counts]) => ({
      id,
      ...counts,
    })),
    newestAt: newest === null ? null : new Date(newest).toISOString(),
    min: values.length ? Math.min(...values) : null,
    max: values.length ? Math.max(...values) : null,
  };
}

/**
 * The nearest stations to a point, nearest first.
 *
 * The rail card needs "what is around here" rather than "everything loaded",
 * so this takes the camera's own centre and a cap. Silent stations are
 * included: a box that is down is part of the picture of the network, and the
 * card labels it rather than hiding it.
 */
export function nearestStations(
  stations,
  { lat, lon, limit = 6, maxKm = Infinity } = {},
) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return [];
  const scored = [];
  for (const station of Array.isArray(stations) ? stations : []) {
    const km = greatCircleKm(lat, lon, station.lat, station.lon);
    if (!Number.isFinite(km) || km > maxKm) continue;
    scored.push({ station, km });
  }
  scored.sort((a, b) => a.km - b.km || (a.station.id < b.station.id ? -1 : 1));
  return scored.slice(0, Math.max(0, limit));
}

/** Wind as one phrase, in the meteorological reading the operator published. */
export function describeWind(station) {
  const kmh = msToKmh(station?.windSpeedMs);
  if (kmh === null) return null;
  const compass = windCompass(station.windDirDeg);
  const gust = msToKmh(station.windGustMs);
  return `${kmh} km/h${compass ? ` ${compass}` : ''}${
    gust === null ? '' : ` · gust ${gust} km/h`
  }`;
}

/**
 * Card lines for one station.
 *
 * Every figure carries its unit and an absent reading is omitted entirely, so
 * a line is never printed for a measurement the station did not make.
 */
export function stationCardLines(station, view, { now = Date.now() } = {}) {
  if (!station) return [];
  const network = alpineNetwork(station.networkId);
  const lines = [];
  const place = [
    network?.label,
    station.region,
    Number.isFinite(station.elevationM)
      ? `${Math.round(station.elevationM)} m`
      : null,
  ]
    .filter(Boolean)
    .join(' · ');
  if (place) lines.push({ id: 'place', text: place, muted: true });
  if (!isReporting(station)) {
    lines.push({ id: 'silent', text: 'No current reading', muted: true });
    return lines;
  }
  const selected = formatParameter(parameterValue(station, view), view);
  lines.push({
    id: 'selected',
    text: selected
      ? `${view.label}: ${selected}`
      : `${view.label}: not measured here`,
    muted: !selected,
  });
  const wind = describeWind(station);
  if (wind && view.id !== 'wind')
    lines.push({ id: 'wind', text: `Wind ${wind}` });
  if (Number.isFinite(station.airTempC) && view.id !== 'temperature') {
    const humidity = Number.isFinite(station.humidityPct)
      ? ` · ${Math.round(station.humidityPct)}% RH`
      : '';
    lines.push({
      id: 'air',
      text: `Air ${station.airTempC.toFixed(1)} °C${humidity}`,
    });
  }
  if (Number.isFinite(station.snowDepthCm) && view.id !== 'snow') {
    lines.push({
      id: 'snow',
      text: `Snow ${Math.round(station.snowDepthCm)} cm`,
    });
  }
  if (station.measuredAt) {
    lines.push({
      id: 'measured',
      text: `${utcMinute(station.measuredAt)}${isStale(station, now) ? ' · late' : ''}`,
      muted: true,
    });
  }
  return lines;
}

/** `MM-DD HH:MM UTC`, the format the weather rail already reads in. */
export function utcMinute(iso) {
  const parsed = Date.parse(iso ?? '');
  if (!Number.isFinite(parsed)) return 'Unavailable';
  return `${new Date(parsed).toISOString().slice(5, 16).replace('T', ' ')} UTC`;
}
