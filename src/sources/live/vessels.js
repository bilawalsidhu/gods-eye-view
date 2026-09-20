import { coordinates, epoch, finite, LiveSourceError } from './contract.js';

/** AIS positions are sea-surface observations; heading and course are distinct. */
export function normalizeVesselObservation(row, reference = null) {
  const id = String(row?.mmsi || row?.input_identifier || '').trim();
  const latitude = finite(row?.lat),
    longitude = finite(row?.lon);
  if (!id || !coordinates(latitude, longitude)) return null;
  const speedKts = finite(row.speed);
  return {
    id,
    reference: reference ?? id,
    latitude,
    longitude,
    name: String(row.name || row.input_name || id),
    imo: String(row.imo || ''),
    type: String(row.type_specific || row.type || ''),
    destination: String(row.destination || ''),
    speedMps: speedKts == null ? null : speedKts * 0.514444,
    courseDeg: finite(row.course),
    headingDeg: finite(row.heading),
    callSign: String(row.call_sign || ''),
    draughtM: finite(row.draught),
    loadState: String(row.load_state || ''),
    eta: String(row.eta || ''),
    lengthM: finite(row.length),
    beamM: finite(row.beam),
    navStatus: finite(row.nav_status),
    navStatusText: String(row.nav_status_text || ''),
    flag: String(row.flag || ''),
    flagCode: String(row.flag_code || ''),
    mmsiKind: String(row.mmsi_kind || ''),
    imoValid:
      row.imo_valid === null || row.imo_valid === undefined
        ? null
        : Boolean(row.imo_valid),
    sanctioned: Boolean(row.sanctioned),
    sanctionConfidence: String(row.sanction_confidence || ''),
    sanctionPrograms: String(row.sanction_programs || ''),
    estimated: Boolean(row.estimated),
    estMoved: Boolean(row.est_moved),
    estAgeSec: finite(row.est_age_sec),
    estConfidence: finite(row.est_confidence),
    estFromLat: finite(row.est_from_lat),
    estFromLon: finite(row.est_from_lon),
    gapKind: String(row.gap_kind || ''),
    observedAtMs:
      epoch(row.last_position_epoch, 1000) ??
      epoch(Date.parse(row.last_position_UTC)),
    altitudeDatum: 'sea-surface',
  };
}

export function vesselSnapshot(
  payload,
  {
    source = 'AISStream',
    coverage = 'received AIS positions',
    referenceFor = (row) => String(row.mmsi || row.input_identifier || ''),
  } = {},
) {
  if (!Array.isArray(payload?.rows))
    throw new LiveSourceError('malformed', 'Malformed vessel response');
  const rows = payload.rows;
  const records = [],
    ids = new Set();
  for (const row of rows) {
    const record = normalizeVesselObservation(row);
    if (record) record.reference = referenceFor(row);
    if (record && !ids.has(record.id)) {
      records.push(record);
      ids.add(record.id);
    }
  }
  const observedAtMs =
    epoch(payload?.newestPositionAt) ??
    epoch(Date.parse(payload?.newestPositionAt)) ??
    records.reduce(
      (newest, row) => Math.max(newest || 0, row.observedAtMs || 0) || null,
      null,
    );
  return {
    records,
    source,
    coverage,
    complete: records.length === rows.length && !payload?.refreshing,
    rejectedCount: rows.length - records.length,
    observedAtMs,
    freshness: payload?.refreshing
      ? 'stale'
      : observedAtMs == null
        ? 'unknown'
        : 'current',
    stale: Boolean(payload?.refreshing),
    // Connection state is distinct from receipt of a usable position.
    transportStatus:
      typeof payload?.status === 'string' ? payload.status : null,
    lastMessageAt: payload?.lastMessageAt ?? null,
    nextAttemptAt: finite(payload?.nextAttemptAt),
    silentForMs: finite(payload?.silentForMs),
    reconnectAttempt: finite(payload?.reconnectAttempt),
    rawRowCount: rows.length,
  };
}

export function normalizeVesselTrack(samples) {
  if (!Array.isArray(samples)) return [];
  return samples.flatMap((sample) => {
    const latitude = finite(sample?.lat),
      longitude = finite(sample?.lon);
    if (!coordinates(latitude, longitude)) return [];
    return [
      {
        latitude,
        longitude,
        observedAtMs: epoch(sample?.t, 1000),
        altitudeDatum: 'sea-surface',
      },
    ];
  });
}
