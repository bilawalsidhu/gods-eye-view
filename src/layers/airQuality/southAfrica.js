/**
 * SAAQIS observations. Pure and portable: no network, scene, or UI imports.
 * A concentration is not an AQI; retain source units and never invent a band.
 */
export const SA_POLLUTANTS = Object.freeze([
  'PM2.5',
  'PM10',
  'NO2',
  'SO2',
  'O3',
  'CO',
  'CO2',
  'NO',
  'NOX',
  'H2S',
]);
export const SA_MAX_AGE_MS = 6 * 60 * 60 * 1000;
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
  for (const region of regions) {
    if (!Array.isArray(region?.stations))
      throw new Error('Malformed SAAQIS stations');
    for (const station of region.stations) {
      if (stations.size >= 2000)
        throw new Error('SAAQIS catalog exceeds limit');
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
      stations.set(String(station.stationId), {
        stationId: String(station.stationId),
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
  const time = Date.parse(
    /(?:Z|[+-]\d{2}:\d{2})$/.test(value) ? value : `${value}+02:00`,
  );
  return Number.isFinite(time) ? time : null;
}

/** Latest *valid channel* timestamps, rather than the enclosing station time. */
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
        risk: null,
        color: '#8cb4ce',
        label: `${value.toFixed(2)} ${units}`,
        zone: station.province,
        note: 'Provisional SAAQIS hourly concentration; not an air quality index or an emissions estimate.',
      });
    }
  }
  return [...readings.values()];
}

/** Recheck age on every read, including cached responses. No city allowlist. */
export function selectSaReadings(
  snapshot,
  parameter = 'PM2.5',
  now = Date.now(),
) {
  if (!SA_POLLUTANTS.includes(parameter) || !Array.isArray(snapshot?.readings))
    throw new Error('Malformed South African air quality snapshot');
  return snapshot.readings
    .filter(
      (row) =>
        row.parameter === parameter &&
        Number.isFinite(row.observedMs) &&
        row.observedMs <= now + 5 * 60 * 1000 &&
        now - row.observedMs <= SA_MAX_AGE_MS,
    )
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

// Published by the SAAQIS portal (IndexValAndColorString, indexType 1).
// These classify provider-supplied scores, never hourly concentrations.
export const SA_INDEX_BANDS = Object.freeze([
  // i18n-ignore: exact upstream category; translated in layer presentation
  { max: 3, label: 'Good', color: '#00FF00' },
  // i18n-ignore: exact upstream category; translated in layer presentation
  { max: 5, label: 'Moderate', color: '#F7FF00' },
  // i18n-ignore: exact upstream category; translated in layer presentation
  { max: 7, label: 'Unhealthy', color: '#FFC000' },
  // i18n-ignore: exact upstream category; translated in layer presentation
  { max: 9, label: 'Very Unhealthy', color: '#FF0000' },
  // i18n-ignore: exact upstream category; translated in layer presentation
  { max: 10, label: 'Hazardous', color: '#8D00FF' },
]);

/** Only attach the selected pollutant's index at the exact observation time. */
export function attachSaIndexes(readings, payload) {
  const indexes = new Map();
  if (
    payload?.indexType === 1 &&
    Array.isArray(payload.data) &&
    payload.data.length <= 2000
  ) {
    for (const station of payload.data) {
      if (!Array.isArray(station.indexes) || station.indexes.length > 200)
        continue;
      const observedMs = saObservationTime(station.datetime);
      for (const item of station.indexes) {
        const score = item.index;
        if (!Number.isInteger(score) || score < 1 || score > 10) continue;
        const band = SA_INDEX_BANDS.find((b) => score <= b.max);
        if (item.description !== band.label) continue;
        indexes.set(`${station.stationId}:${item.pollutant}:${observedMs}`, {
          score,
          ...band,
        });
      }
    }
  }
  return readings.map((reading) => {
    const rating = indexes.get(
      `${reading.stationId}:${reading.parameter}:${reading.observedMs}`,
    );
    return {
      ...reading,
      rating: rating
        ? {
            score: rating.score,
            label: rating.label,
            observedMs: reading.observedMs,
            method: 'SAAQIS index',
          }
        : null,
      color: rating?.color || '#8cb4ce',
    };
  });
}
