import { readResponseJsonCapped } from '../../sources/httpBody.js';
import {
  isLiveTvCountryCode,
  sanitizeLiveTvChannels,
  sanitizeLiveTvCountries,
} from './records.js';

/** Request the iptv-org channel index through the same-origin proxy. */
export function createLiveTvSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  return {
    /** Countries with at least one playable channel, busiest first. */
    async getSnapshot({ signal } = {}) {
      signal?.throwIfAborted();
      const response = await fetchImpl('/api/live-tv', { signal });
      if (!response.ok) throw new Error(`Live TV HTTP ${response.status}`);
      const payload = await readResponseJsonCapped(
        response,
        1024 * 1024,
        signal,
      );
      signal?.throwIfAborted();
      const countries = sanitizeLiveTvCountries(payload?.countries);
      if (!countries) throw new Error('Malformed live TV snapshot');
      return {
        countries,
        fetchedAt: Number.isFinite(payload.fetchedAt)
          ? payload.fetchedAt
          : null,
        stale: payload.stale === true,
      };
    },

    /** One country's channels and their stream links. */
    async getCountry(code, { signal } = {}) {
      if (!isLiveTvCountryCode(code)) throw new TypeError('Invalid country');
      signal?.throwIfAborted();
      const response = await fetchImpl(`/api/live-tv/country/${code}`, {
        signal,
      });
      if (!response.ok) throw new Error(`Live TV HTTP ${response.status}`);
      const payload = await readResponseJsonCapped(
        response,
        4 * 1024 * 1024,
        signal,
      );
      signal?.throwIfAborted();
      const channels = sanitizeLiveTvChannels(payload?.channels);
      if (!channels || payload.code !== code)
        throw new Error('Malformed live TV country');
      return { code, channels };
    },
  };
}
