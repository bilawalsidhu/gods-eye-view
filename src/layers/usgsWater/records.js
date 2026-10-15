import { USGS_WATER_BBOX, USGS_WINDOW_MS, usgsStationUrl } from './config.js';

/** Plain display text; source value text is separately retained without rewriting. */
export const waterText = (value, limit = 180) =>
  typeof value === 'string'
    ? value
        .slice(0, 1024)
        .replace(/<[^>]*>/g, '')
        .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, limit)
    : '';

/** Parse the complete finite numeric string; missing and textual values stay missing. */
export function waterNumber(value) {
  if (typeof value !== 'string') return null;
  const input = value.trim();
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(input))
    return null;
  const numeric = Number(input);
  return Number.isFinite(numeric) ? numeric : null;
}

/** Measurement timestamps must carry a timezone, rather than the reader's local zone. */
export function waterTime(value) {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(
      value,
    )
  )
    return null;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > new Date(Date.UTC(year, month, 0)).getUTCDate() ||
    Number(value.slice(11, 13)) > 23 ||
    Number(value.slice(14, 16)) > 59 ||
    Number(value.slice(17, 19)) > 59
  )
    return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

export const waterUtc = (time) =>
  Number.isFinite(time)
    ? new Date(time)
        .toISOString()
        .replace('T', ' ')
        .replace(/\.\d{3}Z$/, ' UTC')
    : 'unknown';

/** Group a joined source snapshot by station, keeping every time-series identity. */
export function normalizeUsgsWaterSnapshot(snapshot) {
  if (
    !Array.isArray(snapshot?.observations) ||
    !Array.isArray(snapshot?.stations) ||
    !Array.isArray(snapshot?.series) ||
    !Number.isSafeInteger(snapshot.fetchedAt) ||
    snapshot.fetchedAt < 0 ||
    snapshot.observations.length > 2000 ||
    snapshot.stations.length > 256 ||
    snapshot.series.length > 2000
  )
    throw new TypeError('Malformed USGS water snapshot');
  const start = snapshot.windowStart ?? snapshot.fetchedAt - USGS_WINDOW_MS;
  const end = snapshot.windowEnd ?? snapshot.fetchedAt;
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end)
    throw new TypeError('Invalid USGS measurement window');
  const stations = new Map(snapshot.stations.map((row) => [row.id, row]));
  const series = new Map(snapshot.series.map((row) => [row.id, row]));
  const sites = new Map();
  const seen = new Map();
  let excludedOldCount = 0;
  for (const observation of snapshot.observations) {
    const time = waterTime(observation.time);
    if (time === null) throw new Error('Invalid USGS measurement timestamp');
    if (time < start || time > end) {
      excludedOldCount++;
      continue;
    }
    const station = stations.get(observation.monitoring_location_id);
    const metadata = series.get(observation.time_series_id);
    if (
      !station ||
      !metadata ||
      metadata.monitoring_location_id !== station.id ||
      metadata.parameter_code !== observation.parameter_code ||
      metadata.statistic_id !== observation.statistic_id ||
      (observation.value !== null && typeof observation.value !== 'string')
    )
      throw new Error('Incomplete or conflicting USGS metadata join');
    usgsStationUrl(station.id);
    const [west, south, east, north] = USGS_WATER_BBOX;
    if (
      !Number.isFinite(station.lon) ||
      !Number.isFinite(station.lat) ||
      station.lon < west ||
      station.lon > east ||
      station.lat < south ||
      station.lat > north
    )
      throw new Error('USGS station is outside the requested area');
    const previous = seen.get(observation.time_series_id);
    if (previous) {
      if (JSON.stringify(previous) !== JSON.stringify(observation))
        throw new Error('Conflicting latest readings for a USGS time series');
      continue;
    }
    seen.set(observation.time_series_id, observation);
    let site = sites.get(station.id);
    if (!site) {
      site = {
        id: station.id,
        name: waterText(station.monitoring_location_name) || station.id,
        siteType: waterText(station.site_type) || 'Unknown site type',
        county:
          waterText(station.county_name) ||
          `County code ${waterText(station.county_code) || 'unknown'}`,
        state: waterText(station.state_name) || 'Unknown state',
        stateCode: station.state_code,
        countyCode: station.county_code,
        bexar: station.state_code === '48' && station.county_code === '029',
        lon: station.lon,
        lat: station.lat,
        sourceUrl: usgsStationUrl(station.id),
        readings: [],
      };
      sites.set(station.id, site);
    }
    if (site.readings.length >= 64)
      throw new Error('USGS readings per station exceed the display bound');
    site.readings.push({
      seriesId: observation.time_series_id,
      parameterCode: observation.parameter_code,
      parameterName:
        waterText(metadata.parameter_name) ||
        `Parameter ${observation.parameter_code}`,
      parameterDescription: waterText(metadata.parameter_description),
      statisticId: observation.statistic_id,
      computation: waterText(metadata.computation_identifier),
      computationPeriod: waterText(metadata.computation_period_identifier),
      sublocation: waterText(metadata.sublocation_identifier),
      description: waterText(metadata.web_description),
      valueText: observation.value,
      numericValue: waterNumber(observation.value),
      unit: waterText(observation.unit_of_measure, 80) || 'unit not supplied',
      observedAt: time,
      observedText: observation.time,
      approvalStatus:
        waterText(observation.approval_status) || 'Unknown approval status',
      qualifier: structuredClone(observation.qualifier),
      qualifierText: Array.isArray(observation.qualifier)
        ? observation.qualifier
            .map((value) => waterText(value, 80))
            .filter(Boolean)
            .join(', ')
        : waterText(observation.qualifier),
      // Database modification is provenance, never measurement freshness.
      lastModified: observation.last_modified,
    });
  }
  const records = [...sites.values()].sort((a, b) => a.id.localeCompare(b.id));
  for (const site of records) {
    site.readings.sort(
      (a, b) =>
        a.parameterCode.localeCompare(b.parameterCode) ||
        a.seriesId.localeCompare(b.seriesId),
    );
    site.numericReadingCount = site.readings.filter(
      (row) => row.numericValue !== null,
    ).length;
    site.provisional = site.readings.some((row) =>
      /provisional/i.test(row.approvalStatus),
    );
  }
  return {
    records,
    fetchedAt: snapshot.fetchedAt,
    windowStart: start,
    windowEnd: end,
    excludedOldCount: excludedOldCount + (snapshot.excludedOldCount ?? 0),
    readingCount: records.reduce(
      (count, site) => count + site.readings.length,
      0,
    ),
    numericReadingCount: records.reduce(
      (count, site) => count + site.numericReadingCount,
      0,
    ),
  };
}

/** One selected series per card; navigation exposes every series without a towering overlay. */
export function waterCardDetails(site, readingIndex, fetchedAt, stale = false) {
  const row = site.readings[readingIndex];
  const numeric = row.numericValue !== null;
  const value = numeric
    ? `${waterText(row.valueText, 80)} ${row.unit}`
    : `No numeric reading${waterText(row.valueText, 80) ? ` (source: ${waterText(row.valueText, 80)})` : ''} · ${row.unit}`;
  return [
    `${site.county}, ${site.state} · ${site.siteType} · ${site.id}`,
    `Reading ${readingIndex + 1}/${site.readings.length}: ${row.parameterName} (${row.parameterCode})`,
    value,
    `Observed ${waterUtc(row.observedAt)}`,
    `Status: ${row.approvalStatus} · Qualifier: ${row.qualifierText || 'none'}`,
    `Statistic: ${row.statisticId ?? 'none'} · ${row.computation || 'unspecified computation'}${row.sublocation ? ` · ${row.sublocation}` : ''}`,
    `Series: ${row.seriesId}`,
    ...(row.parameterDescription ? [row.parameterDescription] : []),
    ...(row.description ? [row.description] : []),
    ...(row.parameterCode === '00065'
      ? ['Gage height is not necessarily river depth.']
      : []),
    ...(row.parameterCode === '72019'
      ? ['Depth below land surface; not a map altitude.']
      : []),
    ...(row.parameterCode === '00045'
      ? [
          'Precipitation, total; this query window is not a 24-hour rainfall total.',
        ]
      : []),
    `Retrieved ${waterUtc(fetchedAt)}${stale ? ' · STALE: refresh failed' : ''}`,
    'USGS observations · provisional data are subject to revision',
    'USGS station ↗ · click card to open',
  ];
}
