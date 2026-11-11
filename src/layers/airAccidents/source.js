import { readResponseJsonCapped } from '../../sources/httpBody.js';
import { normalizeAirAccidentSnapshot } from './records.js';

/** Same-origin source for the proxy's Wikidata accident snapshot. */
export function createAirAccidentsSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  return {
    async getSnapshot({ signal } = {}) {
      signal?.throwIfAborted();
      const response = await fetchImpl('/api/air-accidents', { signal });
      if (!response.ok)
        throw new Error(`Air accidents unavailable (HTTP ${response.status})`);
      const payload = await readResponseJsonCapped(
        response,
        8 * 1024 * 1024,
        signal,
      );
      signal?.throwIfAborted();
      const records = normalizeAirAccidentSnapshot(payload);
      if (!records) throw new Error('Malformed air accidents response');
      return {
        records,
        fetchedAt: Number.isFinite(payload.fetchedAt)
          ? payload.fetchedAt
          : null,
        stale: payload.stale === true,
        // False when only the accidents with their own coordinates arrived.
        complete: payload.complete !== false,
      };
    },
  };
}
