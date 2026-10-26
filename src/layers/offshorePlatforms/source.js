import { normalizeOffshoreSnapshot } from './records.js';

/** Caller owns lifetime/caching. Construction and imports never start a request. */
export function createOffshoreInventorySource({ url, fetchImpl = (...args) => globalThis.fetch(...args) } = {}) {
  if (!url) throw new TypeError('Offshore inventory URL is required');
  return {
    async getSnapshot({ signal } = {}) {
      signal?.throwIfAborted();
      const response = await fetchImpl(url, { signal });
      if (!response.ok) throw new Error(`Offshore inventory HTTP ${response.status}`);
      const payload = await response.json();
      signal?.throwIfAborted();
      return normalizeOffshoreSnapshot(payload);
    },
  };
}
