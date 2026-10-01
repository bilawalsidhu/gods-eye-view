import { normalizeGdeltSnapshot } from './records.js';

/** Request cached 15-minute GDELT headlines from the local server proxy. */
export function createGdeltEventsSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
  url = '/api/gdelt',
} = {}) {
  return {
    async getSnapshot({ signal } = {}) {
      signal?.throwIfAborted();
      const res = await fetchImpl(url, { signal });
      if (!res.ok && res.status !== 429) {
        throw new Error(`GDELT proxy HTTP ${res.status}`);
      }
      const data = await res.json();
      signal?.throwIfAborted();
      const rows = normalizeGdeltSnapshot(data);
      return {
        rows,
        status: data?.status || 'ready',
        stale: Boolean(data?.stale),
      };
    },
  };
}
