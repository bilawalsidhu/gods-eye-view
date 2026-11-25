/**
 * Draw order of the weather imagery through the globe port: scalar context
 * (wind), infrared, radar, then lightning, independent of enable order, and
 * above the port's other layers (zOrder 0).
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
  wind: 1,
  clouds: 2,
  'clouds-regional': 2,
  radar: 3,
  lightning: 4,
});
