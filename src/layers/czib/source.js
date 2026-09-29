import { readResponseJsonCapped } from '../../sources/httpBody.js';
import { sanitizeCzibBulletins } from './records.js';

/** Request the current EASA conflict zone bulletins through the proxy. */
export function createCzibSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  return {
    async getSnapshot({ signal } = {}) {
      signal?.throwIfAborted();
      const response = await fetchImpl('/api/czib', { signal });
      if (!response.ok) throw new Error(`EASA CZIB HTTP ${response.status}`);
      const payload = await readResponseJsonCapped(
        response,
        1024 * 1024,
        signal,
      );
      signal?.throwIfAborted();
      const bulletins = sanitizeCzibBulletins(payload?.bulletins);
      if (!bulletins) throw new Error('Malformed EASA CZIB snapshot');
      return {
        bulletins,
        linksMissing: payload.linksMissing === true,
        fetchedAt: Number.isFinite(payload.fetchedAt)
          ? payload.fetchedAt
          : null,
        stale: payload.stale === true,
      };
    },
  };
}
