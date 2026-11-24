import type { WeatherSettings } from './contract/globe';

/** All clear, no wind: what a renderer draws until weather is set. */
export const CLEAR_WEATHER: Readonly<WeatherSettings>;

/**
 * `current` with `patch` applied as `globe.weather.set` applies it, as a new
 * object: each strength given is clamped to 0..1, one not given is kept;
 * `wind` is taken whole.
 */
export function mergeWeather(
  current: WeatherSettings,
  patch?: Partial<WeatherSettings>,
): WeatherSettings;
