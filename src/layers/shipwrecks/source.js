import { readResponseJsonCapped } from '../../sources/httpBody.js';
import { normalizeShipwreckSnapshot } from './records.js';

const age = (value) => (Number.isFinite(value) && value >= 0 ? value : null);

/** Same-origin source for the proxy's EMODnet + Wikidata shipwreck snapshot. */
export function createShipwrecksSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  return {
    async getSnapshot({ signal } = {}) {
      signal?.throwIfAborted();
      const response = await fetchImpl('/api/shipwrecks', { signal });
      if (!response.ok)
        throw new Error(`Shipwrecks unavailable (HTTP ${response.status})`);
      const payload = await readResponseJsonCapped(
        response,
        16 * 1024 * 1024,
        signal,
      );
      signal?.throwIfAborted();
      const records = normalizeShipwreckSnapshot(payload);
      if (!records) throw new Error('Malformed shipwrecks response');
      return {
        records,
        fetchedAt: Number.isFinite(payload.fetchedAt)
          ? payload.fetchedAt
          : null,
        stale: payload.stale === true,
        // Changes whenever either source's data does; null from an older proxy.
        version: typeof payload.version === 'string' ? payload.version : null,
        // Each source's age on the proxy's clock (null when unknown).
        ages: {
          emodnet: age(payload.ages?.emodnet),
          wikidata: age(payload.ages?.wikidata),
        },
        maxAgeMs: age(payload.maxAgeMs),
        sources: {
          emodnet: payload.sources?.emodnet !== false,
          wikidata: payload.sources?.wikidata !== false,
        },
      };
    },
  };
}
