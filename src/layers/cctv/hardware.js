/**
 * @module cctvHardware
 *
 * Camera-maker labels for packs whose catalog names the hardware maker or
 * product line but not the model (Austin's `camera_mfg`: "Wisenet",
 * "Advidia", "Sarix", "Spectra Enhanced", "Axis").
 *
 * A maker alone says nothing about a camera's optics, so nothing here touches
 * the pose or the FOV estimate. The one inference drawn is PTZ for product
 * lines that contain only PTZ cameras: every Pelco Spectra model in the CCTV
 * Camera Database (CC0, 160 models) is a PTZ dome, so a Spectra camera can be
 * re-aimed and its listed facing is at best a home position. Lines that mix
 * fixed and PTZ hardware (Sarix, Wisenet, AUTODOME) are labelled only.
 */

/** Product lines made up entirely of PTZ cameras. */
const PTZ_ONLY_LINES = [/\bspectra\b/i];

/**
 * Whether a maker / product-line name is a PTZ-only line.
 * @param {string|null|undefined} manufacturer
 * @returns {boolean}
 */
export function isPtzOnlyLine(manufacturer) {
  const text = String(manufacturer || '');
  return PTZ_ONLY_LINES.some((re) => re.test(text));
}

/**
 * Display label for a camera's hardware maker, e.g. "Hanwha Wisenet" or
 * "Pelco Spectra Enhanced (PTZ)"; '' when the pack names no maker.
 * @param {{manufacturer?: string|null}} camera
 * @returns {string}
 */
export function hardwareLabel(camera) {
  const maker = String(camera?.manufacturer || '').trim();
  if (!maker) return '';
  return isPtzOnlyLine(maker) ? `${maker} (PTZ)` : maker;
}

/**
 * HUD token for the hardware maker: `HW HANWHA WISENET`, or null when unknown.
 * @param {{manufacturer?: string|null}} camera
 * @returns {string|null}
 */
export function hardwareHudToken(camera) {
  const label = hardwareLabel(camera);
  return label ? `HW ${label.toUpperCase()}` : null;
}
