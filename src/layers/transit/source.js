import { fetchTransitHistory } from '../../sources/transitHistory.js';
import { normalizeTransitStationPayload } from './stationModel.js';

/**
 * The local proxy route that serves the French passenger-station catalogue.
 *
 * The browser NEVER names an upstream URL: it asks the local proxy for the
 * station route, and the proxy resolves the SNCF Open Data catalogue URL from
 * its own server-side allow-list.
 */
export const TRANSIT_STATIONS_ENDPOINT = '/api/sncf/stations';

/** Request transit snapshots through caller-owned transport. */
export function createTransitSource({
  fetchImpl = (...args) => fetch(...args),
} = {}) {
  return {
    /**
     * Read the French passenger-station network.
     *
     * This is the STATION CATALOGUE, not live vehicle telemetry: the SNCF
     * open-data catalogue publishes no live train positions. The Transit layer
     * draws it as the station network alongside its live GTFS-RT fleet.
     *
     * @param {{signal?: AbortSignal}} [options]
     * @returns {Promise<{stations: Array<object>, total: number}>}
     */
    async getStations({ signal } = {}) {
      signal?.throwIfAborted();
      const response = await fetchImpl(TRANSIT_STATIONS_ENDPOINT, {
        signal,
        cache: 'no-store',
        headers: { Accept: 'application/json' },
      });
      let payload;
      try {
        payload = await response.json();
      } catch {
        // The status below stays authoritative.
      }
      signal?.throwIfAborted();
      if (!response.ok) {
        throw new Error(`SNCF stations HTTP ${response.status}`);
      }
      const normalized = normalizeTransitStationPayload(payload);
      if (!normalized) throw new Error('Malformed station response');
      return normalized;
    },
    /** Read the public catalog of enabled feeds. */
    async getFeeds({ signal } = {}) {
      signal?.throwIfAborted();
      const response = await fetchImpl('/api/transit/feeds', {
        signal,
        headers: { Accept: 'application/json' },
      });
      if (!response.ok)
        throw new Error('Transit feeds HTTP ' + response.status);
      const body = await response.json();
      signal?.throwIfAborted();
      if (!Array.isArray(body?.feeds))
        throw new Error('Malformed transit feed catalog');
      return body.feeds;
    },
    getHistory(feedId, vehicleId, { signal } = {}) {
      signal?.throwIfAborted();
      return fetchTransitHistory(feedId, vehicleId, signal, fetchImpl);
    },
    requestSnapshot(feedId, { signal } = {}) {
      signal?.throwIfAborted();
      if (typeof feedId !== 'string' || !feedId || feedId.length > 160)
        throw new TypeError('A transit feed identifier is required');
      return Promise.resolve(
        fetchImpl(`/api/transit/vehicles/${encodeURIComponent(feedId)}`, {
          signal,
          headers: { Accept: 'application/json' },
        }),
      ).then((response) => {
        signal?.throwIfAborted();
        return {
          ok: response.ok,
          status: response.status,
          headers: response.headers,
          async json() {
            const body = await response.json();
            signal?.throwIfAborted();
            return body;
          },
        };
      });
    },
  };
}
