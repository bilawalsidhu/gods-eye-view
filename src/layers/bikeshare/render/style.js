// How the bikeshare stations draw (engine.movers point sets).

import { CYAN } from '../../shared/color.js';
import { COLOR_OUTLINE } from '../policy.js';

export const STATION_SET_ID = 'bikeshare';
export const SELECTED_SET_ID = 'bikeshare-selected';

/**
 * A station's disc: sizePx times the point's scale (its capacity's pixel
 * size over sizePx), a faint outline, larger and opaque up close, smaller
 * and fading out with distance.
 */
export const STATION_POINT = Object.freeze({
  sizePx: 8,
  outlinePx: 1,
  outlineColor: COLOR_OUTLINE.rgba(),
  scaleByDistance: Object.freeze([200, 1.35, 130000, 0.4]),
  translucencyByDistance: Object.freeze([200, 1, 180000, 0.15]),
});

/** On top within this distance of the camera, depth tested beyond. */
export const STATION_DEPTH_TEST = Object.freeze({ disableWithinM: 2500 });

/** The selected station's highlight: a fixed-size cyan disc. */
export const SELECTED_POINT = Object.freeze({
  sizePx: 14,
  outlinePx: 2,
  outlineColor: [0, 0, 0, 1],
});
export const SELECTED_COLOR = CYAN;
