// Shared policy for the camera-local weather-effects endpoint
// (`/api/weather-effects`). Worker-safe and middleware-free so the dev
// middleware (`vite/proxies/regional.js`) and the Pages Function
// (`functions/api/weather-effects.js`) cannot drift: same validation, same
// 0.1° cache-key quantization, same upstream URL, same payload shape.
import { requiredFiniteQueryNumber } from './overpassPolicy.js';

/** Fresh-observation TTL (ms) before a point is re-fetched. */
export const WEATHER_EFFECTS_CACHE_MS = 5 * 60_000;

/** How long a last-good observation may still be served when refresh fails. */
export const WEATHER_EFFECTS_STALE_MS = 30 * 60_000;

/** Memory-cache ceiling (oldest evicted, Map insertion order). */
export const WEATHER_EFFECTS_MAX_CACHE = 180;

/** Hard cap on the Open-Meteo response we will buffer. */
export const WEATHER_EFFECTS_MAX_RESPONSE_BYTES = 512 * 1024;

/** The exact Open-Meteo `current` field set the effects renderer consumes. */
const WEATHER_EFFECTS_FIELDS =
  'temperature_2m,apparent_temperature,precipitation,weather_code,cloud_cover,wind_speed_10m,wind_direction_10m,visibility';

/**
 * Validate `latitude`/`longitude` query params into a finite, in-range point.
 * @param {URLSearchParams} params
 * @returns {{latitude: number, longitude: number}|null}
 */
export function validRegionalPoint(params) {
  const latitude = requiredFiniteQueryNumber(params, 'latitude');
  const longitude = requiredFiniteQueryNumber(params, 'longitude');
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return null;
  return { latitude, longitude };
}

/**
 * Cache key for a point: quantized to 0.1° so camera drift reuses the same
 * observation instead of hammering Open-Meteo per meter of movement. Shared
 * by the regional-brief middleware (same quantization) and this endpoint.
 * @param {{latitude: number, longitude: number}} point
 */
export function regionalPointCacheKey(point) {
  const lat = (Math.round(point.latitude * 10) / 10).toFixed(1);
  const lon = (Math.round(point.longitude * 10) / 10).toFixed(1);
  return `${lat},${lon}`;
}

/** The exact upstream URL both runtimes fetch. */
export function buildOpenMeteoWeatherUrl(point) {
  const params = new URLSearchParams({
    latitude: point.latitude.toFixed(5),
    longitude: point.longitude.toFixed(5),
    current: WEATHER_EFFECTS_FIELDS,
    timezone: 'UTC',
  });
  return `https://api.open-meteo.com/v1/forecast?${params}`;
}

/**
 * Shape a normalized observation into the client payload contract.
 * @param {{latitude: number, longitude: number}} point
 * @param {object} weather normalizeRegionalWeather() output
 * @param {string} retrievedAt ISO timestamp supplied by the runtime
 */
export function buildWeatherEffectsPayload(point, weather, retrievedAt) {
  return {
    status: 'ready',
    retrievedAt,
    coordinates: point,
    weather,
  };
}
