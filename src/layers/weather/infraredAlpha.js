export const INFRARED_ALPHA_T0 = 0.4;
export const INFRARED_ALPHA_T1 = 0.7;

/** Return display pixels without changing RGB or the source RGBA bytes. */
export function infraredAlpha(rgba, mode = 'filtered') {
  const pixels = new Uint8ClampedArray(rgba);
  if (mode === 'full') return pixels;
  for (let i = 0; i < pixels.length; i += 4) {
    // Match Cesium's czm_srgbToLinear conversion in draped imagery.
    const linearMax =
      (Math.max(rgba[i], rgba[i + 1], rgba[i + 2]) / 255) ** 2.2;
    const t = Math.max(
      0,
      Math.min(
        1,
        (linearMax - INFRARED_ALPHA_T0) /
          (INFRARED_ALPHA_T1 - INFRARED_ALPHA_T0),
      ),
    );
    pixels[i + 3] = rgba[i + 3] * t * t * (3 - 2 * t);
  }
  return pixels;
}
