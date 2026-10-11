import {
  mergeEarthquakeSnapshots,
  normalizeEarthquakeSnapshot,
  normalizeEmscSnapshot,
} from './records.js';
const API_URL =
  'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson';
const EMSC_URL = 'https://www.seismicportal.eu/fdsnws/event/1/query';
const DAY_MS = 86_400_000;
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

/** The EMSC event query for M2.5+ earthquakes over the 24 hours before `nowMs`. */
export function emscQueryUrl(nowMs) {
  const params = new URLSearchParams({
    format: 'json',
    minmag: '2.5',
    starttime: new Date(nowMs - DAY_MS).toISOString().slice(0, 19),
    orderby: 'time',
    limit: '2000',
  });
  return `${EMSC_URL}?${params}`;
}

/**
 * EMSC SeismicPortal (keyless, CORS-enabled, CC BY 4.0): European and
 * Mediterranean networks report many M2.5+ events the USGS feed lacks.
 */
export function createEmscEarthquakeSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
} = {}) {
  return {
    async getSnapshot({ signal } = {}) {
      signal?.throwIfAborted();
      const response = await fetchImpl(emscQueryUrl(now()), { signal });
      if (!response.ok) throw new Error(`EMSC HTTP ${response.status}`);
      const payload = await response.json();
      signal?.throwIfAborted();
      const rows = normalizeEmscSnapshot(payload);
      if (!rows) throw new Error('Malformed EMSC response');
      return rows;
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
