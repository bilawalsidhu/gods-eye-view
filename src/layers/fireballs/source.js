import { normalizeFireballSnapshot } from './records.js';

/** Request and validate a complete fireball snapshot through the local proxy. */
export function createFireballSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
  apiUrl = '/api/fireballs',
} = {}) {
  return {
    async getSnapshot({ signal } = {}) {
      signal?.throwIfAborted();
      const response = await fetchImpl(apiUrl, { signal });
      if (!response.ok)
        throw new Error(`Fireball proxy HTTP ${response.status}`);
      const payload = await response.json();
      signal?.throwIfAborted();
      const rows = normalizeFireballSnapshot(payload);
      if (!rows) throw new Error('Malformed fireball response');
      return rows;
    },
  };
}
