export const INFRARED_ALPHA_T0 = 0.4;
export const INFRARED_ALPHA_T1 = 0.7;

/** Return display pixels without changing RGB or the source RGBA bytes.
 * `strength` is 0–100: zero is the full image and 100 is the cloud key.
 */
export function infraredAlpha(rgba, strength = 'filtered') {
  const pixels = new Uint8ClampedArray(rgba);
  const amount =
    strength === 'full'
      ? 0
      : strength === 'filtered' || !Number.isFinite(strength)
        ? 1
        : Math.max(0, Math.min(100, strength)) / 100;
  if (amount === 0) return pixels;
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
    const filtered = t * t * (3 - 2 * t);
    pixels[i + 3] = rgba[i + 3] * (1 - amount + filtered * amount);
  }
  return pixels;
}
