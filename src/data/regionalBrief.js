import { applicationServices } from '../services/application.js';
export * from './regionalModel.js';
/** Fetch a bounded regional brief through the same-origin dev/preview proxy. */
export async function fetchRegionalBrief(latitude, longitude, { signal } = {}) {
  if (![latitude, longitude].every(Number.isFinite))
    throw new Error('Valid coordinates are required');
  return applicationServices.regional.getBrief(latitude, longitude, { signal });
}

/**
 * Fetch a spot's current weather alone, `{weather}`, as the regional brief
 * has it (the same normalized observation, with the spot's time zone),
 * without the brief's reverse geocode and news search.
 */
export async function fetchSpotWeather(latitude, longitude, options) {
  if (![latitude, longitude].every(Number.isFinite))
    throw new Error('Valid coordinates are required');
  return applicationServices.weather.getConditions(
    latitude,
    longitude,
    options,
  );
}
