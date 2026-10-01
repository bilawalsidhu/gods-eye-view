/**
 * Representative stops from NASA's published colour map for this product,
 * fetched from
 * `https://gibs.earthdata.nasa.gov/colormaps/v1.0/MODIS_Land_Surface_Temp.xml`
 * (the colour map the layer's WMTS capabilities entry points at) and sampled on
 * 2026-09-21.
 *
 * The full map has 252 stops from 200 K to 350 K, which is far more than a row
 * legend can show, so these are the nearest published stop to each round value.
 * The colours are NASA's, read off that document rather than approximated —
 * a legend whose swatches do not match the tiles is worse than no legend.
 *
 * `units="K"` in the source document; the labels are Celsius because that is
 * what the operator reads, and the conversion is exact.
 */
export const TEMPERATURE_STOPS = Object.freeze([
  Object.freeze({ kelvin: 200, color: 'rgb(197,0,255)' }),
  Object.freeze({ kelvin: 225, color: 'rgb(29,0,255)' }),
  Object.freeze({ kelvin: 250, color: 'rgb(0,179,255)' }),
  Object.freeze({ kelvin: 273.15, color: 'rgb(91,255,43)' }),
  Object.freeze({ kelvin: 290, color: 'rgb(197,255,0)' }),
  Object.freeze({ kelvin: 310, color: 'rgb(255,205,0)' }),
  Object.freeze({ kelvin: 330, color: 'rgb(255,100,0)' }),
  Object.freeze({ kelvin: 350, color: 'rgb(255,1,0)' }),
]);

const ZERO_CELSIUS_K = 273.15;

/** @param {number} kelvin Absolute temperature. @returns {number} Degrees Celsius. */
export function kelvinToCelsius(kelvin) {
  return kelvin - ZERO_CELSIUS_K;
}

const SCALE_MIN_K = TEMPERATURE_STOPS[0].kelvin;
const SCALE_MAX_K = TEMPERATURE_STOPS.at(-1).kelvin;

/** Round Celsius values labelled under the scale. */
const SCALE_LABELS_C = [-60, -30, 0, 30, 60];

/**
 * Where a temperature sits along the scale.
 * @param {number} kelvin Absolute temperature.
 * @returns {number} 0 at the coldest published stop, 1 at the hottest; clamped.
 */
export function scalePosition(kelvin) {
  const at = (kelvin - SCALE_MIN_K) / (SCALE_MAX_K - SCALE_MIN_K);
  return Math.min(1, Math.max(0, at));
}

/**
 * The colour scale as one continuous CSS gradient.
 *
 * Each published stop sits at its own temperature rather than evenly spaced,
 * so a label placed by temperature lands on the colour the tiles use for it.
 * @returns {string} CSS `linear-gradient`.
 */
export function scaleGradient() {
  const stops = TEMPERATURE_STOPS.map(
    (stop) => `${stop.color} ${(scalePosition(stop.kelvin) * 100).toFixed(2)}%`,
  );
  return `linear-gradient(90deg, ${stops.join(', ')})`;
}

/** @returns {Array<{label:string, position:number}>} Tick labels, positioned by temperature. */
export function scaleTicks() {
  return SCALE_LABELS_C.map((celsius) => ({
    label: `${celsius < 0 ? '−' : ''}${Math.abs(celsius)}°`,
    position: scalePosition(celsius + ZERO_CELSIUS_K),
  }));
}

/**
 * Where a sampled reading belongs on the scale, in its published colour.
 *
 * A reading is a 0.6 K bucket, so it sits at the bucket's middle; the clamped
 * end buckets sit at the bound they name.
 * @param {?object} stop Colour-map stop of a measured sample.
 * @returns {?{position:number, color:string}} Marker, or null without a reading.
 */
export function scaleReading(stop) {
  if (!stop) return null;
  const kelvin = stop.clampLow
    ? stop.highK
    : stop.clampHigh
      ? stop.lowK
      : (stop.lowK + stop.highK) / 2;
  return {
    position: scalePosition(kelvin),
    color: `rgb(${stop.r},${stop.g},${stop.b})`,
  };
}
