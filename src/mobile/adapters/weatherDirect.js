import { normalizeRegionalWeather } from '../../data/regionalModel.js';
import { WEATHER_PRODUCTS } from '../../layers/weather/source.js';
import { UPSTREAM_NOT_ALLOWED, isUpstreamRefusal } from '../sourcePolicy.js';

/**
 * Keyless on-device weather: Open-Meteo point forecasts plus honest
 * unavailability for the proxy's tile imagery (radar/clouds/lightning have
 * no keyless upstream, so the layer gets `{ unavailable: true }` instead of
 * doomed same-origin fetches).
 *
 * New parsing here is the Open-Meteo wrapper only; record normalization is
 * the shared `normalizeRegionalWeather` the regional brief already uses.
 *
 * @module mobile/adapters/weatherDirect
 */

/** Open-Meteo forecast root (registry family `weather`). */
export const OPEN_METEO_FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';

/** Current-block fields, matching the server's regional weather fetch. */
export const OPEN_METEO_CURRENT_FIELDS =
  'temperature_2m,apparent_temperature,precipitation,weather_code,' +
  'cloud_cover,wind_speed_10m,wind_direction_10m,visibility';

/**
 * Build the Open-Meteo current-conditions URL for a point.
 * @param {number} latitude Degrees, [-90, 90].
 * @param {number} longitude Degrees, [-180, 180].
 * @returns {string} Forecast URL.
 */
export function openMeteoCurrentUrl(latitude, longitude) {
  if (
    !Number.isFinite(latitude) ||
    latitude < -90 ||
    latitude > 90 ||
    !Number.isFinite(longitude) ||
    longitude < -180 ||
    longitude > 180
  ) {
    throw new TypeError('Valid latitude/longitude are required');
  }
  const params = new URLSearchParams({
    latitude: String(latitude),
    longitude: String(longitude),
    current: OPEN_METEO_CURRENT_FIELDS,
    timezone: 'UTC',
  });
  return `${OPEN_METEO_FORECAST_URL}?${params}`;
}

/**
 * Create the keyless on-device weather source.
 * @param {{ fetchImpl?: Function }} options Caller-owned transport.
 * @returns {{ getCurrent: Function, getSnapshot: Function, getImage: Function }}
 *   Point forecasts plus layer-compatible imagery unavailability.
 */
export function createWeatherDirectSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  return {
    /**
     * Read current conditions for one point via Open-Meteo.
     * @param {{ latitude: number, longitude: number, signal?: AbortSignal }} point Query point.
     * @returns {Promise<object>} Normalized regional weather record, or
     *   `{ unavailable: 'UPSTREAM_NOT_ALLOWED' }` on registry refusal.
     */
    async getCurrent({ latitude, longitude, signal } = {}) {
      const url = openMeteoCurrentUrl(latitude, longitude);
      signal?.throwIfAborted();
      let response;
      try {
        response = await fetchImpl(url, {
          signal,
          headers: { Accept: 'application/json' },
        });
      } catch (error) {
        if (isUpstreamRefusal(error)) {
          return { unavailable: UPSTREAM_NOT_ALLOWED };
        }
        throw error;
      }
      signal?.throwIfAborted();
      if (!response.ok) throw new Error(`Weather HTTP ${response.status}`);
      const record = normalizeRegionalWeather(await response.json());
      signal?.throwIfAborted();
      if (!record) throw new Error('Invalid weather payload');
      return record;
    },
    /**
     * Answer the weather layer with honest unavailability: tile imagery has
     * no keyless upstream on-device.
     * @param {{ product?: string }} options Layer product.
     * @returns {Promise<object>} Unavailable-marked snapshot (no fetch).
     */
    async getSnapshot({ product = 'radar' } = {}) {
      if (!WEATHER_PRODUCTS.includes(product)) {
        throw new Error('Unknown weather product');
      }
      return {
        schemaVersion: 1,
        product,
        unavailable: true,
        reason: 'Tile imagery needs the application backend on this device',
      };
    },
    /**
     * Never fetch imagery frames on-device; fail fast instead of timing out.
     * @returns {Promise<never>} Always rejects with `unavailable` attached.
     */
    async getImage({ signal } = {}) {
      signal?.throwIfAborted();
      throw Object.assign(
        new Error('Weather imagery needs the application backend'),
        { unavailable: 'NO_DIRECT_UPSTREAM' },
      );
    },
  };
}
