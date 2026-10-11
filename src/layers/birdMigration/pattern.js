import { PATTERN_DBZ } from './model.js';
import { isScanTime } from './wire.js';

// IEM's composite_n0q palette from 5 to 35 dBZ in 0.5 dBZ steps. Tiles are
// nearest-neighbour, so every echo pixel is an exact palette color.
const N0Q_RAMP =
  '6376a8 5f73a7 5b70a6 576da4 4f67a2 4b64a1 4761a0 435e9f 415b9e 4361a2 ' +
  '4568a6 486faa 4a76ae 4d7db2 4f84b6 518bbb 5699c3 599fc7 5ba6cb 5eadcf ' +
  '60b4d4 62bbd8 65c2dc 67c9e0 6ad0e4 6fd6e8 68d6d7 59d6b3 52d6a2 4bd690 ' +
  '43d67e 3cd66d 35d65b 11d518 11d117 10cd17 10c816 10c416 0fbc15 0fb714 ' +
  '0eb314 0eaf13 0eab13 0da612 0da212 0d9e11 0c9911 0c9510 0c9110 0b880f ' +
  '0b840e 0a800e 0a7c0d 0a770d 09730c 096f0c 096b0b 08660b 08620a 095e09 ' +
  '327308';
const TEAL = [38, 166, 154];
const RAMP_STEPS = (PATTERN_DBZ.max - PATTERN_DBZ.min) * 2;
const PAINT = new Map(
  N0Q_RAMP.split(' ').map((hex, step) => {
    const t = step / RAMP_STEPS;
    return [
      parseInt(hex, 16),
      [
        ...TEAL.map((channel) => Math.round(channel + (255 - channel) * t)),
        Math.round((0.25 + 0.45 * t) * 255),
      ],
    ];
  }),
);

/** Ramp stops for the legend, low to high. */
export const PATTERN_LEGEND = Object.freeze(
  [0, 0.5, 1].map((t) => {
    const [r, g, b] = TEAL.map((c) => Math.round(c + (255 - c) * t));
    return Object.freeze({
      label: String(PATTERN_DBZ.min + (PATTERN_DBZ.max - PATTERN_DBZ.min) * t),
      color: `rgb(${r}, ${g}, ${b})`,
    });
  }),
);

/** Fixed IEM template; never a host from the manifest. */
export function compositeTileTemplate(time) {
  if (!isScanTime(time)) throw new TypeError('Invalid composite scan time');
  const stamp = time.slice(0, 16).replace(/[-T:]/g, '');
  return `https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0/ridge::USCOMP-N0Q-${stamp}/{z}/{x}/{y}.png`;
}

/** Repaint N0Q pixels inside PATTERN_DBZ into the migration ramp, in place; the rest become transparent. */
export function recolorPattern(rgba) {
  for (let i = 0; i < rgba.length; i += 4) {
    const paint =
      rgba[i + 3] === 255 &&
      PAINT.get((rgba[i] << 16) | (rgba[i + 1] << 8) | rgba[i + 2]);
    if (paint) rgba.set(paint, i);
    else rgba[i + 3] = 0;
  }
  return rgba;
}
