import { readResponseJsonCapped } from '../../sources/httpBody.js';
import { API_BASE, FETCH_TIMEOUT_MS, MAX_RESPONSE_BYTES } from './policy.js';

/**
 * Avalanche forecasts and observations through the bounded same-origin proxy.
 * @param {{fetchImpl?:Function}} [options] Injected transport.
 * @returns {{getRegions:Function, getForecast:Function, getObservations:Function, getSeason:Function}}
 */
export function createAvalancheSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  async function get(path, { signal } = {}) {
    signal?.throwIfAborted();
    const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const response = await fetchImpl(`${API_BASE}${path}`, {
      signal: combined,
    });
    if (!response.ok) {
      await response.body?.cancel?.();
      throw Object.assign(new Error(`Avalanche data HTTP ${response.status}`), {
        failureReason: response.status === 429 ? 'rate_limited' : 'unavailable',
      });
    }
    const payload = await readResponseJsonCapped(
      response,
      MAX_RESPONSE_BYTES,
      combined,
    );
    signal?.throwIfAborted();
    return payload;
  }

  const range = (from, to) =>
    `from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;

  return {
    /** Forecast region outlines. */
    async getRegions(options) {
      const payload = await get('/regions', options);
      if (!Array.isArray(payload?.regions))
        throw new Error('Malformed avalanche regions');
      return payload.regions;
    },

    /** Danger ratings per region for each day from `from` to `to`. */
    async getForecast({ from, to, signal } = {}) {
      const payload = await get(`/forecast?${range(from, to)}`, { signal });
      if (!Array.isArray(payload?.regions))
        throw new Error('Malformed avalanche forecast');
      return { regions: payload.regions, stale: payload.stale === true };
    },

    /** Avalanches observed from `from` to `to`. */
    async getObservations({ from, to, signal } = {}) {
      const payload = await get(`/observations?${range(from, to)}`, {
        signal,
      });
      if (!Array.isArray(payload?.observations))
        throw new Error('Malformed avalanche observations');
      return {
        observations: payload.observations,
        stale: payload.stale === true,
      };
    },

    /** Observed avalanches per week across one December–May season. */
    async getSeason({ season, signal } = {}) {
      const payload = await get(
        `/season?season=${encodeURIComponent(season)}`,
        { signal },
      );
      if (!Array.isArray(payload?.weeks))
        throw new Error('Malformed avalanche season');
      return payload.weeks;
    },
  };
}
