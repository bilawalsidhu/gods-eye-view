import {
  mergeEarthquakeSnapshots,
  normalizeEarthquakeSnapshot,
  normalizeEmscSnapshot,
} from './records.js';
const API_URL =
  'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson';
const EMSC_URL = 'https://www.seismicportal.eu/fdsnws/event/1/query';
const DAY_MS = 86_400_000;
/** Events per EMSC page; a 24-hour M2.5+ query is a few hundred. */
export const EMSC_PAGE_SIZE = 2000;
/** Pages read before the snapshot stops (10,000 events). */
export const EMSC_MAX_PAGES = 5;
/** An EMSC request that has not answered by now is given up on. */
export const EMSC_TIMEOUT_MS = 15_000;
/** Request and validate a complete USGS snapshot before it can replace displayed events. */
export function createUsgsEarthquakeSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  return {
    async getSnapshot({ signal } = {}) {
      signal?.throwIfAborted();
      const response = await fetchImpl(API_URL, { signal });
      if (!response.ok) throw new Error(`USGS HTTP ${response.status}`);
      const payload = await response.json();
      signal?.throwIfAborted();
      const rows = normalizeEarthquakeSnapshot(payload);
      if (!rows) throw new Error('Malformed USGS response');
      return rows;
    },
  };
}

/**
 * The EMSC event query for M2.5+ earthquakes over the 24 hours before
 * `nowMs`, newest first. `page` 0 is the first EMSC_PAGE_SIZE events; FDSN's
 * `offset` counts from 1.
 */
export function emscQueryUrl(nowMs, page = 0) {
  const params = new URLSearchParams({
    format: 'json',
    minmag: '2.5',
    starttime: new Date(nowMs - DAY_MS).toISOString().slice(0, 19),
    orderby: 'time',
    limit: String(EMSC_PAGE_SIZE),
  });
  if (page > 0) params.set('offset', String(page * EMSC_PAGE_SIZE + 1));
  return `${EMSC_URL}?${params}`;
}

/** `signal` or `timeoutMs`, whichever aborts first; `done` clears the timer. */
function withTimeout(signal, timeoutMs) {
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  const timer = setTimeout(
    () => controller.abort(new Error('EMSC request timed out')),
    timeoutMs,
  );
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });
  return {
    signal: controller.signal,
    done() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    },
  };
}

/**
 * EMSC SeismicPortal (keyless, CORS-enabled, CC BY 4.0): European and
 * Mediterranean networks report many M2.5+ events the USGS feed lacks.
 */
export function createEmscEarthquakeSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
  timeoutMs = EMSC_TIMEOUT_MS,
} = {}) {
  return {
    async getSnapshot({ signal } = {}) {
      signal?.throwIfAborted();
      // A stalled EMSC must not hold back USGS, which waits for both.
      const request = withTimeout(signal, timeoutMs);
      try {
        const nowMs = now();
        const features = [];
        const ids = new Set();
        for (let page = 0; page < EMSC_MAX_PAGES; page++) {
          const response = await fetchImpl(emscQueryUrl(nowMs, page), {
            signal: request.signal,
          });
          // No (more) events: FDSN answers 204 with an empty body.
          if (response.status === 204) break;
          if (!response.ok) throw new Error(`EMSC HTTP ${response.status}`);
          const payload = await response.json();
          request.signal.throwIfAborted();
          if (!Array.isArray(payload?.features))
            throw new Error('Malformed EMSC response');
          // A new event shifts later pages by one; its neighbour repeats.
          for (const feature of payload.features) {
            const id = feature?.properties?.unid ?? feature?.id;
            if (id != null && ids.has(id)) continue;
            if (id != null) ids.add(id);
            features.push(feature);
          }
          if (payload.features.length < EMSC_PAGE_SIZE) break;
          if (page === EMSC_MAX_PAGES - 1)
            console.warn(
              `[Data:Earthquakes] EMSC has more than ${features.length} events; the oldest are left out`,
            );
        }
        const rows = normalizeEmscSnapshot({ features });
        if (!rows) throw new Error('Malformed EMSC response');
        return rows;
      } finally {
        request.done();
      }
    },
  };
}

/**
 * USGS plus the EMSC events USGS does not report. Either catalog alone still
 * yields a snapshot; only both failing is an error.
 */
export function createEarthquakeSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
  usgs = createUsgsEarthquakeSource({ fetchImpl }),
  emsc = createEmscEarthquakeSource({ fetchImpl }),
} = {}) {
  return {
    async getSnapshot({ signal } = {}) {
      const [usgsResult, emscResult] = await Promise.allSettled([
        usgs.getSnapshot({ signal }),
        emsc.getSnapshot({ signal }),
      ]);
      signal?.throwIfAborted();
      if (usgsResult.status === 'rejected' && emscResult.status === 'rejected')
        throw usgsResult.reason;
      return mergeEarthquakeSnapshots(
        usgsResult.status === 'fulfilled' ? usgsResult.value : [],
        emscResult.status === 'fulfilled' ? emscResult.value : [],
      );
    },
  };
}
