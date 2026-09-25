import {
  admitRecords,
  cleanText,
  coordinates,
  epoch,
  finite,
} from './contract.js';

/** Normalize the OpenSky state-vector route, including its regional fallback. */
export function normalizeOpenSkyAircraft(row) {
  if (!Array.isArray(row)) return null;
  const id = cleanText(row[0]).toLowerCase();
  if (!id || !coordinates(row[6], row[5])) return null;
  return {
    id,
    reference: id,
    latitude: row[6],
    longitude: row[5],
    callsign: cleanText(row[1]),
    originCountry: cleanText(row[2]),
    positionTimeMs: epoch(row[3], 1000),
    contactTimeMs: epoch(row[4], 1000),
    baroAltitudeM: finite(row[7]),
    ellipsoidAltitudeM: finite(row[13]),
    onGround: row[8] === true,
    speedMps: finite(row[9]),
    courseDeg: finite(row[10]),
    verticalRateMps: finite(row[11]),
    category: finite(row[17]),
    typeCode: null,
    registration: null,
    operator: null,
  };
}

/** Normalize readsb observations. The caller supplies the source snapshot epoch. */
export function normalizeReadsbAircraft(row, snapshotTimeMs) {
  const id = cleanText(row?.hex).toLowerCase();
  const latitude = finite(row?.lat),
    longitude = finite(row?.lon);
  if (!id || !coordinates(latitude, longitude)) return null;
  const baroFt = finite(row.alt_baro),
    geoFt = finite(row.alt_geom);
  const speedKts = finite(row.gs),
    rateFtMin = finite(row.baro_rate);
  const seen = finite(row.seen),
    seenPos = finite(row.seen_pos);
  return {
    id,
    reference: id,
    latitude,
    longitude,
    callsign: cleanText(row.flight),
    originCountry: null,
    positionTimeMs:
      snapshotTimeMs == null ? null : snapshotTimeMs - (seenPos ?? 0) * 1000,
    contactTimeMs:
      snapshotTimeMs == null || seen == null
        ? null
        : snapshotTimeMs - seen * 1000,
    baroAltitudeM: baroFt == null ? null : baroFt * 0.3048,
    ellipsoidAltitudeM: geoFt == null ? null : geoFt * 0.3048,
    onGround: cleanText(row.alt_baro).toLowerCase() === 'ground',
    speedMps: speedKts == null ? null : speedKts * 0.514444,
    courseDeg: finite(row.track),
    verticalRateMps: rateFtMin == null ? null : rateFtMin * 0.00508,
    category: row.category ?? null,
    typeCode: cleanText(row.t),
    registration: cleanText(row.r),
    operator: cleanText(row.ownOp),
  };
}

export function openSkySnapshot(
  payload,
  {
    source = 'OpenSky Network',
    coverage = 'worldwide upstream snapshot',
    now = Date.now(),
    stale = false,
  } = {},
) {
  const admitted = admitRecords(
    payload?.states,
    normalizeOpenSkyAircraft,
    'OpenSky',
  );
  const observedAtMs = epoch(payload?.time, 1000);
  const ageMs = observedAtMs == null ? null : Math.max(0, now - observedAtMs);
  return {
    ...admitted,
    source,
    coverage,
    observedAtMs,
    ageMs,
    stale: stale || (ageMs != null && ageMs > 120000),
    freshness:
      observedAtMs == null
        ? 'unknown'
        : stale || ageMs > 120000
          ? 'stale'
          : 'current',
  };
}

export function readsbSnapshot(
  payload,
  {
    observedAtMs,
    source = 'adsb.lol',
    coverage = 'military upstream snapshot',
    now = Date.now(),
    stale = false,
  } = {},
) {
  const admitted = admitRecords(
    payload?.ac,
    (row) => normalizeReadsbAircraft(row, observedAtMs),
    'adsb.lol',
  );
  const ageMs = observedAtMs == null ? null : Math.max(0, now - observedAtMs);
  return {
    ...admitted,
    source,
    coverage,
    observedAtMs,
    ageMs,
    stale,
    freshness: observedAtMs == null ? 'unknown' : stale ? 'stale' : 'current',
  };
}

/**
 * Track altitude remains barometric; renderers choose a visual ground fallback.
 *
 * The AeroAPI variant (below) maps onto the same contract: timestamp →
 * observedAtMs, altitude (hundreds of feet) → baroAltitudeM. `delta` rows are
 * dropped (waypoint summaries, not observed fixes); surface/ground rows carry
 * altitude 0, matching the backfill renderer's on-ground handling.
 */
export function normalizeAircraftTrack(
  rows,
  { baseTimeMs = 0, readsb = false } = {},
) {
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((row) => {
    if (!Array.isArray(row)) return [];
    const latitude = finite(row[1]),
      longitude = finite(row[2]);
    const offset = finite(row[0]);
    const observedAtMs =
      offset == null ? null : epoch(baseTimeMs + offset * 1000);
    if (
      !coordinates(latitude, longitude) ||
      observedAtMs == null ||
      observedAtMs <= 0
    )
      return [];
    const altitude = finite(row[3]);
    return [
      {
        latitude,
        longitude,
        observedAtMs,
        baroAltitudeM:
          altitude == null ? null : altitude * (readsb ? 0.3048 : 1),
        ellipsoidAltitudeM: null,
        onGround: readsb
          ? cleanText(row[3]).toLowerCase() === 'ground'
          : row[5] === true,
      },
    ];
  });
}

/**
 * Normalize one AeroAPI track position into the shared track contract. Rows
 * arrive in ascending timestamp order from FlightAware; a 90 s window absorbs
 * position duplicates from multiple receiving stations. `delta: true` rows are
 * waypoint summaries (no observation) and are rejected by the missing
 * timestamp. `update_type: 'X'` marks surface positions (altitude 0).
 * @param {object} row - AeroAPI FlightPosition.
 * @param {number} windowMs - Deduplication window in milliseconds.
 * @returns {object|null} A shared-contract track record, or null.
 */
export function normalizeAeroApiTrackPosition(row, windowMs = 90000) {
  if (row?.delta === true) return null;
  const latitude = finite(row?.latitude),
    longitude = finite(row?.longitude);
  const timestamp = cleanText(row?.timestamp);
  const observedAtMs = timestamp ? Date.parse(timestamp) : NaN;
  if (
    !coordinates(latitude, longitude) ||
    !Number.isFinite(observedAtMs) ||
    observedAtMs <= 0
  )
    return null;
  const altitude = finite(row?.altitude);
  return {
    latitude,
    longitude,
    observedAtMs,
    baroAltitudeM:
      altitude == null ? null : Math.max(0, altitude) * 100 * 0.3048,
    ellipsoidAltitudeM: null,
    onGround: cleanText(row?.update_type) === 'X',
    _dedupeKey: `${Math.round(observedAtMs / (windowMs > 0 ? windowMs : 1))}:${latitude.toFixed(3)},${longitude.toFixed(3)}`,
  };
}

/**
 * Normalize an AeroAPI `/flights/{id}/track` response. Returns records in
 * ascending time order with near-duplicate receiver observations collapsed.
 * @param {object} payload - AeroAPI track response body.
 * @returns {{records: object[]}} Shared-contract track records.
 */
export function normalizeAeroApiTrack(payload) {
  if (!Array.isArray(payload?.positions)) return [];
  const seen = new Set();
  const records = [];
  for (const row of payload.positions) {
    const record = normalizeAeroApiTrackPosition(row);
    if (!record) continue;
    if (seen.has(record._dedupeKey)) continue;
    seen.add(record._dedupeKey);
    records.push(record);
  }
  for (const record of records) delete record._dedupeKey;
  return records;
}

/** Known source identities are useful for classification even without positions. */
export function readsbIdentities(payload) {
  const admitted = admitRecords(
    payload?.ac,
    (row) => {
      const id = cleanText(row?.hex).toLowerCase();
      return id ? { id } : null;
    },
    'aircraft identities',
  );
  return admitted.records.map((record) => record.id);
}
