/**
 * Renderer colours (`[r, g, b, a]`, 0..1) from the CSS-style colours layers
 * keep in their palettes, and from hue, saturation and lightness.
 */

/** A `#rrggbb` colour at `alpha`, as a renderer colour. */
export function hexColor(hex, alpha = 1) {
  const n = Number.parseInt(hex.slice(1), 16);
  return [
    ((n >> 16) & 255) / 255,
    ((n >> 8) & 255) / 255,
    (n & 255) / 255,
    alpha,
  ];
}

// The default renderer's own patterns, so a colour reads as it read there.
const SHORT_HEX = /^#([0-9a-f])([0-9a-f])([0-9a-f])([0-9a-f])?$/i;
const LONG_HEX = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})?$/i;
const RGB =
  /^rgba?\s*\(\s*([0-9.]+%?)\s*[,\s]+\s*([0-9.]+%?)\s*[,\s]+\s*([0-9.]+%?)(?:\s*[,\s/]+\s*([0-9.]+))?\s*\)$/i;
const HSL =
  /^hsla?\s*\(\s*([0-9.]+)\s*[,\s]+\s*([0-9.]+%)\s*[,\s]+\s*([0-9.]+%)(?:\s*[,\s/]+\s*([0-9.]+))?\s*\)$/i;

function hueToRgb(m1, m2, h) {
  if (h < 0) h += 1;
  if (h > 1) h -= 1;
  if (h * 6 < 1) return m1 + (m2 - m1) * 6 * h;
  if (h * 2 < 1) return m2;
  if (h * 3 < 2) return m1 + (m2 - m1) * (2 / 3 - h) * 6;
  return m1;
}

/**
 * The CSS colour names the default renderer knows, upper-cased, as `rrggbb`
 * (`transparent` aside). It has no `rebeccapurple`, and spells
 * `lavenderblush` `lavendar_blush`.
 */
const NAMED = Object.freeze({
  ALICEBLUE: 'f0f8ff',
  ANTIQUEWHITE: 'faebd7',
  AQUA: '00ffff',
  AQUAMARINE: '7fffd4',
  AZURE: 'f0ffff',
  BEIGE: 'f5f5dc',
  BISQUE: 'ffe4c4',
  BLACK: '000000',
  BLANCHEDALMOND: 'ffebcd',
  BLUE: '0000ff',
  BLUEVIOLET: '8a2be2',
  BROWN: 'a52a2a',
  BURLYWOOD: 'deb887',
  CADETBLUE: '5f9ea0',
  CHARTREUSE: '7fff00',
  CHOCOLATE: 'd2691e',
  CORAL: 'ff7f50',
  CORNFLOWERBLUE: '6495ed',
  CORNSILK: 'fff8dc',
  CRIMSON: 'dc143c',
  CYAN: '00ffff',
  DARKBLUE: '00008b',
  DARKCYAN: '008b8b',
  DARKGOLDENROD: 'b8860b',
  DARKGRAY: 'a9a9a9',
  DARKGREEN: '006400',
  DARKGREY: 'a9a9a9',
  DARKKHAKI: 'bdb76b',
  DARKMAGENTA: '8b008b',
  DARKOLIVEGREEN: '556b2f',
  DARKORANGE: 'ff8c00',
  DARKORCHID: '9932cc',
  DARKRED: '8b0000',
  DARKSALMON: 'e9967a',
  DARKSEAGREEN: '8fbc8f',
  DARKSLATEBLUE: '483d8b',
  DARKSLATEGRAY: '2f4f4f',
  DARKSLATEGREY: '2f4f4f',
  DARKTURQUOISE: '00ced1',
  DARKVIOLET: '9400d3',
  DEEPPINK: 'ff1493',
  DEEPSKYBLUE: '00bfff',
  DIMGRAY: '696969',
  DIMGREY: '696969',
  DODGERBLUE: '1e90ff',
  FIREBRICK: 'b22222',
  FLORALWHITE: 'fffaf0',
  FORESTGREEN: '228b22',
  FUCHSIA: 'ff00ff',
  GAINSBORO: 'dcdcdc',
  GHOSTWHITE: 'f8f8ff',
  GOLD: 'ffd700',
  GOLDENROD: 'daa520',
  GRAY: '808080',
  GREEN: '008000',
  GREENYELLOW: 'adff2f',
  GREY: '808080',
  HONEYDEW: 'f0fff0',
  HOTPINK: 'ff69b4',
  INDIANRED: 'cd5c5c',
  INDIGO: '4b0082',
  IVORY: 'fffff0',
  KHAKI: 'f0e68c',
  LAVENDER: 'e6e6fa',
  LAVENDAR_BLUSH: 'fff0f5',
  LAWNGREEN: '7cfc00',
  LEMONCHIFFON: 'fffacd',
  LIGHTBLUE: 'add8e6',
  LIGHTCORAL: 'f08080',
  LIGHTCYAN: 'e0ffff',
  LIGHTGOLDENRODYELLOW: 'fafad2',
  LIGHTGRAY: 'd3d3d3',
  LIGHTGREEN: '90ee90',
  LIGHTGREY: 'd3d3d3',
  LIGHTPINK: 'ffb6c1',
  LIGHTSEAGREEN: '20b2aa',
  LIGHTSKYBLUE: '87cefa',
  LIGHTSLATEGRAY: '778899',
  LIGHTSLATEGREY: '778899',
  LIGHTSTEELBLUE: 'b0c4de',
  LIGHTYELLOW: 'ffffe0',
  LIME: '00ff00',
  LIMEGREEN: '32cd32',
  LINEN: 'faf0e6',
  MAGENTA: 'ff00ff',
  MAROON: '800000',
  MEDIUMAQUAMARINE: '66cdaa',
  MEDIUMBLUE: '0000cd',
  MEDIUMORCHID: 'ba55d3',
  MEDIUMPURPLE: '9370db',
  MEDIUMSEAGREEN: '3cb371',
  MEDIUMSLATEBLUE: '7b68ee',
  MEDIUMSPRINGGREEN: '00fa9a',
  MEDIUMTURQUOISE: '48d1cc',
  MEDIUMVIOLETRED: 'c71585',
  MIDNIGHTBLUE: '191970',
  MINTCREAM: 'f5fffa',
  MISTYROSE: 'ffe4e1',
  MOCCASIN: 'ffe4b5',
  NAVAJOWHITE: 'ffdead',
  NAVY: '000080',
  OLDLACE: 'fdf5e6',
  OLIVE: '808000',
  OLIVEDRAB: '6b8e23',
  ORANGE: 'ffa500',
  ORANGERED: 'ff4500',
  ORCHID: 'da70d6',
  PALEGOLDENROD: 'eee8aa',
  PALEGREEN: '98fb98',
  PALETURQUOISE: 'afeeee',
  PALEVIOLETRED: 'db7093',
  PAPAYAWHIP: 'ffefd5',
  PEACHPUFF: 'ffdab9',
  PERU: 'cd853f',
  PINK: 'ffc0cb',
  PLUM: 'dda0dd',
  POWDERBLUE: 'b0e0e6',
  PURPLE: '800080',
  RED: 'ff0000',
  ROSYBROWN: 'bc8f8f',
  ROYALBLUE: '4169e1',
  SADDLEBROWN: '8b4513',
  SALMON: 'fa8072',
  SANDYBROWN: 'f4a460',
  SEAGREEN: '2e8b57',
  SEASHELL: 'fff5ee',
  SIENNA: 'a0522d',
  SILVER: 'c0c0c0',
  SKYBLUE: '87ceeb',
  SLATEBLUE: '6a5acd',
  SLATEGRAY: '708090',
  SLATEGREY: '708090',
  SNOW: 'fffafa',
  SPRINGGREEN: '00ff7f',
  STEELBLUE: '4682b4',
  TAN: 'd2b48c',
  TEAL: '008080',
  THISTLE: 'd8bfd8',
  TOMATO: 'ff6347',
  TURQUOISE: '40e0d0',
  VIOLET: 'ee82ee',
  WHEAT: 'f5deb3',
  WHITE: 'ffffff',
  WHITESMOKE: 'f5f5f5',
  YELLOW: 'ffff00',
  YELLOWGREEN: '9acd32',
});

const rgbChannel = (text) =>
  Number.parseFloat(text) / (text.endsWith('%') ? 100 : 255);

/**
 * A CSS colour (a name the default renderer knows, in any case, `#rgb`,
 * `#rgba`, `#rrggbb`, `#rrggbbaa`, `rgb()`, `rgba()`, `hsl()`, `hsla()`) as
 * a renderer colour, read as the default renderer reads it; null for
 * anything else.
 */
export function cssColor(text) {
  const css = String(text ?? '').trim();
  // Upper-cased, as the default renderer looks its names up.
  const name = css.toUpperCase();
  if (name === 'TRANSPARENT') return [0, 0, 0, 0];
  if (Object.hasOwn(NAMED, name)) return hexColor(`#${NAMED[name]}`);
  let m = SHORT_HEX.exec(css);
  if (m)
    return [
      Number.parseInt(m[1], 16) / 15,
      Number.parseInt(m[2], 16) / 15,
      Number.parseInt(m[3], 16) / 15,
      Number.parseInt(m[4] ?? 'f', 16) / 15,
    ];
  m = LONG_HEX.exec(css);
  if (m)
    return [
      Number.parseInt(m[1], 16) / 255,
      Number.parseInt(m[2], 16) / 255,
      Number.parseInt(m[3], 16) / 255,
      Number.parseInt(m[4] ?? 'ff', 16) / 255,
    ];
  m = RGB.exec(css);
  if (m)
    return [
      rgbChannel(m[1]),
      rgbChannel(m[2]),
      rgbChannel(m[3]),
      Number.parseFloat(m[4] ?? '1.0'),
    ];
  m = HSL.exec(css);
  if (!m) return null;
  return hslColor(
    Number.parseFloat(m[1]) / 360,
    Number.parseFloat(m[2]) / 100,
    Number.parseFloat(m[3]) / 100,
    Number.parseFloat(m[4] ?? '1.0'),
  );
}

/**
 * A hue, saturation and lightness colour (each 0..1; the hue wraps) as a
 * renderer colour, computed as the default renderer computes it.
 */
export function hslColor(hue, saturation, lightness, alpha = 1) {
  hue %= 1;
  if (saturation === 0) return [lightness, lightness, lightness, alpha];
  const m2 =
    lightness < 0.5
      ? lightness * (1 + saturation)
      : lightness + saturation - lightness * saturation;
  const m1 = 2 * lightness - m2;
  return [
    hueToRgb(m1, m2, hue + 1 / 3),
    hueToRgb(m1, m2, hue),
    hueToRgb(m1, m2, hue - 1 / 3),
    alpha,
  ];
}
