import { t } from '../../i18n/index.js';

/**
 * @module headingConfidence
 *
 * Consumers for the catalog's per-camera `headingConfidence` flag (#639).
 *
 * Packs whose feed publishes no facing get a synthetic bearing from
 * `fallbackHeadingFromId` — a hash of the id string, with no geographic
 * input — and are marked `headingConfidence: 'low'`. Until now nothing read
 * the flag, so a guessed bearing rendered exactly like a surveyed one. These
 * helpers make the guess visible: the HUD heading token gains an
 * `(ESTIMATED)` tag and the coverage wireframe draws dashed instead of solid.
 *
 * A human-vouched pose always wins over the pack flag: a manually saved
 * calibration (`calSource:'manual'`) or a hand-authored catalog entry
 * (`poseSource:'curated'`) is never presented as estimated, mirroring the
 * CAL badge states in calibration.js.
 */

/**
 * Whether a camera's bearing is a synthetic guess that should present as
 * provisional.
 * @param {{headingConfidence?: string|null, calSource?: string|null,
 *   poseSource?: string|null}} camera - Catalog camera (or public state).
 * @returns {boolean}
 */
export function isHeadingEstimated(camera) {
  if (!camera) return false;
  if (camera.calSource === 'manual') return false;
  if (camera.poseSource === 'curated') return false;
  return (
    String(camera.headingConfidence || '')
      .trim()
      .toLowerCase() === 'low'
  );
}

/**
 * HUD heading token: `HDG 194°`, tagged `(ESTIMATED)` when the bearing is
 * synthetic — so a hash can never read as a surveyed facing.
 * @param {{headingDeg?: number, headingConfidence?: string|null,
 *   calSource?: string|null, poseSource?: string|null}} camera
 * @returns {string}
 */
export function headingHudToken(camera) {
  const hdg = Math.round(Number(camera?.headingDeg) || 0);
  // The token copy lives in the layers catalog (en is byte-identical to the
  // literals these replace); presentation stays here, translation at read.
  return isHeadingEstimated(camera)
    ? t('layers.cctv.summary.hdgEstimated', { value: hdg })
    : t('layers.cctv.summary.hdg', { value: hdg });
}
