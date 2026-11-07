// What the Directions display draws, as Cesium drew it: colours rgba in
// 0..1, sizes in CSS pixels.

import { rgbaFromCss } from '../../shared/color.js';

/** Route colour: the annotation palette's cyan, so voice routes and Directions match. */
export const DIRECTIONS_ROUTE_COLOR = '#39d0ff';

const rgba = (css, alpha) => {
  const { red, green, blue } = rgbaFromCss(css);
  return [red, green, blue, alpha];
};

// The route flow material (src/globe/cesium/annotations/worldAnnotationRenderer.js): the
// route colour at 0.95, 64 dash cells along the route, each lit for its
// first 46 % (brightened by 0.9 of its colour) and at 18 % alpha between,
// flowing toward the destination at 0.55 cells a second.
export const ROUTE_WIDTH_PX = 9;
export const ROUTE_COLOR = rgba(DIRECTIONS_ROUTE_COLOR, 0.95);
export const ROUTE_DASH = Object.freeze({
  cells: 64,
  duty: 0.46,
  speed: 0.55,
  gapAlpha: 0.18,
  emission: 0.9,
});

// Maneuver dots: white at 0.95 with a 2 px route-colour outline, 8 px, 13 px
// while selected.
export const STEP_COLOR = [1, 1, 1, 0.95];
export const STEP_OUTLINE_COLOR = rgba(DIRECTIONS_ROUTE_COLOR, 1);
export const STEP_OUTLINE_PX = 2;
export const STEP_PIXEL_SIZE = 8;
export const STEP_SELECTED_PIXEL_SIZE = 13;

// The A and B markers: a 14 px disc with a 2 px black outline, and its
// letter (bold 13 px monospace, white with a 3 px black outline) 20 px above.
export const MARKER_COLORS = Object.freeze({
  a: rgba('#5dff9f', 1),
  b: rgba('#ff6b6b', 1),
});
export const MARKER_PIXEL_SIZE = 14;
export const MARKER_OUTLINE_PX = 2;
export const MARKER_OUTLINE_COLOR = [0, 0, 0, 1];
export const MARKER_LETTER_FONT =
  'bold 13px "JetBrains Mono", "SF Mono", monospace';
export const MARKER_LETTER_OUTLINE_PX = 3;
export const MARKER_LETTER_OFFSET_PX = 20;
// The letter's sprite: a square this size centred on the marker, the glyph
// drawn MARKER_LETTER_OFFSET_PX above its centre.
export const MARKER_LETTER_SPRITE_PX = 64;

// Draw order among the display's mover sets: dots, marker discs, letters.
export const ORDER = Object.freeze({ steps: 0, markers: 1, letters: 2 });
