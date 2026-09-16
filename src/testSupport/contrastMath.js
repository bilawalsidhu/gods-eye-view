// src/testSupport/contrastMath.js
//
// WCAG 2.1 contrast math shared by the style audits (uiContrast.test.mjs,
// styleContrastAudit.test.mjs). Pure functions — no test registration, so
// importing this module never runs another file's tests.

/** sRGB 8-bit channel → linear-light value (WCAG 2.1 §1.3.5). */
export function linearize(channel) {
  const s = channel / 255;
  return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

/** WCAG relative luminance of an [r, g, b] 8-bit triple. */
export function luminance([r, g, b]) {
  return 0.2126 * linearize(r) + 0.7152 * linearize(g) + 0.0722 * linearize(b);
}

/** WCAG contrast ratio between two colors, ≥ 1. */
export function contrastRatio(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** Alpha-composite an [r,g,b,a?] foreground over an opaque background triple. */
export function composite(fg, bg) {
  if (fg.length === 3) return fg;
  const [r, g, b, a] = fg;
  return [
    r * a + bg[0] * (1 - a),
    g * a + bg[1] * (1 - a),
    b * a + bg[2] * (1 - a),
  ];
}
