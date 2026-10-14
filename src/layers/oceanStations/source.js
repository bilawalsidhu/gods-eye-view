import { normalizeOceanStationSnapshot } from './records.js';

const DEFAULT_API_URL = '/api/ocean-stations/latest';

/**
 * Request and validate a complete ocean observation stations snapshot.
 */
export function createOceanStationsSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
  apiUrl = DEFAULT_API_URL,
} = {}) {
  return {
    async getSnapshot({ signal } = {}) {
      signal?.throwIfAborted();
      const response = await fetchImpl(apiUrl, { signal });
      if (!response.ok) {
        throw new Error(`Ocean stations HTTP ${response.status}`);
      }
      const payload = await response.json();
      signal?.throwIfAborted();
      const rows = normalizeOceanStationSnapshot(payload);
      if (!rows) {
        throw new Error('Malformed ocean stations response');
      }
      return rows;
    },
  };
}
