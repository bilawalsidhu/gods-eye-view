export const INFRARED_ALPHA_T0 = 0.4;
export const INFRARED_ALPHA_T1 = 0.7;

/** Scale each pixel's alpha in place by a 256-entry table indexed by its
 * brightest channel; RGB is unchanged. A table, not `** 2.2` per pixel:
 * 4096×2048 is 8.4 M pixels. `strength` is 0–100: 0 is the full image, 100
 * the cloud key.
 */
export function applyInfraredAlpha(pixels, strength = 'filtered') {
  const amount =
    strength === 'full'
      ? 0
      : strength === 'filtered' || !Number.isFinite(strength)
        ? 1
        : Math.max(0, Math.min(100, strength)) / 100;
  if (amount === 0) return pixels;
  const scale = new Float64Array(256);
  for (let value = 0; value < 256; value++) {
    // Match Cesium's czm_srgbToLinear conversion in draped imagery.
    const linearMax = (value / 255) ** 2.2;
    const t = Math.max(
      0,
      Math.min(
        1,
        (linearMax - INFRARED_ALPHA_T0) /
          (INFRARED_ALPHA_T1 - INFRARED_ALPHA_T0),
      ),
    );
    const filtered = t * t * (3 - 2 * t);
    scale[value] = 1 - amount + filtered * amount;
  }
  for (let i = 0; i < pixels.length; i += 4) {
    pixels[i + 3] *= scale[Math.max(pixels[i], pixels[i + 1], pixels[i + 2])];
  }
  return pixels;
}
