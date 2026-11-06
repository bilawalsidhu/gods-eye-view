/**
 * Shaded relief from Terrarium-encoded elevation tiles (Mapterhorn and the
 * like): each pixel's height is decoded, coloured by elevation class and lit
 * by a north-west sun, so a terrain-RGB tile reads as a map instead of as
 * noise. Pure: it takes and returns RGBA pixel arrays, so it runs in node
 * tests and in the browser alike.
 */
import { msg } from '../i18n/marker.js';

/**
 * Elevation classes, low to high: one orange ramp, light to dark (validated
 * as an ordinal ramp on the dark panel surface). `below` is the class's upper
 * bound in metres.
 */
export const RELIEF_CLASSES = Object.freeze([
  { below: 250, color: '#fee1d6', label: msg('Below 250 m') },
  { below: 500, color: '#ffbca3', label: msg('250–500 m') },
  { below: 1000, color: '#f6936f', label: msg('500–1,000 m') },
  { below: 2000, color: '#e46d40', label: msg('1,000–2,000 m') },
  { below: 3000, color: '#c24e1d', label: msg('2,000–3,000 m') },
  { below: Infinity, color: '#983709', label: msg('3,000 m and above') },
]);

const EARTH_CIRCUMFERENCE_M = 40075016.686;
// A north-west sun (azimuth 315°) in the mathematical angle hillshade uses.
const SUN_ANGLE = ((360 - 315 + 90) * Math.PI) / 180;
const SUN_ALTITUDE = (45 * Math.PI) / 180;

const hex = (value) =>
  [1, 3, 5].map((i) => parseInt(value.slice(i, i + 2), 16));
const CLASS_RGB = RELIEF_CLASSES.map(({ color }) => hex(color));

/** Height in metres of one Terrarium pixel. */
export function terrariumHeight(r, g, b) {
  return r * 256 + g + b / 256 - 32768;
}

/** Ground metres per pixel at a tile's centre latitude. */
export function metresPerPixel(level, y, tileSize) {
  const n = 2 ** level;
  const lat = Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 0.5)) / n)));
  return (EARTH_CIRCUMFERENCE_M * Math.cos(lat)) / (tileSize * n);
}

function classIndex(height) {
  for (let i = 0; i < RELIEF_CLASSES.length; i++)
    if (height < RELIEF_CLASSES[i].below) return i;
  return RELIEF_CLASSES.length - 1;
}

/**
 * Turn Terrarium RGBA pixels into shaded-relief RGBA pixels. Sea (encoded as
 * exactly 0 m) is transparent; land below sea level keeps the lowest class.
 * Slopes use Horn's method, clamping at the tile edge.
 * @param {Uint8ClampedArray} input Terrarium RGBA, width × height × 4.
 * @param {number} width
 * @param {number} height
 * @param {number} pixelMetres Ground size of one pixel.
 * @returns {Uint8ClampedArray}
 */
export function terrariumToRelief(input, width, height, pixelMetres) {
  const heights = new Float32Array(width * height);
  for (let i = 0, p = 0; p < heights.length; i += 4, p++)
    heights[p] = terrariumHeight(input[i], input[i + 1], input[i + 2]);
  const at = (x, y) =>
    heights[
      Math.min(height - 1, Math.max(0, y)) * width +
        Math.min(width - 1, Math.max(0, x))
    ];
  const out = new Uint8ClampedArray(width * height * 4);
  const spacing = Math.max(pixelMetres, 1e-3) * 8;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = y * width + x;
      const o = p * 4;
      const h = heights[p];
      if (h === 0) continue; // sea: leave transparent
      const dzdx =
        (at(x + 1, y - 1) +
          2 * at(x + 1, y) +
          at(x + 1, y + 1) -
          (at(x - 1, y - 1) + 2 * at(x - 1, y) + at(x - 1, y + 1))) /
        spacing;
      const dzdy =
        (at(x - 1, y + 1) +
          2 * at(x, y + 1) +
          at(x + 1, y + 1) -
          (at(x - 1, y - 1) + 2 * at(x, y - 1) + at(x + 1, y - 1))) /
        spacing;
      const slope = Math.atan(Math.hypot(dzdx, dzdy));
      const aspect = Math.atan2(dzdy, -dzdx);
      const shade = Math.max(
        0,
        Math.cos(SUN_ALTITUDE) * Math.cos(slope) +
          Math.sin(SUN_ALTITUDE) *
            Math.sin(slope) *
            Math.cos(SUN_ANGLE - aspect),
      );
      // Flat ground keeps its class colour; lit slopes brighten, shaded ones darken.
      const light = 0.55 + 0.6 * shade;
      const [r, g, b] = CLASS_RGB[classIndex(h)];
      out[o] = r * light;
      out[o + 1] = g * light;
      out[o + 2] = b * light;
      out[o + 3] = 255;
    }
  }
  return out;
}
