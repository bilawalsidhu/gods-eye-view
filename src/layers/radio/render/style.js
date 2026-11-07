// How the radio stations draw (engine.movers point and sprite sets). Every
// set draws over the scene and hides beyond
// RADIO_GLOBE_INTERACTION_MAX_DISTANCE_M from the camera.

export const STATION_SET_ID = 'radio-stations';
export const CLUSTER_SET_ID = 'radio-clusters';
export const SELECTED_SET_ID = 'radio-selected';
export const BRACKET_SET_ID = 'radio-bracket';

export const STATION_ORDER = 40;
export const CLUSTER_ORDER = 41;
export const SELECTED_ORDER = 42;
export const BRACKET_ORDER = 43;

/** A station's disc, its category colour at STATION_ALPHA. */
export const STATION_POINT = Object.freeze({
  sizePx: 13,
  outlinePx: 1,
  outlineCss: '#071b25',
  scaleByDistance: Object.freeze([100_000, 1.15, 12_000_000, 1]),
});
export const STATION_ALPHA = 0.86;

/**
 * A cluster's disc: its dominant category's colour at CLUSTER_ALPHA,
 * clusterPixelSize(count) across (sizePx times the point's scale).
 */
export const CLUSTER_POINT = Object.freeze({
  sizePx: 12,
  outlinePx: 2,
  outlineColor: Object.freeze([0, 0, 0, 1]),
});
export const CLUSTER_ALPHA = 0.9;

/** The diameter of a cluster of `count` stations, in CSS pixels. */
export const clusterPixelSize = (count) =>
  Math.min(26, 12 + Math.log2(count) * 1.6);

/** The selected station's opaque disc. */
export const SELECTED_POINT = Object.freeze({
  sizePx: 14,
  outlinePx: 2,
  outlineColor: Object.freeze([0, 0, 0, 1]),
});

/** The four corner brackets around the selection, tinted by its colour. */
export const BRACKET_SPRITE = Object.freeze({
  sizePx: 40,
  scaleByDistance: Object.freeze([100_000, 1, 12_000_000, 0.72]),
});
