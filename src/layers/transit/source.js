import { fetchTransitHistory } from '../../sources/transitHistory.js';

/** Request transit snapshots through caller-owned transport. */
export function createTransitSource({
  fetchImpl = (...args) => fetch(...args),
} = {}) {
  return {
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
