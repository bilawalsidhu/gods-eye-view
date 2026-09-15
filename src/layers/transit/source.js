/**
 * Read one feed's decoded vehicle snapshot through the server proxy. The
 * proxy resolves the id against the registry and fetches only registered
 * URLs; the browser never names an upstream.
 */
export function createTransitSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  return {
    /**
     * @param {string} feedId Registered feed id.
     * @param {{signal?: AbortSignal}} [options]
     * @returns {Promise<object>} Snapshot with `vehicles[]`, plus `stale` when the proxy served a stale copy.
     */
    async getVehicles(feedId, { signal } = {}) {
      if (
        typeof feedId !== 'string' ||
        !/^[a-z0-9][a-z0-9-]{1,63}$/.test(feedId)
      )
        throw new TypeError('A registered transit feed id is required');
      signal?.throwIfAborted();
      const response = await fetchImpl(
        `/api/transit/vehicles/${encodeURIComponent(feedId)}`,
        { method: 'GET', headers: { Accept: 'application/json' }, signal },
      );
      if (!response.ok)
        throw new Error(`transit proxy HTTP ${response.status}`);
      const payload = await response.json();
      signal?.throwIfAborted();
      if (
        !payload ||
        typeof payload !== 'object' ||
        !Array.isArray(payload.vehicles)
      )
        throw new Error('Malformed transit snapshot');
      return {
        ...payload,
        stale: response.headers?.get?.('x-gev-cache') === 'STALE-ERROR',
      };
    },
  };
}
