/**
 * CCTV bearing provenance — consumers for the catalog's per-camera
 * `headingConfidence` flag (ported from upstream 5f27f6e, #639).
 *
 * Packs whose feed publishes no facing get a synthetic bearing from
 * `fallbackHeadingFromId` (a hash of the id string, no geographic input)
 * and are marked `headingConfidence: 'low'`. Until now nothing read the
 * flag, so a guessed bearing rendered exactly like a surveyed one. These
 * helpers make the guess visible: the HUD heading token gains an
 * `(ESTIMATED)` tag and the coverage wireframe draws dashed instead of
 * solid (colors, widths, and the active/idle emphasis are unchanged).
 *
 * A human-vouched pose always wins over the pack flag: a manually saved
 * calibration (`calSource:'manual'`) or a hand-authored catalog entry
 * (`poseSource:'curated'`) is never presented as estimated, mirroring the
 * CAL badge states in `deriveCalBadge` (cctv.js). Pure and worker-safe.
 *
 * @module data/cctvHeadingConfidence
 */

/**
 * Whether a camera's bearing is a synthetic guess that should present as
 * provisional.
 * @param {{headingConfidence?: string|null, calSource?: string|null,
 *   poseSource?: string|null}} camera - Catalog camera (or public state).
 * @returns {boolean} True when the bearing is an unvouched low-confidence guess.
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
 * synthetic — so a hash can never read as a surveyed facing. A camera that
 * already carries the derived `headingEstimated` bit (the layer's public
 * camera state computes it against the raw record, where `calSource` lives)
 * is honored verbatim; only a bare catalog camera is re-derived here.
 * @param {{headingDeg?: number, headingConfidence?: string|null,
 *   headingEstimated?: boolean, calSource?: string|null,
 *   poseSource?: string|null}} camera - Camera or public camera state.
 * @returns {string} The HUD token.
 */
export function headingHudToken(camera) {
  const hdg = Math.round(Number(camera?.headingDeg) || 0);
  const estimated = typeof camera?.headingEstimated === 'boolean'
    ? camera.headingEstimated
    : isHeadingEstimated(camera);
  return `HDG ${hdg}°${estimated ? ' (ESTIMATED)' : ''}`;
}
