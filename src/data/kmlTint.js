// The colour rules a KML style's `<color>` obeys, wherever a KML is drawn.
//
// WHY THIS IS SHARED: two places read a KML's colours. The Ghost Maps layer
// reads the colour out of a style it parses itself; the import feature hands
// the document to Cesium's own KML loader, which tints a placemark's icon
// with whatever colour the style carries. Both need the same three rules:
//
//   1. a KML colour is `aabbggrr`, not `rrggbbaa` (see `kmlColor`);
//   2. the black an ArcGIS export writes into its styles (`ff000000`, and
//      `00000000` beside it) is a PLACEHOLDER, not a colour to draw with:
//      a marker tinted with it is black, and a black marker on a dark globe
//      cannot be seen (see `isNeutralTint`);
//   3. a colour too faint to see must not erase a marker: its alpha has a
//      floor (see `MARKER_TINT_ALPHA_FLOOR`).
//
// The rules live here so the next caller cannot get them wrong.

/**
 * KML `aabbggrr` to `[r, g, b, a]` in 0..1, or null.
 * @param {string} text
 * @returns {?number[]}
 */
export function kmlColor(text) {
  const hex = String(text ?? '')
    .trim()
    .replace(/^#/, '');
  if (!/^[0-9a-f]{8}$/i.test(hex)) return null;
  const byte = (at) => parseInt(hex.slice(at, at + 2), 16) / 255;
  return [byte(6), byte(4), byte(2), byte(0)];
}

/**
 * Whether a KML colour says nothing about the marker's colour.
 *
 * An ArcGIS export writes `ff000000` (opaque black) and `00000000`
 * (transparent black) into the styles it emits. They are placeholders, not
 * choices: a marker tinted with either is BLACK, and a black marker on a dark
 * globe cannot be seen. A near-white colour is the other placeholder (the
 * plain white sprite these symbols replaced was tinted, so a white tint left
 * the texture as it was drawn).
 *
 * @param {?number[]} rgba A KML colour as `[r, g, b, a]` in 0..1, or null.
 * @returns {boolean} True when the colour carries no information.
 */
export function isNeutralTint(rgba) {
  if (!Array.isArray(rgba) || rgba.length < 3) return true;
  const [r, g, b] = rgba;
  // The ArcGIS placeholder: opaque black.
  if (r < 0.05 && g < 0.05 && b < 0.05) return true;
  // The old plain-white sprite, kept for a KML that says white.
  return r > 0.95 && g > 0.95 && b > 0.95;
}

/**
 * The smallest alpha a tint may have and still show the symbol underneath.
 * A KML colour may be almost transparent (`40xxxxxx` is a quarter opaque);
 * multiplied into the texture that fades the symbol away, and an alpha of
 * zero erases it. The floor keeps every marker readable.
 */
export const MARKER_TINT_ALPHA_FLOOR = 0.35;

/**
 * The alpha a tint may have: the one the KML asked for, lifted to the floor
 * so that no colour can hide a marker, and never above fully opaque.
 * @param {?number} alpha The alpha the KML asked for, in 0..1.
 * @returns {number} The alpha to draw with.
 */
export function markerTintAlpha(alpha) {
  // No alpha at all means fully opaque, not fully transparent.
  if (alpha === null || alpha === undefined) return 1;
  const usable = Number.isFinite(Number(alpha)) ? Number(alpha) : 1;
  return Math.max(MARKER_TINT_ALPHA_FLOOR, Math.min(1, usable));
}

/**
 * A KML colour as `[r, g, b, a]` in 0..1, written back as `aabbggrr`.
 * @param {?number[]} rgba The colour, or null.
 * @returns {?string} The KML colour, or null for no colour.
 */
export function formatKmlColor(rgba) {
  if (!Array.isArray(rgba) || rgba.length < 4) return null;
  const byte = (value) =>
    Math.round(Math.max(0, Math.min(1, Number(value) || 0)) * 255)
      .toString(16)
      .padStart(2, '0');
  // KML writes `aabbggrr`.
  return `${byte(rgba[3])}${byte(rgba[2])}${byte(rgba[1])}${byte(rgba[0])}`;
}

/**
 * The tint an icon is drawn with, as a KML `aabbggrr` string, or null when
 * the icon must be drawn untinted.
 *
 * A placeholder colour (see `isNeutralTint`) tints nothing: the artwork a
 * file packs shows as it was drawn, and a marker with no artwork of its own
 * keeps the colour it already has. A colour that says something tints as it
 * asks, with the alpha lifted to the floor so it cannot hide the marker.
 *
 * @param {?string} text The `<color>` value as the KML wrote it.
 * @returns {?string} A KML colour, or null for no tint.
 */
export function kmlTintColor(text) {
  const rgba = kmlColor(text);
  if (!rgba || isNeutralTint(rgba)) return null;
  return formatKmlColor([rgba[0], rgba[1], rgba[2], markerTintAlpha(rgba[3])]);
}
