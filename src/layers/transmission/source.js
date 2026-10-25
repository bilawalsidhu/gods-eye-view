import { normalizePack } from './model.js';

/** Lazily read the dated local snapshot. The layer owns cancellation and caching. */
export function createTransmissionSource({
  fetchImpl = (...args) => fetch(...args),
} = {}) {
  async function read(url, signal) {
    signal?.throwIfAborted();
    const response = await fetchImpl(url, { signal, cache: 'force-cache' });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Transmission pack HTTP ${response.status}`);
    }
    const json = await response.json();
    signal?.throwIfAborted();
    return json;
  }
  return {
    async getSnapshot({ signal } = {}) {
      const [pack, metadata] = await Promise.all([
        read(
          new URL(
            '../../data/local_data/transmission/cape-town.geojson',
            import.meta.url,
          ).href,
          signal,
        ),
        read(
          new URL(
            '../../data/local_data/transmission/source.json',
            import.meta.url,
          ).href,
          signal,
        ),
      ]);
      return normalizePack(pack, metadata);
    },
  };
}
