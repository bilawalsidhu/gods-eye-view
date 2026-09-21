export const LAYER_ID = 'water-quality';

export const REQUEST_DEBOUNCE_MS = 500;

/**
 * Two degrees, not the ten the Overpass-backed layers use. Measured against the
 * live upstream on 2026-09-18 with the nutrient family: 1° answered in 11 s,
 * 2° in 20 s, and 3° timed out. A larger bound is not a stricter cap that
 * occasionally bites — it silently turns every regional view into an empty map.
 */
export const MAX_VIEWPORT_DEGREES = 2;

export const MAX_RENDERED = 500;

export const MARKER_PIXEL_SIZE = 12;

export const MARKER_SELECTED_PIXEL_SIZE = 16;

/** Analyte lines on a selected site's label before it becomes a wall of text. */
export const MAX_CARD_MEASUREMENTS = 6;

/**
 * Labels stop here; markers do not. Past a city-scale view the names collide
 * into an unreadable mat, but the dots still carry where the network is — so
 * the text goes and the marker stays.
 */
export const LABEL_VISIBLE_DISTANCE_M = 40000;

/**
 * Distance falloff, as plain numbers.
 *
 * The Cesium NearFarScalars are built in the renderer rather than here because
 * `./layers/water-quality/source` is a portable export that reads this module
 * and must not pull Cesium in with it.
 *
 * Markers recede but never vanish: a monitoring site is a fixed ground feature
 * and the point of pulling back is to see the shape of the network. The floor
 * is deliberately high and there is no opacity fade — an earlier 0.4 scale with
 * a 0.35 alpha floor made every unselected site invisible from orbit and left
 * only the selected one on screen.
 */
export const MARKER_FALLOFF = Object.freeze({
  nearM: 500,
  nearScale: 1.3,
  farM: 1_500_000,
  farScale: 0.8,
});

export const LABEL_FALLOFF = Object.freeze({
  nearM: 500,
  nearScale: 1,
  farM: LABEL_VISIBLE_DISTANCE_M,
  farScale: 0.8,
});

export const DEFAULT_FAMILY = 'nutrient';

export const DEFAULT_WINDOW_YEARS = 5;

/**
 * Analyte families the layer offers, in menu order. `label` is what the operator
 * reads; `id` is the only value that ever reaches the proxy.
 */
export const ANALYTE_FAMILIES = Object.freeze([
  Object.freeze({ id: 'nutrient', label: 'Nutrients' }),
  Object.freeze({ id: 'pfas', label: 'PFAS' }),
  Object.freeze({ id: 'metals', label: 'Metals' }),
  Object.freeze({ id: 'microbio', label: 'Microbiological' }),
  Object.freeze({ id: 'radiochem', label: 'Radiochemical' }),
]);

export const FAMILY_IDS = Object.freeze(
  ANALYTE_FAMILIES.map((family) => family.id),
);

/**
 * Colour by analyte FAMILY, never by concentration.
 *
 * Safe thresholds differ per analyte and per medium, so a red dot derived from
 * a number would read as a health verdict this layer has no standing to issue.
 * The family colour says what was looked for; the card says what was found.
 */
export const COLOR_BY_FAMILY = Object.freeze({
  pfas: '#c58cff',
  nutrient: '#5aa9ff',
  metals: '#d9a85d',
  microbio: '#48c7d5',
  radiochem: '#ff8a5a',
});

export const DEFAULT_COLOR = '#9ca6b0';

/**
 * Families whose routine monitoring vocabulary is known to omit compounds an
 * operator may expect. Surfaced through getStats().coverage so an absent dot is
 * never read as an absent contaminant.
 */
export const COVERAGE_CAVEATS = Object.freeze({
  pfas: 'Regulated PFAS analytes only; ultrashort-chain C2/C3 (TFA, PFPrA) are not in the monitoring vocabulary',
});

export const EARTH_MEAN_RADIUS_M = 6371008.8;

export const DISTANCE_PREFILTER_MARGIN_M = 5000;
