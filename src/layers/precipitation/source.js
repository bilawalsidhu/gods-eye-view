import { liveFrame, noKeyError } from './model.js';
import { STATUS_URL } from './policy.js';

/**
 * Ask the app's own server whether precipitation can be drawn, and how often.
 *
 * Every earlier version of this source read a public WMS straight from the
 * page. This one cannot and must not: Xweather puts both halves of the
 * credential in the tile URL path, so the browser is deliberately kept unable
 * to construct an upstream request at all. The only address here is
 * same-origin, which is the safety property — there is no external origin to
 * pin, because there is no external request.
 *
 * The tiles themselves are fetched by Cesium, not by this module. All that is
 * read here is the key state and the cadence.
 */
export function createPrecipitationSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  return {
    async getFrame(_tier, { signal } = {}) {
      signal?.throwIfAborted();
      const response = await fetchImpl(STATUS_URL, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal,
      });
      if (!response.ok)
        throw new Error(`Precipitation service HTTP ${response.status}`);
      const status = await response.json();
      // The body can resolve after the caller moved on; check before using it.
      signal?.throwIfAborted();
      // A malformed body is an unhealthy service, never a missing key. Reading
      // a missing field as `false` would report "add a key" to someone whose
      // key is fine.
      if (typeof status?.hasKey !== 'boolean')
        throw new TypeError('Malformed precipitation status');
      if (!status.hasKey) throw noKeyError();
      return liveFrame(Date.now(), status.refreshMs);
    },
  };
}
