/**
 * Draw order of the weather imagery through the globe port: scalar context
 * (an air-quality model field, its Europe inset over it, then wind),
 * infrared, radar, then lightning, independent of enable order, and above
 * the port's other layers (zOrder 0) and Active Fires' heat (0.5,
 * `HEAT_IMAGERY_Z`).
 */
/** What each product's imagery shows (the imagery's `shows`): both cloud products are clouds. */
export const WEATHER_IMAGERY_SHOWS = Object.freeze({
  wind: 'wind',
  clouds: 'clouds',
  'clouds-regional': 'clouds',
  radar: 'radar',
  lightning: 'lightning',
});

export const WEATHER_IMAGERY_Z = Object.freeze({
  'air-quality': 0.75,
  'air-quality-inset': 0.8,
  wind: 1,
  clouds: 2,
  'clouds-regional': 2,
  radar: 3,
  lightning: 4,
});
