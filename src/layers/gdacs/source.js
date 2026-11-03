import { readResponseJsonCapped } from '../../sources/httpBody.js';
import { GDACS_EVENT_TYPES, sanitizeGdacsEvents } from './records.js';

/** Request current GDACS alerts through the same-origin proxy. */
export function createGdacsSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  return {
    async getSnapshot({ signal } = {}) {
      signal?.throwIfAborted();
      const response = await fetchImpl('/api/gdacs', { signal });
      if (!response.ok) throw new Error(`GDACS HTTP ${response.status}`);
      const payload = await readResponseJsonCapped(
        response,
        4 * 1024 * 1024,
        signal,
      );
      signal?.throwIfAborted();
      const events = sanitizeGdacsEvents(payload?.events);
      if (!events) throw new Error('Malformed GDACS snapshot');
      return {
        events,
        missing: Array.isArray(payload.feeds)
          ? payload.feeds
              .filter(
                (feed) =>
                  feed?.missing === true &&
                  GDACS_EVENT_TYPES.includes(feed.type),
              )
              .map((feed) => feed.type)
          : [],
        fetchedAt: Number.isFinite(payload.fetchedAt)
          ? payload.fetchedAt
          : null,
        stale: payload.stale === true,
      };
    },
  };
}
