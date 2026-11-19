/**
 * The weather a renderer draws (`globe.weather`, the `weather` capability):
 * clear at first, and how a `set` merges into what was set. Shared by every
 * renderer that lists `weather`, so they keep and clamp it alike.
 */

/** @type {Readonly<import('./contract/globe').WeatherSettings>} */
export const CLEAR_WEATHER = Object.freeze({
  clouds: 0,
  fog: 0,
  haze: 0,
  rain: 0,
  snow: 0,
  wind: Object.freeze({ speedMps: 0, fromDeg: 0 }),
});

const STRENGTHS = ['clouds', 'fog', 'haze', 'rain', 'snow'];

const unit = (value, fallback) =>
  Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : fallback;

/**
 * `current` with `patch` applied: each strength given is clamped to 0..1,
 * one not given (or not a number) is kept; `wind` is taken whole, its speed
 * at least 0 and its direction in [0, 360).
 * @param {import('./contract/globe').WeatherSettings} current
 * @param {Partial<import('./contract/globe').WeatherSettings>} [patch]
 * @returns {import('./contract/globe').WeatherSettings}
 */
export function mergeWeather(current, patch = {}) {
  const next = { ...current, wind: { ...current.wind } };
  for (const key of STRENGTHS) next[key] = unit(patch[key], current[key]);
  if (patch.wind) {
    const speed = Number(patch.wind.speedMps);
    const from = Number(patch.wind.fromDeg);
    next.wind = {
      speedMps: Number.isFinite(speed) ? Math.max(0, speed) : 0,
      fromDeg: Number.isFinite(from) ? ((from % 360) + 360) % 360 : 0,
    };
  }
  return next;
}
