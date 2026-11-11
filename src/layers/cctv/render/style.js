// The CCTV display's look on the globe contract: the camera markers, the
// coverage lines as created, the monitor plane's outline and material and
// the calibration gizmo's handles, in contract terms (CSS pixels, a
// depth-fail alpha factor). Values are Cesium's, the reference look; the
// per-camera coverage styles are the layer's (../rendering.js). No engine
// imports.

import { SPRITE_LAYER_ORDER } from '../../../data/spriteOrder.js';
import { IDLE_COVERAGE_COLOR, PLANE_OUTLINE_COLOR } from '../policy.js';

/** The camera markers: one sprite set, the bottom of the contact sprites. */
export const MARKER_SET_ID = 'cctv';
export const MARKER_SIZE_PX = 24;
export const MARKER_SCALE_BY_DISTANCE = Object.freeze([
  350, 1.25, 4_000_000, 0.42,
]);
export const MARKER_ORDER = SPRITE_LAYER_ORDER.indexOf('cctv');

/** A coverage line as created, before the first style pass. */
export const COVERAGE_INITIAL = Object.freeze({
  widthPx: 1.2,
  color: IDLE_COVERAGE_COLOR,
});
// Cesium's PolylineDashMaterialProperty defaults: 16 px, half dash.
export const COVERAGE_DASH = Object.freeze({ lengthPx: 8, gapPx: 8 });
// Entity polylines follow the ellipsoid (Cesium's default arc type).
export const LINE_ARC = 'geodesic';

/** The monitor plane: its image at 95 % and a 1 px outline. */
export const PLANE_IMAGE_ALPHA = 0.95;
export const PLANE_OUTLINE = Object.freeze({
  widthPx: 1,
  color: PLANE_OUTLINE_COLOR,
});

/** The calibration gizmo, drawn over the markers. */
export const GIZMO_ORDER = 100;
export const GIZMO_LINE_ALPHA = 0.9;
// Parts behind geometry stay visible, dimmed: a street-level mount buries
// half the heading ring in sloped photogrammetry tiles.
export const GIZMO_DEPTH_FAIL_ALPHA = 0.45;
export const GIZMO_ARROW_TIP_PX = 14;
export const GIZMO_POINT = Object.freeze({
  sizePx: 10,
  outlinePx: 2,
  outlineColor: Object.freeze([0, 0, 0, 0.7]),
});
// Pick boxes around the pointer, as Cesium's gizmo picked.
export const GIZMO_PICK_PX = 14;
export const GIZMO_DRILL_LIMIT = 6;

/**
 * A depth-fail colour as the contract's alpha factor of the line colour (the
 * contract keeps the line's hue where the scene hides it).
 */
export const depthFailAlpha = (tint, depthFail) =>
  depthFail
    ? Math.min(1, Math.max(0, depthFail.alpha / Math.max(tint.alpha, 1e-6)))
    : 0;
