/** Portable OpenAQ normalization; latest values carry no EEA band (the AQI view rates them). */
import { AIR_QUALITY_UNRATED_COLOR } from './model.js';
import { interpretHourly } from './interpretation.js';
export const OPENAQ_POLLUTANTS = Object.freeze([
  'PM2.5',
  'PM10',
  'NO2',
  'SO2',
  'O3',
  'CO',
]);
export const OPENAQ_PARAMETER_NAMES = Object.freeze({
  pm25: 'PM2.5',
  pm10: 'PM10',
  no2: 'NO2',
  so2: 'SO2',
  o3: 'O3',
  co: 'CO',
});
const text = (v) => (typeof v === 'string' ? v.trim().slice(0, 200) : '');
const coordinate = (v, max) =>
  typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= max;

/** Preserve identity, sensor metadata and originating-network attribution. */
export function normalizeOpenAqLocations(locations) {
  const unique = new Map();
  for (const row of locations) {
    if (
      !Number.isSafeInteger(row?.id) ||
      row.isMobile === true ||
      !coordinate(row.coordinates?.latitude, 90) ||
      !coordinate(row.coordinates?.longitude, 180) ||
      !Array.isArray(row.sensors)
    )
      continue;
    const sensors = row.sensors
      .filter(
        (s) =>
          Number.isSafeInteger(s.id) &&
          OPENAQ_PARAMETER_NAMES[s.parameter?.name] &&
          text(s.parameter?.units),
      )
      .map((s) => ({
        id: s.id,
        parameter: OPENAQ_PARAMETER_NAMES[s.parameter.name],
        units: text(s.parameter.units),
      }))
      .slice(0, 64);
    if (!sensors.length) continue;
    unique.set(row.id, {
      stationId: String(row.id),
      name: text(row.name) || String(row.id),
      lat: row.coordinates.latitude,
      lon: row.coordinates.longitude,
      country: text(row.country?.code),
      monitor: row.isMonitor === true,
      zone: text(row.locality) || text(row.country?.name),
      owner: text(row.owner?.name),
      network: text(row.provider?.name),
      sensors,
      licenses: (row.licenses || []).slice(0, 20).map((l) => ({
        name: text(l.name),
        attribution: text(l.attribution?.name),
        url:
          /^https?:\/\//.test(l.attribution?.url || '') &&
          l.attribution.url.length <= 500
            ? l.attribution.url
            : null,
      })),
      lastObservedMs: Date.parse(row.datetimeLast?.utc) || null,
      firstObservedMs: Date.parse(row.datetimeFirst?.utc) || null,
    });
  }
  return [...unique.values()];
}

/** Sensor IDs join latest values to parameters; no positional assumptions. */
export function normalizeOpenAqLatest(station, results, now = Date.now()) {
  const records = new Map();
  for (const item of results) {
    const sensor = station.sensors.find((s) => s.id === item.sensorsId);
    const observedMs = Date.parse(item.datetime?.utc);
    if (
      !sensor ||
      item.locationsId !== Number(station.stationId) ||
      typeof item.value !== 'number' ||
      !Number.isFinite(item.value) ||
      item.value < 0 ||
      !Number.isFinite(observedMs) ||
      observedMs > now + 300_000 ||
      now - observedMs > 6 * 3600_000
    )
      continue;
    const id = `openaq:${station.stationId}:${sensor.parameter}`;
    const previous = records.get(id);
    if (
      previous &&
      (previous.observedMs > observedMs ||
        (previous.observedMs === observedMs && previous.sensorId <= sensor.id))
    )
      continue;
    records.set(id, {
      stationId: station.stationId,
      name: station.name,
      lat: station.lat,
      lon: station.lon,
      country: station.country,
      zone: station.zone,
      owner: station.owner,
      network: station.network,
      licenses: station.licenses,
      monitor: station.monitor,
      id,
      provider: 'openaq',
      sensorId: sensor.id,
      parameter: sensor.parameter,
      scale: sensor.parameter,
      units: sensor.units,
      value: item.value,
      observedMs,
      kind: 'observation',
      averagingMinutes: null,
      band: null,
      color: AIR_QUALITY_UNRATED_COLOR,
      label: `${item.value.toFixed(2)} ${sensor.units}`,
      note: 'OpenAQ observation; source averaging period unspecified; not an AQI or emissions estimate.',
    });
  }
  return [...records.values()];
}

/** Normalize an explicit sensor's hourly aggregates, retaining coverage/flags.
 * Never infer an hour from a latest-value timestamp or reporting cadence.
 */
export function normalizeOpenAqHours(
  station,
  sensor,
  results,
  now = Date.now(),
) {
  const hours = results
    .filter((row) => {
      const from = Date.parse(row.period?.datetimeFrom?.utc);
      const to = Date.parse(row.period?.datetimeTo?.utc);
      return (
        Number.isFinite(row.value) &&
        row.value >= 0 &&
        row.period?.interval === '01:00:00' &&
        to - from === 3600_000 &&
        to <= now &&
        OPENAQ_PARAMETER_NAMES[row.parameter?.name] === sensor.parameter &&
        row.parameter?.units === sensor.units
      );
    })
    .sort(
      (a, b) =>
        Date.parse(b.period.datetimeTo.utc) -
        Date.parse(a.period.datetimeTo.utc),
    );
  if (!hours.length) return [];
  const hour = hours[0];
  return normalizeOpenAqLatest(
    station,
    [
      {
        locationsId: Number(station.stationId),
        sensorsId: sensor.id,
        value: hour.value,
        datetime: hour.period.datetimeTo,
      },
    ],
    now,
  ).map((reading) =>
    interpretHourly({
      ...reading,
      averagingMinutes: 60,
      periodStart: hour.period.datetimeFrom.utc,
      periodEnd: hour.period.datetimeTo.utc,
      coveragePercent: hour.coverage?.percentCoverage ?? null,
      qualityFlagged: hour.flagInfo?.hasFlags !== false,
      note: `OpenAQ hourly mean; GEV comparison against ${
        reading.parameter === 'CO' ? 'WHO-based' : 'EEA'
      } pollutant bands; not an overall AQI or emissions estimate.`,
    }),
  );
}

/**
 * An explicit sensor's valid hourly means as `{endMs, value, flagged,
 * coverage}`, oldest first, value in the sensor's units: the series the US
 * AQI's NowCast and 8-hour means read (`usAqi.js`). Never inferred from a
 * latest-value timestamp.
 */
export function normalizeOpenAqHourSeries(sensor, results, now = Date.now()) {
  const hours = new Map();
  for (const row of Array.isArray(results) ? results : []) {
    const from = Date.parse(row?.period?.datetimeFrom?.utc);
    const to = Date.parse(row?.period?.datetimeTo?.utc);
    if (
      typeof row.value !== 'number' ||
      !Number.isFinite(row.value) ||
      row.value < 0 ||
      row.period?.interval !== '01:00:00' ||
      to - from !== 3600_000 ||
      to > now ||
      OPENAQ_PARAMETER_NAMES[row.parameter?.name] !== sensor.parameter ||
      row.parameter?.units !== sensor.units
    )
      continue;
    const coverage = row.coverage?.percentCoverage;
    hours.set(to, {
      endMs: to,
      value: row.value,
      flagged: row.flagInfo?.hasFlags !== false,
      coverage: Number.isFinite(coverage) ? coverage : null,
    });
  }
  return [...hours.values()].sort((a, b) => a.endMs - b.endMs);
}

/**
 * A sensor's hourly means as readings of its station, one per hour
 * (`averagingMinutes: 60`), for the AQI view to fold (`aqiStations`).
 */
export function openAqHourReadings(station, sensor, hours) {
  return hours.map((hour) => ({
    stationId: station.stationId,
    name: station.name,
    lat: station.lat,
    lon: station.lon,
    country: station.country,
    zone: station.zone,
    owner: station.owner,
    network: station.network,
    licenses: station.licenses,
    monitor: station.monitor,
    id: `openaq:${station.stationId}:${sensor.parameter}`,
    provider: 'openaq',
    sensorId: sensor.id,
    parameter: sensor.parameter,
    scale: sensor.parameter,
    units: sensor.units,
    value: hour.value,
    observedMs: hour.endMs,
    kind: 'observation',
    averagingMinutes: 60,
    qualityFlagged: hour.flagged,
    ...(hour.coverage === null ? {} : { coveragePercent: hour.coverage }),
    color: AIR_QUALITY_UNRATED_COLOR,
    label: '',
  }));
}
