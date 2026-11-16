/**
 * Vigicrues flood data, read through the server proxy.
 *
 * The browser NEVER names an upstream URL: it asks the local proxy for the
 * `stations` and `zones` routes, and the proxy resolves the Vigicrues URLs
 * from its own server-side allow-list.
 */
import {
  normalizeVigicruesStationPayload,
  normalizeVigicruesZonePayload,
} from './model.js';

// A portable export (package.json): no i18n here. Failures stay English data;
// the Layers panel shows them translated.
const msg = (text) => text;

/** The local proxy route that serves the hydro stations. */
export const VIGICRUES_STATIONS_ENDPOINT = '/api/vigicrues/stations';
/** The local proxy route that serves the flood-warning zone geometry. */
export const VIGICRUES_ZONES_ENDPOINT = '/api/vigicrues/zones';

/**
 * Construct the Vigicrues source.
 *
 * @param {object} [options]
 * @param {Function} [options.fetchImpl] - Injected fetch, for tests.
 * @returns {{getSnapshot: Function}}
 */
export function createVigicruesSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  /** One bounded, capped JSON read. */
  const readJson = async (url, signal) => {
    const response = await fetchImpl(url, { signal, cache: 'no-store' });
    let payload = null;
    try {
      payload = await response.json();
    } catch {
      // The status below stays authoritative.
    }
    signal?.throwIfAborted();
    if (!response.ok) {
      throw new Error(`Vigicrues HTTP ${response.status}`);
    }
    return payload;
  };

  return {
    async getSnapshot({ signal } = {}) {
      signal?.throwIfAborted();
      const [stationPayload, zonePayload] = await Promise.all([
        readJson(VIGICRUES_STATIONS_ENDPOINT, signal),
        readJson(VIGICRUES_ZONES_ENDPOINT, signal),
      ]);
      const stations = normalizeVigicruesStationPayload(stationPayload);
      if (!stations) throw new Error(msg('Malformed station response'));
      const zones = normalizeVigicruesZonePayload(zonePayload);
      if (!zones) throw new Error(msg('Malformed warning-zone response'));
      return { ...stations, ...zones };
    },
  };
}
