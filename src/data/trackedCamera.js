// The pure parts of the tracked aircraft camera. The Cesium follow itself
// (the one-off tracked frame, the zoom limits) is the engine's:
// src/globe/cesium/follow.js; the range clamp is src/globe/follow.js.

import * as geo from '../geo/index.js';

export { clampTrackedCameraPosition } from '../globe/follow.js';

/**
 * Preserve real-world model scale except when a very close tracked camera
 * would make the selected aircraft dominate the viewport.
 *
 * @param {object} options
 * @param {number} options.baseScale Asset's calibrated real-world scale.
 * @param {number} options.nativeRadiusM Asset bounding radius before scale.
 * @param {number} options.rangeM Camera-to-aircraft range.
 * @param {number} options.viewportHeightPx Rendered viewport height.
 * @param {number} options.fovyRad Vertical field of view.
 * @param {number} options.maximumPixelSize Maximum selected-model diameter.
 * @returns {number} Scale to apply to the model.
 */
export function trackedModelScaleForPixelCap({
  baseScale,
  nativeRadiusM,
  rangeM,
  viewportHeightPx,
  fovyRad,
  maximumPixelSize,
}) {
  if (
    !Number.isFinite(baseScale) ||
    baseScale <= 0 ||
    !Number.isFinite(nativeRadiusM) ||
    nativeRadiusM <= 0 ||
    !Number.isFinite(rangeM) ||
    rangeM <= 0 ||
    !Number.isFinite(viewportHeightPx) ||
    viewportHeightPx <= 0 ||
    !Number.isFinite(fovyRad) ||
    fovyRad <= 0 ||
    !Number.isFinite(maximumPixelSize) ||
    maximumPixelSize <= 0
  )
    return baseScale;
  const focalLengthPx = viewportHeightPx / (2 * Math.tan(fovyRad / 2));
  const projectedDiameterPx =
    (2 * nativeRadiusM * baseScale * focalLengthPx) / rangeM;
  if (projectedDiameterPx <= maximumPixelSize) return baseScale;
  return baseScale * (maximumPixelSize / projectedDiameterPx);
}

/**
 * Resolve the exact position already consumed by the tracked visual whenever
 * the layer exposes one, without advancing its CallbackProperty again.
 *
 * @param {Cesium.Entity} entity Tracked entity.
 * @param {Cesium.JulianDate} time Current viewer time.
 * @param {Cesium.Cartesian3} result Destination.
 * @returns {Cesium.Cartesian3|undefined} Camera-frame position.
 */
export function trackedDisplayPositionForCamera(entity, time, result) {
  const displayedPosition = entity?.gevDisplayPosition?.();
  return displayedPosition
    ? geo.cartesian3.clone(displayedPosition, result)
    : entity?.position?.getValue(time, result);
}
