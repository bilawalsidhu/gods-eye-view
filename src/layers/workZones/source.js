import { readResponseJsonCapped } from '../../sources/httpBody.js';

// A portable module: no i18n catalog here. Failures stay English data in the
// shapes translateFeedError (src/ui/statusText.js) already reads; the Layers
// panel shows them translated.
const msg = (text) => text;

/** The proxy's snapshot is ~1.7 MB uncompressed for eight states. */
const MAX_SNAPSHOT_BYTES = 24 * 1024 * 1024;
const FEED_STATUSES = new Set(['live', 'stale', 'unavailable']);

function retryAfterMs(raw) {
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds > 0
    ? Math.min(3600, Math.max(5, seconds)) * 1000
    : null;
}

const finiteOrNull = (value) => (Number.isFinite(value) ? value : null);
const textOrNull = (value) => (typeof value === 'string' ? value : null);

/** One feed row of the snapshot, or null when it is not one. */
function feedRow(row, ageMs, builtAt) {
  if (typeof row?.id !== 'string' || !FEED_STATUSES.has(row.status))
    return null;
  const fetchedAt = finiteOrNull(row.fetchedAt);
  return {
    id: row.id,
    name: textOrNull(row.name) ?? row.id,
    publisher: textOrNull(row.publisher) ?? row.id,
    status: row.status,
    count: Number.isInteger(row.count) && row.count >= 0 ? row.count : 0,
    version: textOrNull(row.version),
    // Measured on the proxy's clock, then carried to this one by the age.
    ageMs:
      fetchedAt !== null && builtAt !== null
        ? Math.max(0, builtAt - fetchedAt + ageMs)
        : null,
  };
}

function position(value) {
  return Array.isArray(value) &&
    value.length === 2 &&
    Number.isFinite(value[0]) &&
    Number.isFinite(value[1]) &&
    Math.abs(value[0]) <= 180 &&
    Math.abs(value[1]) <= 90
    ? value
    : null;
}

/** One event as the proxy normalised it (records.js), checked again. */
function eventRecord(event) {
  const anchor = position(event?.anchor);
  if (typeof event?.id !== 'string' || !anchor) return null;
  if (event.type !== 'work-zone' && event.type !== 'detour') return null;
  const lines = Array.isArray(event.lines)
    ? event.lines.filter(
        (line) =>
          Array.isArray(line) && line.length >= 2 && line.every(position),
      )
    : [];
  return {
    id: event.id,
    feed: textOrNull(event.feed),
    type: event.type,
    roads: Array.isArray(event.roads)
      ? event.roads.filter((road) => typeof road === 'string')
      : [],
    direction: textOrNull(event.direction) ?? 'unknown',
    description: textOrNull(event.description),
    start: finiteOrNull(event.start),
    end: finiteOrNull(event.end),
    impact: textOrNull(event.impact),
    workers: typeof event.workers === 'boolean' ? event.workers : null,
    updated: finiteOrNull(event.updated),
    anchor,
    lines,
  };
}

/** Read the shared US WZDx snapshot through the fixed same-origin route. */
export function createWorkZoneSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  return {
    label: msg('WZDx · US state DOTs'),
    async getSnapshot({ signal } = {}) {
      signal?.throwIfAborted();
      let response;
      try {
        response = await fetchImpl('/api/wzdx/events', { signal });
      } catch (error) {
        if (signal?.aborted || error?.name === 'AbortError') throw error;
        throw new Error(msg('WZDx network error'));
      }
      if (!response.ok) {
        void response.body?.cancel?.().catch(() => {});
        throw Object.assign(
          new Error(
            response.status === 429
              ? msg('WZDx rate limited')
              : `WZDx HTTP ${response.status}`,
          ),
          {
            status: response.status,
            retryAfterMs: retryAfterMs(response.headers.get('retry-after')),
          },
        );
      }
      let payload;
      try {
        payload = await readResponseJsonCapped(
          response,
          MAX_SNAPSHOT_BYTES,
          signal,
        );
      } catch (error) {
        if (signal?.aborted || error?.name === 'AbortError') throw error;
        throw new Error(msg('Malformed WZDx response'));
      }
      signal?.throwIfAborted();
      if (!Array.isArray(payload?.events) || !Array.isArray(payload?.feeds))
        throw new Error(msg('Malformed WZDx response'));
      const age = Number(response.headers.get('x-snapshot-age'));
      const ageMs = Number.isFinite(age) && age >= 0 ? age : 0;
      const builtAt = finiteOrNull(payload.builtAt);
      return {
        feeds: payload.feeds
          .map((row) => feedRow(row, ageMs, builtAt))
          .filter(Boolean),
        events: payload.events.map(eventRecord).filter(Boolean),
        ageMs,
        linesDropped:
          Number.isInteger(payload.linesDropped) && payload.linesDropped > 0
            ? payload.linesDropped
            : 0,
      };
    },
  };
}
