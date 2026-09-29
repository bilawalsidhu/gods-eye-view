import { readResponseJsonCapped } from '../../sources/httpBody.js';
import { RADIATION_SOURCES, sanitizeRadiationReadings } from './records.js';

/** Request current dose-rate readings through the same-origin proxy. */
export function createRadiationSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  return {
    async getSnapshot({ signal } = {}) {
      signal?.throwIfAborted();
      const response = await fetchImpl('/api/radiation', { signal });
      if (!response.ok) throw new Error(`Radiation HTTP ${response.status}`);
      const payload = await readResponseJsonCapped(
        response,
        4 * 1024 * 1024,
        signal,
      );
      signal?.throwIfAborted();
      const readings = sanitizeRadiationReadings(payload?.readings);
      if (!readings) throw new Error('Malformed radiation snapshot');
      return {
        readings,
        missing: Array.isArray(payload.feeds)
          ? payload.feeds
              .filter(
                (feed) =>
                  feed?.missing === true &&
                  RADIATION_SOURCES.includes(feed.source),
              )
              .map((feed) => feed.source)
          : [],
        fetchedAt: Number.isFinite(payload.fetchedAt)
          ? payload.fetchedAt
          : null,
        stale: payload.stale === true,
      };
    },
  };
}
