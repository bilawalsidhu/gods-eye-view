const GROUPS = new Set([
  'stations',
  'visual',
  'gps-ops',
  'glo-ops',
  'galileo',
  'geo',
  'starlink',
  // Imaging coverage beyond the UCS May 2023 snapshot, and science probes.
  'resource',
  'weather',
  'planet',
  'sar',
  'science',
]);

/** The UCS pack, loaded on first use (see src/data/ucsSatellites.js). */
async function loadBundledUcs() {
  const { loadUcsSatellites } = await import('../../data/ucsSatellites.js');
  return loadUcsSatellites();
}

/** The imaging-sensor pack, loaded on first use (see src/data/imagingSensors.js). */
async function loadBundledSensors() {
  const { loadImagingSensors } = await import('../../data/imagingSensors.js');
  return loadImagingSensors();
}

/** Read catalog text from the existing group endpoint using a supplied transport. */
export function createSatelliteSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
  loadUcs = loadBundledUcs,
  loadSensors = loadBundledSensors,
} = {}) {
  return {
    async readGroup(group, { signal } = {}) {
      if (!GROUPS.has(group)) throw new TypeError('Unknown satellite group');
      signal?.throwIfAborted();
      const response = await fetchImpl(`/api/celestrak/${group}`, { signal });
      const text = response.ok ? await response.text() : '';
      signal?.throwIfAborted();
      // The proxy serves its last copy, marked STALE-ERROR, when CelesTrak
      // is down.
      const stale = response.headers?.get?.('x-tle-cache') === 'STALE-ERROR';
      return { ok: response.ok, status: response.status, text, stale };
    },

    /**
     * CelesTrak SATCAT records (CSV) for one group: object type, operational
     * status and owner, through the proxy's day-long cache.
     */
    async readSatcat(group, { signal } = {}) {
      if (!GROUPS.has(group)) throw new TypeError('Unknown satellite group');
      signal?.throwIfAborted();
      const response = await fetchImpl(`/api/celestrak-satcat/${group}`, {
        signal,
      });
      const text = response.ok ? await response.text() : '';
      signal?.throwIfAborted();
      // The proxy serves its last copy, marked STALE-ERROR, when CelesTrak
      // is down.
      const stale = response.headers?.get?.('x-satcat-cache') === 'STALE-ERROR';
      return { ok: response.ok, status: response.status, text, stale };
    },

    /** The UCS Satellite Database pack, keyed by NORAD number. */
    readUcs() {
      return loadUcs();
    },

    /** The imaging-sensor pack, indexed by NORAD number and name pattern. */
    readSensors() {
      return loadSensors();
    },
  };
}
