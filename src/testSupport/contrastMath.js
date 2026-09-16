// src/testSupport/contrastMath.js
//
// WCAG 2.1 contrast math shared by the style audits (uiContrast.test.mjs,
// styleContrastAudit.test.mjs). Pure functions — no test registration, so
// importing this module never runs another file's tests.

/**
 * sRGB 8-bit channel → linear-light value (WCAG 2.1 §1.3.5).
 * @param {number} channel - 8-bit sRGB channel intensity, 0-255.
 * @returns {number} Linear-light intensity in the 0-1 range.
 */
export function linearize(channel) {
  const s = channel / 255;
  return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

/**
 * WCAG relative luminance of an [r, g, b] 8-bit triple.
 * @param {number[]} root0 - sRGB color as an [r, g, b] triple of 8-bit channels.
 * @param {number} root0.0 - Red channel, 0-255.
 * @param {number} root0.1 - Green channel, 0-255.
 * @param {number} root0.2 - Blue channel, 0-255.
 * @returns {number} Relative luminance in the 0-1 range.
 */
export function luminance([r, g, b]) {
  return 0.2126 * linearize(r) + 0.7152 * linearize(g) + 0.0722 * linearize(b);
}

/**
 * WCAG contrast ratio between two colors, ≥ 1.
 * @param {number[]} a - First sRGB [r, g, b] triple of 8-bit channels.
 * @param {number[]} b - Second sRGB [r, g, b] triple of 8-bit channels.
 * @returns {number} Luminance contrast ratio, at least 1 and at most 21.
 */
export function contrastRatio(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Alpha-composite an [r,g,b,a?] foreground over an opaque background triple.
 * @param {number[]} fg - Foreground sRGB triple, optionally extended with a
 *   0-1 alpha as a fourth element.
 * @param {number[]} bg - Opaque background sRGB triple of 8-bit channels.
 * @returns {number[]} Composited opaque sRGB triple of 8-bit channels.
 */
export function composite(fg, bg) {
  if (fg.length === 3) return fg;
  const [r, g, b, a] = fg;
  return [
    r * a + bg[0] * (1 - a),
    g * a + bg[1] * (1 - a),
    b * a + bg[2] * (1 - a),
  ];
}
