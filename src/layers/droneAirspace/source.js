import { fetchProxyRows } from '../../sources/proxyRows.js';

/** Request a normalized snapshot through the bounded, same-origin FAA proxy. */
export function createDroneAirspaceSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  return {
    /**
     * The zone rows with how fresh they are: the proxy answers from its last
     * snapshot, marked stale, while the FAA service is unreachable.
     * @returns {Promise<{rows: object[], stale: boolean, fetchedAt: number|null}>}
     */
    getSnapshot: ({ signal } = {}) =>
      fetchProxyRows(fetchImpl, '/api/drone-airspace', {
        upstream: 'FAA SUA',
        malformed: 'Malformed drone airspace snapshot',
        signal,
      }),
  };
}
