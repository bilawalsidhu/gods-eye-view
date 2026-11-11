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
 * Every record has a stable `id` (a non-empty string) that keys it across
 * snapshots. A vessel record's `id` is whatever its source gives, such as a
 * provider id; its `mmsi` is an optional attribute ('' or absent when
 * unknown), never its key, since vessels can share an MMSI. A source that
 * only has MMSIs uses the MMSI as the id.
 *
 * A source may also declare a timeline (see readSnapshotTimeline): it can
 * answer a snapshot at a given time, so the layer follows the world clock.
 * The query then carries `atMs` (absent while the clock is live, so a live
 * request is unchanged), and the snapshot is the world as it stood at that
 * time: `observedAtMs` <= `atMs`, no record observed later than `atMs`,
 * freshness and staleness judged against `atMs`, and `atMs` echoed back. A
 * vessel snapshot at a time reports `transportStatus: 'live'`. getTrack then
 * receives `{ signal, atMs }` and returns only points at or before `atMs`.
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

/**
 * The timeline a source declares, or null when it has none or it is
 * malformed: `{ coverage(), stepMs, subscribe? }`. `coverage()` returns the
 * span `{start, end}` (epoch ms) the source can answer a snapshot for, or
 * null while it does not know yet; `stepMs` is the spacing of its snapshots;
 * the optional `subscribe(listener)` tells of a change in coverage, or of a
 * better answer for a time already answered (a paused layer then loads the
 * time shown again), and returns the unsubscribe.
 * @param {object|null|undefined} source
 * @returns {{coverage: () => ({start: number, end: number}|null),
 *   stepMs: number, subscribe: ((listener: () => void) => () => void)|null}|null}
 */
export function readSnapshotTimeline(source) {
  const timeline = source?.timeline;
  if (!timeline || typeof timeline !== 'object') return null;
  if (typeof timeline.coverage !== 'function') return null;
  const stepMs = timeline.stepMs;
  if (!Number.isFinite(stepMs) || stepMs <= 0) return null;
  if (timeline.subscribe != null && typeof timeline.subscribe !== 'function')
    return null;
  return {
    coverage: () => timeline.coverage(),
    stepMs,
    subscribe: timeline.subscribe
      ? (listener) => timeline.subscribe(listener)
      : null,
  };
}
