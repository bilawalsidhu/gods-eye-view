import { coordinates, epoch, finite, LiveSourceError } from './contract.js';

/** An MMSI is up to ten digits (AIS carries it in 30 bits); anything else a
 * row names it is not one. */
const MMSI_PATTERN = /^\d{1,10}$/;

/** The row's MMSI when it carries one that looks like an MMSI, else ''. */
function vesselMmsi(row) {
  const text = String(row?.mmsi ?? '').trim();
  return MMSI_PATTERN.test(text) ? text : '';
}

/** A row's stable id when its source names none: its MMSI or identifier. */
function defaultVesselId(row) {
  return String(row?.mmsi || row?.input_identifier || '');
}

/**
 * AIS positions are sea-surface observations; heading and course are distinct.
 * `id` is the vessel's key; an MMSI is not one (vessels share numbers and a
 * number can move to another hull), so `mmsi` is an attribute, '' when the
 * row has none. A row with no id of its own is keyed by its MMSI.
 */
export function normalizeVesselObservation(row, reference = null, id = null) {
  const key = String(id ?? defaultVesselId(row)).trim();
  const latitude = finite(row?.lat),
    longitude = finite(row?.lon);
  if (!key || !coordinates(latitude, longitude)) return null;
  const mmsi = vesselMmsi(row);
  const speedKts = finite(row.speed);
  return {
    id: key,
    mmsi,
    reference: reference ?? key,
    latitude,
    longitude,
    // A source's own id is not a name: a vessel with none is unnamed.
    name: String(row.name || row.input_name || mmsi || defaultVesselId(row)),
    imo: String(row.imo || ''),
    type: String(row.type_specific || row.type || ''),
    destination: String(row.destination || ''),
    speedMps: speedKts == null ? null : speedKts * 0.514444,
    courseDeg: finite(row.course),
    headingDeg: finite(row.heading),
    observedAtMs:
      epoch(row.last_position_epoch, 1000) ??
      epoch(Date.parse(row.last_position_UTC)),
    altitudeDatum: 'sea-surface',
  };
}

/**
 * A vessel snapshot from a `{ rows }` payload. `idFor(row)` gives a row's
 * stable id (its MMSI or identifier by default); rows are deduped by that id,
 * so two vessels sharing an MMSI stay two vessels. A source whose rows carry
 * an id of their own passes it, such as `idFor: (row) => row.uuid || row.mmsi`.
 * `referenceFor(row)` gives the reference its track is asked for by; the id
 * by default.
 */
export function vesselSnapshot(
  payload,
  {
    source = 'AISStream',
    coverage = 'received AIS positions',
    idFor = defaultVesselId,
    referenceFor = null,
  } = {},
) {
  if (!Array.isArray(payload?.rows))
    throw new LiveSourceError('malformed', 'Malformed vessel response');
  const rows = payload.rows;
  const records = [],
    ids = new Set();
  for (const row of rows) {
    const record = normalizeVesselObservation(
      row,
      null,
      row && typeof row === 'object' ? idFor(row) : null,
    );
    // A row's track is asked for by its id unless the source says otherwise.
    if (record && referenceFor) record.reference = referenceFor(row);
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
