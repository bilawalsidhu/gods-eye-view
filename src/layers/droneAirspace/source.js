import { readResponseJsonCapped } from '../../sources/httpBody.js';

/** Request a normalized snapshot through the bounded, same-origin FAA proxy. */
export function createDroneAirspaceSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  return {
    async getSnapshot({ signal } = {}) {
      signal?.throwIfAborted();
      const response = await fetchImpl('/api/drone-airspace', { signal });
      if (!response.ok) throw new Error(`FAA SUA HTTP ${response.status}`);
      const payload = await readResponseJsonCapped(
        response,
        80 * 1024 * 1024,
        signal,
      );
      signal?.throwIfAborted();
      if (!Array.isArray(payload?.rows))
        throw new Error('Malformed drone airspace snapshot');
      return payload.rows;
    },
  };
}
