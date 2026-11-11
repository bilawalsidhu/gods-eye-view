// Keep the globe at CSS resolution; aircraft have their own full-DPR surface.
export const STANDARD_RENDER_PIXEL_RATIO_MAX = 1;
/** Bound globe resolution independently of the full-resolution aircraft surface. */
export function standardResolutionScale(dpr = globalThis.devicePixelRatio) {
  return Math.min(
    STANDARD_RENDER_PIXEL_RATIO_MAX,
    Math.max(1, Number(dpr) || 1),
  );
}

/** Scene-owned listener: display changes preserve custom scales and low mode. */
export function configureRenderResolution(
  viewer,
  { lowResource = false, getDpr = () => globalThis.devicePixelRatio } = {},
) {
  viewer.gevStandardResolutionScale = standardResolutionScale(getDpr());
  viewer.gevLowResource = lowResource;
  viewer.resolutionScale = lowResource
    ? 0.6
    : viewer.gevStandardResolutionScale;
  return viewer.scene.preUpdate.addEventListener(() => {
    const next = standardResolutionScale(getDpr());
    const previous = viewer.gevStandardResolutionScale;
    if (next === previous) return;
    viewer.gevStandardResolutionScale = next;
    if (!viewer.gevLowResource && viewer.resolutionScale === previous)
      viewer.resolutionScale = next;
  });
}
