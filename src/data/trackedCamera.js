/**
 * Closest a follow camera comes to a tracked aircraft, metres: the camera
 * port's `minRange` for the aircraft layers' FollowTargets.
 */
export const FOLLOW_MIN_RANGE_M = 150;

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
