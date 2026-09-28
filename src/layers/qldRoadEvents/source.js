import { readResponseJsonCapped } from '../../sources/httpBody.js';

/** Request a normalized snapshot through the bounded, same-origin QLDTraffic proxy. */
export function createQldRoadEventsSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  return {
    async getSnapshot({ signal } = {}) {
      signal?.throwIfAborted();
      const response = await fetchImpl('/api/qld-road-events', { signal });
      if (!response.ok) throw new Error(`QLDTraffic HTTP ${response.status}`);
      const payload = await readResponseJsonCapped(
        response,
        8 * 1024 * 1024,
        signal,
      );
      signal?.throwIfAborted();
      if (!Array.isArray(payload?.events))
        throw new Error('Malformed QLDTraffic snapshot');
      return {
        events: payload.events,
        stale: payload.stale === true,
        fetchedAt: Number.isFinite(payload.fetchedAt)
          ? payload.fetchedAt
          : null,
      };
    },
  };
}
