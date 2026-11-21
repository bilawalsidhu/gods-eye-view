export const INFRARED_ALPHA_T0 = 0.4;
export const INFRARED_ALPHA_T1 = 0.7;

function infraredAmount(strength) {
  return strength === 'full'
    ? 0
    : strength === 'filtered' || !Number.isFinite(strength)
      ? 1
      : Math.max(0, Math.min(100, strength)) / 100;
}

/** Scale each pixel's alpha in place; RGB is left as it is. The scale depends
 * only on the brightest channel, so it is worked out once for each of the 256
 * byte values instead of once per pixel: a 4096×2048 image has 8.4 million
 * pixels and the power curve per pixel held the page for over 100 ms. The
 * table holds the same numbers the per-pixel formula produced, so the output
 * bytes are unchanged.
 * `strength` is 0–100: zero is the full image and 100 is the cloud key.
 */
export function applyInfraredAlpha(pixels, strength = 'filtered') {
  const amount = infraredAmount(strength);
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
    const r = pixels[i];
    const g = pixels[i + 1];
    const b = pixels[i + 2];
    const max = r > g ? (r > b ? r : b) : g > b ? g : b;
    pixels[i + 3] = pixels[i + 3] * scale[max];
  }
  return pixels;
}

/** Return display pixels without changing RGB or the source RGBA bytes.
 * `strength` is 0–100: zero is the full image and 100 is the cloud key.
 */
export function infraredAlpha(rgba, strength = 'filtered') {
  return applyInfraredAlpha(new Uint8ClampedArray(rgba), strength);
}
