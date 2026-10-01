import { normalizeBurntAreasSnapshot } from './records.js';

const API_URL = '/api/effis/burnt-areas';

/** Request and validate a complete EFFIS burnt-areas snapshot before it can replace displayed polygons. */
export function createEffisBurntAreasSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  return {
    async getSnapshot({ signal } = {}) {
      signal?.throwIfAborted();
      const response = await fetchImpl(API_URL, { signal });
      if (!response.ok) throw new Error(`EFFIS HTTP ${response.status}`);
      const payload = await response.json();
      signal?.throwIfAborted();
      const rows = normalizeBurntAreasSnapshot(payload);
      if (!rows) throw new Error('Malformed EFFIS response');
      return rows;
    },
  };
}
