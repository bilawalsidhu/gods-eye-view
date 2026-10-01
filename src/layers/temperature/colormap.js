const ZERO_CELSIUS_K = 273.15;

/**
 * Parse NASA's published colour map into value-bearing stops.
 *
 * This is what makes a pixel readable: GIBS bakes the palette into the tile, and
 * this document says which value range produced each RGB triple. Reading a
 * pixel and looking its colour up here is therefore an exact reverse mapping,
 * not an estimate — verified against the live service on 2026-09-21, where
 * every sampled pixel matched a stop at colour distance 0.
 *
 * The first and last valued stops are catch-alls: the document gives them
 * `[0.02,200.00)` and `[350.02,652.00)`, which are not real measurement ranges
 * but "everything colder" and "everything hotter". They are flagged so a reader
 * is never told a pixel is −273 °C.
 * @param {string} xml Colour map document.
 * @returns {Array<{r:number, g:number, b:number, lowK:number, highK:number, clampLow:boolean, clampHigh:boolean}>} Stops.
 */
export function parseColormap(xml) {
  const stops = [];
  const pattern =
    /<ColorMapEntry\s+rgb="(\d+),(\d+),(\d+)"(?:\s+transparent="(true)")?(?:\s+value="\[([\d.]+),([\d.]+)\)")?/g;
  for (const match of String(xml || '').matchAll(pattern)) {
    const [, r, g, b, transparent, low, high] = match;
    if (transparent === 'true' || low === undefined) continue;
    stops.push({
      r: Number(r),
      g: Number(g),
      b: Number(b),
      lowK: Number(low),
      highK: Number(high),
      clampLow: false,
      clampHigh: false,
    });
  }
  if (stops.length) {
    stops[0].clampLow = true;
    stops[stops.length - 1].clampHigh = true;
  }
  return stops;
}

/**
 * The stop that produced a pixel.
 *
 * A fully transparent pixel is the product's fill value — cloud, water, or
 * outside the retrieval — and returns null rather than the nearest colour, so
 * a gap is never reported as a temperature.
 * @param {Array<object>} stops Parsed stops.
 * @param {{r:number, g:number, b:number, a:number}} pixel Sampled pixel.
 * @returns {?object} Matching stop, or null when there is no value.
 */
export function lookupStop(stops, { r, g, b, a }) {
  if (!Array.isArray(stops) || !stops.length) return null;
  if (!(a > 0)) return null;
  let best = null;
  let bestDistance = Infinity;
  for (const stop of stops) {
    const distance = (stop.r - r) ** 2 + (stop.g - g) ** 2 + (stop.b - b) ** 2;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = stop;
    }
  }
  return best ? { ...best, colorDistance: Math.sqrt(bestDistance) } : null;
}

/** @param {number} kelvin Absolute temperature. @returns {number} Degrees Celsius. */
export function kelvinToCelsius(kelvin) {
  return kelvin - ZERO_CELSIUS_K;
}

/**
 * Render a stop as the temperature text shown to the operator.
 *
 * A range, not a single number: the product quantises into 0.6 K buckets, so
 * one figure would be false precision. The catch-all ends read as bounds.
 * @param {?object} stop Matching stop, or null.
 * @returns {string} Display text.
 */
export function formatStop(stop) {
  if (!stop) return 'No clear-sky value';
  const low = kelvinToCelsius(stop.lowK);
  const high = kelvinToCelsius(stop.highK);
  if (stop.clampLow) return `≤ ${high.toFixed(1)} °C`;
  if (stop.clampHigh) return `≥ ${low.toFixed(1)} °C`;
  return `${low.toFixed(1)} to ${high.toFixed(1)} °C`;
}
