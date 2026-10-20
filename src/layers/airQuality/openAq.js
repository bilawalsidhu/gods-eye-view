/** Portable OpenAQ v3 normalization. No AQI is inferred from concentrations. */
export const OPENAQ_POLLUTANTS = Object.freeze([
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
const parameters = Object.freeze({
  pm25: 'PM2.5',
  pm10: 'PM10',
  no2: 'NO2',
  so2: 'SO2',
  o3: 'O3',
  co: 'CO',
  co2: 'CO2',
  no: 'NO',
  nox: 'NOX',
  h2s: 'H2S',
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
      !coordinate(row.coordinates?.latitude, 90) ||
      !coordinate(row.coordinates?.longitude, 180) ||
      !Array.isArray(row.sensors)
    )
      continue;
    const sensors = row.sensors
      .filter(
        (s) =>
          Number.isSafeInteger(s.id) &&
          parameters[s.parameter?.name] &&
          text(s.parameter?.units),
      )
      .map((s) => ({
        id: s.id,
        parameter: parameters[s.parameter.name],
        units: text(s.parameter.units),
      }));
    if (!sensors.length) continue;
    unique.set(row.id, {
      stationId: String(row.id),
      name: text(row.name) || String(row.id),
      lat: row.coordinates.latitude,
      lon: row.coordinates.longitude,
      country: text(row.country?.code),
      zone: text(row.country?.name),
      owner: text(row.owner?.name),
      network: text(row.provider?.name),
      sensors,
      licenses: (row.licenses || []).slice(0, 20).map((l) => ({
        name: text(l.name),
        attribution: text(l.attribution?.name),
        url: /^https?:\/\//.test(l.attribution?.url || '')
          ? l.attribution.url
          : null,
      })),
      lastObservedMs: Date.parse(row.datetimeLast?.utc) || null,
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
      ...station,
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
      risk: null,
      rating: null,
      color: '#8cb4ce',
      label: `${item.value.toFixed(2)} ${sensor.units}`,
      note: 'OpenAQ observation; source averaging period unspecified; not an AQI or emissions estimate.',
    });
  }
  return [...records.values()];
}
