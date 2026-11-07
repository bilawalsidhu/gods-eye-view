/**
 * Renderer colours (`[r, g, b, a]`, 0..1) from the CSS-style colours layers
 * keep in their palettes.
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

const rgbChannel = (text) =>
  Number.parseFloat(text) / (text.endsWith('%') ? 100 : 255);

/**
 * A CSS colour (`#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`, `rgb()`, `rgba()`,
 * `hsl()`, `hsla()`) as a renderer colour, read as the default renderer
 * reads it; null for anything else (named colours included).
 */
export function cssColor(text) {
  const css = String(text ?? '').trim();
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
  const hue = (Number.parseFloat(m[1]) / 360) % 1;
  const saturation = Number.parseFloat(m[2]) / 100;
  const lightness = Number.parseFloat(m[3]) / 100;
  const alpha = Number.parseFloat(m[4] ?? '1.0');
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
