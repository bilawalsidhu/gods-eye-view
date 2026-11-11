// How the transit vehicles and the selected vehicle's trail draw
// (engine.movers sprite sets, engine.ground corridors).

import { SPRITE_LAYER_ORDER } from '../../../data/spriteOrder.js';

/** The stationary fleet and the vehicles mid-glide: one sprite set each. */
export const MARKER_SET_IDS = Object.freeze(['transit', 'transit-motion']);
/** Each set's place among the contact sprites (data/spriteOrder.js). */
export const markerOrder = (id) => SPRITE_LAYER_ORDER.indexOf(id);
/** A sprite's size at scale 1; a marker's width in CSS px sets its scale. */
export const SPRITE_SIZE_PX = 20;

/** The trail's colour before the selected vehicle styles it. */
export const TRAIL_DEFAULT_CSS = '#5EF08A';
/** The dark edge each trail lane is drawn over. */
export const TRAIL_BACKING_RGB = Object.freeze([0.02, 0.03, 0.05]);
export const TRAIL_BACKING_WIDTH_PX = 5;
export const TRAIL_WIDTH_PX = 3;
/** The live head's alpha, and the alpha where the scene hides the trail. */
export const TRAIL_HEAD_ALPHA = 0.8;
export const TRAIL_OCCLUDED_ALPHA = 0.55;

const ALPHA_STOPS = [
  [0, 0.8],
  [120000, 0.45],
  [600000, 0.2],
  [900000, 0.08],
];

/** A completed trail segment's alpha `ageMs` after the vehicle left it. */
export function trailAlpha(ageMs) {
  const stops = ALPHA_STOPS;
  for (let i = 1; i < stops.length; i++) {
    if (ageMs === stops[i][0]) return stops[i][1];
    if (ageMs < stops[i][0]) {
      const [a, x] = stops[i - 1],
        [b, y] = stops[i];
      return x + ((y - x) * Math.max(0, ageMs - a)) / (b - a);
    }
  }
  return 0.08;
}

// The completed trail draws in alpha bands: segments whose alpha rounds to
// the same band share one line per lane.
const BAND_MIN = 0.08;
const BAND_MAX = 0.8;
export const TRAIL_BANDS = 28;

/** The band of an alpha, 0 (oldest) to TRAIL_BANDS (newest). */
export const trailBand = (alpha) =>
  Math.round(
    ((Math.min(BAND_MAX, Math.max(BAND_MIN, alpha)) - BAND_MIN) /
      (BAND_MAX - BAND_MIN)) *
      TRAIL_BANDS,
  );

/** The alpha a band draws at. */
export const trailBandAlpha = (band) =>
  BAND_MIN + ((BAND_MAX - BAND_MIN) * band) / TRAIL_BANDS;
