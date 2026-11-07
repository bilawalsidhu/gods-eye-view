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
