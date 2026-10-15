/** CONAE FocosGOES_24hs GeoJSON contract, sampled by the contributor 2026-10-15. */
export const MAX_CONAE_RECORDS = 50_000;
const WINDOW_MS = 24 * 60 * 60_000;
const CLOCK_SLACK_MS = 10 * 60_000;

/** Parse the explicitly named UTC-3 acquisition time without using host timezone. */
function acquisitionMs(value) {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
  )
    return NaN;
  const local = Date.parse(value.replace(' ', 'T') + 'Z');
  if (
    !Number.isFinite(local) ||
    new Date(local).toISOString().slice(0, 19) !== value.replace(' ', 'T')
  )
    return NaN;
  return local + 3 * 60 * 60_000;
}

/** Re-filter cached observations at serve time; an old cache never extends the observation window. */
export function currentConaeRecords(records, now) {
  return records.filter(
    (r) => r.acqMs >= now - WINDOW_MS && r.acqMs <= now + CLOCK_SLACK_MS,
  );
}

/**
 * Normalize the documented CONAE product into Active Fires proxy records.
 * GeoJSON is lon/lat (confirmed against Latitud/Longitud in the live sample).
 * Unknown FRP stays null; CONAE GOES does not publish confidence or brightness.
 */
export function parseConaeGoes(payload, now = Date.now()) {
  if (
    payload?.type !== 'FeatureCollection' ||
    !Array.isArray(payload.features)
  ) {
    throw new Error('Expected CONAE GeoJSON FeatureCollection');
  }
  const features = payload.features;
  if (features.length > MAX_CONAE_RECORDS)
    throw new Error('CONAE record limit exceeded');
  for (const key of ['numberMatched', 'totalFeatures']) {
    const count = payload[key];
    if (typeof count === 'number' && count > features.length) {
      throw new Error('Incomplete CONAE feature collection');
    }
  }
  if (
    Number.isFinite(payload.numberReturned) &&
    payload.numberReturned !== features.length
  ) {
    throw new Error('Inconsistent CONAE feature count');
  }
  const crs = payload.crs?.properties?.name;
  if (
    crs &&
    ![
      'urn:ogc:def:crs:EPSG::4326',
      'EPSG:4326',
      'urn:ogc:def:crs:OGC:1.3:CRS84',
    ].includes(crs)
  ) {
    throw new Error('Unsupported CONAE coordinate reference system');
  }
  const records = [];
  let rejected = 0;
  for (const feature of features) {
    const coordinates = feature?.geometry?.coordinates;
    const p = feature?.properties;
    const lon = coordinates?.[0];
    const lat = coordinates?.[1];
    const acqMs = acquisitionMs(p?.['Fecha_Local_UTC-3']);
    const satellite =
      typeof p?.Satelite === 'string'
        ? /^GOES[- ]?(\d{2})$/i.exec(p.Satelite.trim())
        : null;
    if (
      feature?.type !== 'Feature' ||
      feature.geometry?.type !== 'Point' ||
      !Array.isArray(coordinates) ||
      !Number.isFinite(lat) ||
      !Number.isFinite(lon) ||
      Math.abs(lat) > 90 ||
      Math.abs(lon) > 180 ||
      !Number.isFinite(acqMs) ||
      !satellite
    ) {
      rejected++;
      continue;
    }
    const value = p.Fire_Radiative_Power;
    const frp =
      typeof value === 'number' && Number.isFinite(value) && value >= 0
        ? value
        : null;
    records.push({
      provider: 'conae-goes',
      lat,
      lon,
      acqMs,
      frp,
      confidence: null,
      brightness: null,
      daynight: '',
      instrument: 'GOES',
      satellite: 'GOES-' + satellite[1],
    });
  }
  if (features.length && !records.length)
    throw new Error('No valid CONAE observations');
  // Corrupt rows must not silently turn an incomplete download into a healthy snapshot.
  if (rejected) throw new Error('Malformed CONAE observations');
  return currentConaeRecords(records, now);
}
