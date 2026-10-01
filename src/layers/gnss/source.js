import { readResponseJsonCapped } from '../../sources/httpBody.js';

/** Request integrity facts around a view anchor through the same-origin adsb.lol proxy. */
export function createAdsbGnssSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  return {
    async getSnapshot({ latitude, longitude } = {}, { signal } = {}) {
      signal?.throwIfAborted();
      if (!Number.isFinite(latitude) || !Number.isFinite(longitude))
        throw new Error('GNSS snapshot needs a view anchor');
      const params = new URLSearchParams({
        lat: latitude.toFixed(2),
        lon: longitude.toFixed(2),
      });
      const response = await fetchImpl(`/api/gnss-integrity?${params}`, {
        signal,
      });
      if (!response.ok) throw new Error(`adsb.lol HTTP ${response.status}`);
      const payload = await readResponseJsonCapped(
        response,
        4 * 1024 * 1024,
        signal,
      );
      signal?.throwIfAborted();
      if (!Array.isArray(payload?.rows))
        throw new Error('Malformed GNSS integrity snapshot');
      return {
        rows: payload.rows,
        fetchedAt: Number.isFinite(payload.fetchedAt)
          ? payload.fetchedAt
          : null,
        stale: payload.stale === true,
        classifier:
          typeof payload.classifier === 'string' ? payload.classifier : null,
      };
    },
  };
}
