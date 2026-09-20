import { withBase } from '../../services/apiBase.js';
const GROUPS = new Set([
  'stations',
  'visual',
  'gps-ops',
  'glo-ops',
  'galileo',
  'geo',
  'starlink',
]);

/** Read catalog text from the existing group endpoint using a supplied transport. */
export function createSatelliteSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  return {
    async readGroup(group, { signal } = {}) {
      if (!GROUPS.has(group)) throw new TypeError('Unknown satellite group');
      signal?.throwIfAborted();
      const response = await fetchImpl(
        `${withBase('/api/celestrak')}/${group}`,
        { signal },
      );
      const text = response.ok ? await response.text() : '';
      signal?.throwIfAborted();
      return { ok: response.ok, status: response.status, text };
    },
  };
}
