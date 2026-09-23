import { fetchTransitHistory } from '../../sources/transitHistory.js';

/** Request transit snapshots through caller-owned transport. */
export function createTransitSource({
  fetchImpl = (...args) => fetch(...args),
} = {}) {
  return {
    getHistory(feedId, vehicleId, { signal } = {}) {
      signal?.throwIfAborted();
      return fetchTransitHistory(feedId, vehicleId, signal, fetchImpl);
    },
    /**
     * Route catalog or alert list for a feed that publishes one. Resolves to
     * the parsed JSON, or rejects with an Error carrying `status` and
     * `retryInSec` so the caller can back off as the server asked.
     * @param {'routes'|'alerts'} kind
     * @param {string} feedId
     * @param {{signal?: AbortSignal}} [options]
     * @returns {Promise<object>}
     */
    async requestNetwork(kind, feedId, { signal } = {}) {
      signal?.throwIfAborted();
      if (kind !== 'routes' && kind !== 'alerts')
        throw new TypeError('Unknown transit network resource');
      if (typeof feedId !== 'string' || !feedId || feedId.length > 160)
        throw new TypeError('A transit feed identifier is required');
      const response = await fetchImpl(
        `/api/transit/${kind}/${encodeURIComponent(feedId)}`,
        { signal, headers: { Accept: 'application/json' } },
      );
      signal?.throwIfAborted();
      let body = null;
      try {
        body = await response.json();
      } catch {
        body = null;
      }
      signal?.throwIfAborted();
      if (!response.ok || !body || typeof body !== 'object') {
        const error = new Error(
          `Transit ${kind} unavailable (HTTP ${response.status})`,
        );
        error.status = response.status;
        const retry = Number(body?.retryInSec);
        error.retryInSec = Number.isFinite(retry) && retry > 0 ? retry : null;
        throw error;
      }
      return body;
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
