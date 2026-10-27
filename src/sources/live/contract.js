/**
 * Browser live-source contract. Coordinates are WGS84 degrees; lengths and
 * velocities are metres and metres/second; times are Unix milliseconds.
 * Barometric altitude and ellipsoid altitude are separate, nullable observations.
 * A missing timestamp is unknown, never the time the response was received.
 *
 * Sources expose getSnapshot(query, { signal }) and optionally
 * getTrack(reference, { signal }). References are opaque to consumers.
 * Snapshots describe coverage and completeness independently of freshness.
 * Records contain observation data only, with no scene objects or transport data.
 */
// Messages are English data (AI tools read them too); the Layers panel shows
// them translated by their shape (translateFeedError in src/ui/statusText.js),
// so a new or reworded message is changed there as well.
export class LiveSourceError extends Error {
  constructor(
    code,
    message,
    { status = null, retryAfterMs = 20000, source = null } = {},
  ) {
    super(message);
    this.name = 'LiveSourceError';
    this.code = code;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
    this.source = source;
  }
}

export function finite(value) {
  if (value == null || value === '' || typeof value === 'boolean') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function epoch(value, scale = 1) {
  const number = finite(value);
  const milliseconds = number == null ? null : number * scale;
  return milliseconds != null &&
    milliseconds > 0 &&
    milliseconds <= 8640000000000000
    ? milliseconds
    : null;
}

export function cleanText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

export function coordinates(latitude, longitude) {
  return (
    Number.isFinite(latitude) &&
    Math.abs(latitude) <= 90 &&
    Number.isFinite(longitude) &&
    Math.abs(longitude) <= 180
  );
}

/**
 * Admit a snapshot atomically; an all-invalid nonempty feed is unavailable.
 * `unpositionedId(row)` names a rejected row that is a valid contact without
 * a position: it is returned in `retainIds` and does not make the snapshot
 * incomplete.
 */
export function admitRecords(rows, normalize, label, unpositionedId) {
  if (!Array.isArray(rows))
    throw new LiveSourceError('malformed', `Malformed ${label} response`);
  const records = [];
  const ids = new Set();
  const retainIds = new Set();
  let unpositioned = 0;
  for (const row of rows) {
    const record = normalize(row);
    if (record && !ids.has(record.id)) {
      records.push(record);
      ids.add(record.id);
    } else if (!record) {
      const id = unpositionedId?.(row);
      if (id) {
        retainIds.add(id);
        unpositioned += 1;
      }
    }
  }
  if (rows.length && !records.length) {
    throw new LiveSourceError('malformed', `Malformed ${label} aircraft rows`);
  }
  return {
    records,
    retainIds,
    complete: records.length + unpositioned === rows.length,
    rejectedCount: rows.length - records.length,
  };
}

/**
 * Compose a primary source with an optional track-history fallback (issue
 * #446). The primary's methods are used unchanged; a fallback provides only
 * `getTrackByQuery(reference, { signal })` and is consulted when the primary's
 * `getTrack` throws or yields no records. The reference handed to the fallback
 * is the layer's shared-contract record (id/callsign/registration), so a
 * keyed historical provider can resolve an aircraft the primary keys by hex.
 * Falls back transparently; a failing fallback propagates only when the
 * primary also failed.
 * @param {object} primary - Source satisfying the live-source contract.
 * @param {{ getTrackByQuery: Function, label?: string }|null} fallback
 * @returns {object} A source delegating everything to `primary` except track.
 */
export function composeSource(primary, fallback) {
  if (!fallback) return primary;
  return {
    ...primary,
    label: primary.label,
    async getTrack(reference, options = {}) {
      let primaryError = null;
      try {
        const track = await primary.getTrack(reference, options);
        if (track?.records?.length)
          return { ...track, historySource: undefined };
      } catch (error) {
        options.signal?.throwIfAborted();
        if (error?.name === 'AbortError') throw error;
        primaryError = error;
      }
      try {
        const track = await fallback.getTrackByQuery(
          {
            id: typeof reference === 'string' ? reference : reference?.id,
            callsign: reference?.callsign,
            registration: reference?.registration,
            lastContactEpochMs: reference?.lastContactEpochMs,
          },
          options,
        );
        if (track?.records?.length)
          return {
            ...track,
            historySource: fallback.label,
            credit: fallback.credit,
          };
      } catch (error) {
        options.signal?.throwIfAborted();
        if (error?.name === 'AbortError') throw error;
        /* fallback is best-effort */
      }
      if (primaryError) throw primaryError;
      return { records: [], complete: false };
    },
  };
}

/** Cancellation is checked after body parsing even when a transport ignores it. */
export async function readResponse(
  fetchImpl,
  url,
  { signal, ...init } = {},
  source = 'Live source',
) {
  signal?.throwIfAborted();
  let response;
  try {
    response = await fetchImpl(url, { ...init, signal });
    signal?.throwIfAborted();
  } catch (error) {
    signal?.throwIfAborted();
    if (error?.name === 'AbortError') throw error;
    throw new LiveSourceError('unavailable', `${source} network error`, {
      source,
    });
  }
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    /* classified below */
  }
  signal?.throwIfAborted();
  return { response, payload };
}

export function httpError(response, source) {
  const status = response.status;
  const code =
    status === 429
      ? 'limited'
      : status === 401 || status === 403
        ? 'denied'
        : 'unavailable';
  return new LiveSourceError(
    code,
    status === 429 ? `${source} rate limited` : `${source} HTTP ${status}`,
    {
      status,
      source,
      retryAfterMs: code === 'limited' || code === 'denied' ? 45000 : 20000,
    },
  );
}
