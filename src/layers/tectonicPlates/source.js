import {
  fetchAllTectonicPlateGeoJson,
  normalizeTectonicPlateSnapshot,
} from '../../data/tectonicPlates.js';

/**
 * Public USGS tectonic-boundary source.
 */
export function createUsgsTectonicPlateSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  return {
    async getSnapshot({ signal } = {}) {
      signal?.throwIfAborted();

      const payload = await fetchAllTectonicPlateGeoJson(fetchImpl);

      signal?.throwIfAborted();

      const rows = normalizeTectonicPlateSnapshot(payload);

      if (!rows) {
        throw new Error('Malformed USGS tectonic-plates response');
      }

      return rows;
    },
  };
}