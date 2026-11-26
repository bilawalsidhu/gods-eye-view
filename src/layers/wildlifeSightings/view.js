/**
 * @module layers/wildlifeSightings/view
 * @description What the layer reads of the eye, through the camera port.
 */
import { findCamera } from '../../render/rendererOf.js';

/** The eye's height above the ellipsoid, metres; undefined with no camera. */
export function wildlifeEyeHeight(viewer) {
  return viewer ? findCamera(viewer)?.pose().height : undefined;
}

/** The view rectangle in degrees (`viewRectangle()`), or null. */
export function wildlifeViewRectangle(viewer) {
  return (viewer ? findCamera(viewer)?.viewRectangle() : null) ?? null;
}
