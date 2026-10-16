/**
 * NASA JPL CNEOS Fireball and Bolide event normalizer and utilities.
 *
 * Ingests tabular fireball impact records from Center for Near Earth Object Studies:
 * https://ssd-api.jpl.nasa.gov/fireball.api
 */

/**
 * Parse and validate geographic coordinates with directional indicators.
 *
 * @param {string|number|null|undefined} latStr - Latitude magnitude in degrees.
 * @param {string|null|undefined} latDir - Latitude direction ('N' or 'S').
 * @param {string|number|null|undefined} lonStr - Longitude magnitude in degrees.
 * @param {string|null|undefined} lonDir - Longitude direction ('E' or 'W').
 * @returns {?[number, number]} [lat, lon] as signed finite floats, or null if invalid.
 */
export function parseFireballCoordinates(latStr, latDir, lonStr, lonDir) {
  if (latStr == null || latStr === '' || lonStr == null || lonStr === '')
    return null;
  const rawLat = Number(latStr);
  const rawLon = Number(lonStr);
  if (!Number.isFinite(rawLat) || !Number.isFinite(rawLon)) return null;

  const latHemisphere = String(latDir || '')
    .trim()
    .toUpperCase();
  const lonHemisphere = String(lonDir || '')
    .trim()
    .toUpperCase();

  let lat = Math.abs(rawLat);
  if (latHemisphere === 'S') lat = -lat;
  else if (latHemisphere !== 'N' && latHemisphere !== '') return null;

  let lon = Math.abs(rawLon);
  if (lonHemisphere === 'W') lon = -lon;
  else if (lonHemisphere !== 'E' && lonHemisphere !== '') return null;

  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  return [lat, lon];
}

/**
 * Parse CNEOS UTC date string into standard ISO string and epoch ms.
 *
 * CNEOS uses space-separated "YYYY-MM-DD HH:mm:ss" UTC timestamps.
 *
 * @param {string|null|undefined} dateStr
 * @returns {?{ iso: string, epochMs: number }}
 */
export function parseFireballTimestamp(dateStr) {
  const text = String(dateStr || '').trim();
  if (!text) return null;
  const isoFormatted = text.includes('T') ? text : text.replace(' ', 'T') + 'Z';
  const epochMs = Date.parse(isoFormatted);
  if (!Number.isFinite(epochMs)) return null;
  return {
    iso: new Date(epochMs).toISOString(),
    epochMs,
  };
}

/**
 * Parse one tabular row from the CNEOS API data array.
 *
 * @param {Array<string>} fields - Field names array from the response.
 * @param {Array<unknown>} row - Row data matching the fields indices.
 * @returns {?object} Normalized fireball event object or null if unusable.
 */
export function parseCneosFireballRecord(fields, row) {
  if (!Array.isArray(fields) || !Array.isArray(row)) return null;

  const fieldMap = new Map();
  for (let i = 0; i < fields.length; i++) {
    fieldMap.set(fields[i], row[i]);
  }

  const time = parseFireballTimestamp(fieldMap.get('date'));
  if (!time) return null;

  const coords = parseFireballCoordinates(
    fieldMap.get('lat'),
    fieldMap.get('lat-dir'),
    fieldMap.get('lon'),
    fieldMap.get('lon-dir'),
  );
  if (!coords) return null;

  const [lat, lon] = coords;

  const parseNum = (val, strictlyPositive = false) => {
    if (val == null || val === '') return null;
    const num = Number(val);
    if (!Number.isFinite(num)) return null;
    if (strictlyPositive && num <= 0) return null;
    if (!strictlyPositive && num < 0) return null;
    return num;
  };

  const altitudeKm = parseNum(fieldMap.get('alt'), false);
  const velocityKmS = parseNum(fieldMap.get('vel'), true);
  const rawEnergy = parseNum(fieldMap.get('energy'), true);
  const opticalEnergyJoules = rawEnergy != null ? rawEnergy * 1e10 : null;
  const impactEnergyKt = parseNum(fieldMap.get('impact-e'), true);

  const id = `cneos-fireball-${time.epochMs}-${lat.toFixed(2)}-${lon.toFixed(2)}`;

  return {
    id,
    date: time.iso,
    epochMs: time.epochMs,
    lat,
    lon,
    altitudeKm,
    velocityKmS,
    opticalEnergyJoules,
    impactEnergyKt,
  };
}

/**
 * Normalize complete CNEOS payload into a clean list of validated events.
 *
 * @param {object} payload - Raw CNEOS JSON payload.
 * @returns {{ count: number, events: Array<object> }}
 */
export function normalizeFireballPayload(payload) {
  if (!payload || typeof payload !== 'object') {
    return { count: 0, events: [] };
  }
  const fields = payload.fields;
  const data = payload.data;
  if (!Array.isArray(fields) || !Array.isArray(data)) {
    return { count: 0, events: [] };
  }

  const events = [];
  const seen = new Set();
  for (const row of data) {
    const record = parseCneosFireballRecord(fields, row);
    if (!record || seen.has(record.id)) continue;
    seen.add(record.id);
    events.push(record);
  }

  events.sort((a, b) => b.epochMs - a.epochMs);
  return {
    count: events.length,
    events,
  };
}

/**
 * Convert a normalized fireball record to a standard GeoJSON Point Feature.
 *
 * @param {object} event - Normalized fireball record.
 * @returns {object} GeoJSON Feature.
 */
export function fireballToGeoJsonFeature(event) {
  const altitudeM =
    event.altitudeKm != null ? Math.round(event.altitudeKm * 1000) : 0;
  return {
    type: 'Feature',
    id: event.id,
    geometry: {
      type: 'Point',
      coordinates: [event.lon, event.lat, altitudeM],
    },
    properties: {
      id: event.id,
      date: event.date,
      epochMs: event.epochMs,
      altitudeKm: event.altitudeKm,
      velocityKmS: event.velocityKmS,
      opticalEnergyJoules: event.opticalEnergyJoules,
      impactEnergyKt: event.impactEnergyKt,
    },
  };
}
