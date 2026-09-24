import { normalizeAqhiStations, normalizeAqhiObservations } from './model.js';

const COLLECTIONS_ROOT = 'https://api.weather.gc.ca/collections';
const STATIONS_URL = `${COLLECTIONS_ROOT}/aqhi-stations/items`;
const OBSERVATIONS_URL = `${COLLECTIONS_ROOT}/aqhi-observations-realtime/items`;

/** Comfortably above Canada's ~134 stations without inviting a huge page. */
const STATION_LIMIT = 500;
const OBSERVATION_LIMIT = 500;
/** Station geometry is near-static — a few changes a year. Refetch twice a day. */
const STATION_TTL_MS = 12 * 60 * 60 * 1000;

/**
 * Request and validate a complete ECCC AQHI snapshot before it can replace
 * displayed readings. The first registered air-quality provider.
 *
 * Two collections are involved. `aqhi-stations` is the catalog — it supplies
 * every reading its coordinates and is cached for twelve hours because it
 * barely changes. `aqhi-observations-realtime` is the hourly reading feed,
 * requested with `latest=true` so the response is current values rather than
 * the full observation history, which is roughly 2,000 rows nationally.
 *
 * The station catalog is only replaced when a refresh actually returns
 * stations, so a transient empty response cannot blank the layer.
 *
 * @param {object} [options]
 * @param {Function} [options.fetchImpl] - Injected fetch, for tests.
 * @param {() => number} [options.now] - Clock seam, for tests.
 * @returns {{getSnapshot: Function}}
 */
export function createEcccAirQualitySource({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
} = {}) {
  /** @type {Map<string, object>} */
  let stations = new Map();
  let stationsFetchedAt = 0;

  const getJson = async (url, signal) => {
    signal?.throwIfAborted();
    const response = await fetchImpl(url, {
      headers: { Accept: 'application/json' },
      signal,
    });
    if (!response.ok) throw new Error(`ECCC HTTP ${response.status}`);
    const payload = await response.json();
    signal?.throwIfAborted();
    return payload;
  };

  return {
    async getSnapshot({ signal } = {}) {
      const clock = now();
      if (stations.size === 0 || clock - stationsFetchedAt > STATION_TTL_MS) {
        const payload = await getJson(
          `${STATIONS_URL}?f=json&limit=${STATION_LIMIT}`,
          signal,
        );
        const next = normalizeAqhiStations(payload);
        if (!next) throw new Error('Malformed AQHI station response');
        // An empty refresh must not wipe a good catalog.
        if (next.size > 0) {
          stations = next;
          stationsFetchedAt = clock;
        }
      }
      if (stations.size === 0) throw new Error('No AQHI stations available');

      const payload = await getJson(
        `${OBSERVATIONS_URL}?f=json&latest=true&limit=${OBSERVATION_LIMIT}`,
        signal,
      );
      const readings = normalizeAqhiObservations(payload, stations, clock);
      if (!readings) throw new Error('Malformed AQHI observation response');
      return readings;
    },
  };
}
