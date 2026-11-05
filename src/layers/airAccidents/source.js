import { readResponseJsonCapped } from '../../sources/httpBody.js';
import { normalizeAirAccidentSnapshot } from './records.js';

/** Same-origin source for the proxy's CENIPA + Wikidata accident snapshot. */
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
        16 * 1024 * 1024,
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
        sources: {
          cenipa: payload.sources?.cenipa !== false,
          wikidata: payload.sources?.wikidata !== false,
        },
      };
    },
  };
}
