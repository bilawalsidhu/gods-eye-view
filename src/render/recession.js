/**
 * @module render/recession
 * @description How a set that recedes (`SetSpec.recede`) shrinks and fades
 * its items toward the globe's limb, free of Cesium, so the renderer
 * draws exactly those factors. The factors are 1 while an item is nearer than
 * `startLimbRatio` of the distance from the eye to the limb, and ease
 * (smoothstep) to `scaleFloor` and `alphaFloor` at the limb. The whole of it
 * eases back to nothing as the eye climbs through the blend band
 * (`globeViewBlendStartM` to `globeViewBlendEndM`), so a view of the whole
 * globe draws its items unreceded, with no step on the way there.
 *
 * An item's alpha is its own times `max(combinedAlphaFloor, focus × haze)`:
 * focus and haze multiply, and their product never falls under the floor.
 * Icons also draw at their scale times the scale factor; models only fade.
 */

/** What a set that recedes takes for what its `recede` leaves out. */
export const RECEDE_DEFAULTS = Object.freeze({
  startLimbRatio: 0.5,
  scaleFloor: 0.45,
  alphaFloor: 0.35,
  combinedAlphaFloor: 0.2,
  globeViewBlendStartM: 3_500_000,
  globeViewBlendEndM: 4_500_000,
  earthRadiusM: 6_378_137,
});

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

/**
 * A set's `recede` as the parameters it draws with: each one given taken
 * (clamped to what draws), the rest from `base`; null when the set does not
 * recede.
 * @param {object|null|undefined} spec
 * @param {typeof RECEDE_DEFAULTS} [base]
 * @returns {typeof RECEDE_DEFAULTS|null}
 */
export function recedeParams(spec, base = RECEDE_DEFAULTS) {
  if (spec === null || spec === undefined || spec === false) return null;
  const given = typeof spec === 'object' ? spec : {};
  const next = {
    startLimbRatio: base.startLimbRatio,
    scaleFloor: base.scaleFloor,
    alphaFloor: base.alphaFloor,
    combinedAlphaFloor: base.combinedAlphaFloor,
    globeViewBlendStartM: base.globeViewBlendStartM,
    globeViewBlendEndM: base.globeViewBlendEndM,
    earthRadiusM: base.earthRadiusM,
  };
  if (Number.isFinite(given.startLimbRatio))
    next.startLimbRatio = clamp(given.startLimbRatio, 0, 0.99);
  if (Number.isFinite(given.scaleFloor))
    next.scaleFloor = clamp(given.scaleFloor, 0.05, 1);
  if (Number.isFinite(given.alphaFloor))
    next.alphaFloor = clamp(given.alphaFloor, 0.05, 1);
  if (Number.isFinite(given.combinedAlphaFloor))
    next.combinedAlphaFloor = clamp(given.combinedAlphaFloor, 0.05, 1);
  if (Number.isFinite(given.globeViewBlendStartM))
    next.globeViewBlendStartM = Math.max(1, given.globeViewBlendStartM);
  if (Number.isFinite(given.globeViewBlendEndM))
    next.globeViewBlendEndM = Math.max(
      next.globeViewBlendStartM + 1,
      given.globeViewBlendEndM,
    );
  if (next.globeViewBlendStartM >= next.globeViewBlendEndM)
    next.globeViewBlendStartM = Math.max(1, next.globeViewBlendEndM - 1);
  if (Number.isFinite(given.earthRadiusM))
    next.earthRadiusM = Math.max(1, given.earthRadiusM);
  return next;
}

/**
 * The straight-line distance from an eye this high above a sphere of this
 * radius to the sphere's limb; NaN at or under the surface.
 * @param {number} heightM
 * @param {number} [earthRadiusM]
 * @returns {number}
 */
export function limbDistanceM(
  heightM,
  earthRadiusM = RECEDE_DEFAULTS.earthRadiusM,
) {
  if (!Number.isFinite(heightM) || heightM <= 0) return Number.NaN;
  return Math.sqrt(heightM * (2 * earthRadiusM + heightM));
}

/**
 * What one frame's items recede by, from the eye's height: whether they
 * recede at all (`active`), the limb's distance, and the strength the blend
 * band leaves (1 under it, 0 over it).
 * @param {number} cameraHeightM
 * @param {typeof RECEDE_DEFAULTS} params
 * @param {{active: boolean, limbM: number, strength: number}} [result]
 * @returns {{active: boolean, limbM: number, strength: number}}
 */
export function recedeFrame(
  cameraHeightM,
  params,
  result = { active: false, limbM: 1, strength: 0 },
) {
  const limbM = limbDistanceM(cameraHeightM, params.earthRadiusM);
  const active =
    Number.isFinite(cameraHeightM) &&
    cameraHeightM > 0 &&
    cameraHeightM < params.globeViewBlendEndM &&
    limbM > 0;
  result.active = active;
  if (!active) {
    result.limbM = 1;
    result.strength = 0;
    return result;
  }
  const g = clamp(
    (cameraHeightM - params.globeViewBlendStartM) /
      (params.globeViewBlendEndM - params.globeViewBlendStartM),
    0,
    1,
  );
  result.limbM = limbM;
  result.strength = 1 - g * g * (3 - 2 * g);
  return result;
}

/**
 * The scale and haze an item this far from the eye recedes by in `frame`,
 * and its distance as a share of the limb's (null while nothing recedes).
 * @param {number} distanceM
 * @param {{active: boolean, limbM: number, strength: number}} frame
 * @param {typeof RECEDE_DEFAULTS} params
 * @param {{scale: number, alpha: number, limbRatio: number|null}} [result]
 * @returns {{scale: number, alpha: number, limbRatio: number|null}}
 */
export function recedeFactors(
  distanceM,
  frame,
  params,
  result = { scale: 1, alpha: 1, limbRatio: null },
) {
  if (!frame.active || !Number.isFinite(distanceM) || distanceM < 0) {
    result.scale = 1;
    result.alpha = 1;
    result.limbRatio = null;
    return result;
  }
  const limbRatio = distanceM / frame.limbM;
  result.limbRatio = limbRatio;
  if (limbRatio <= params.startLimbRatio) {
    result.scale = 1;
    result.alpha = 1;
    return result;
  }
  const t = clamp(
    (limbRatio - params.startLimbRatio) / (1 - params.startLimbRatio),
    0,
    1,
  );
  // Smoothstep: no slope at either end of the band.
  const ease = t * t * (3 - 2 * t) * frame.strength;
  result.scale = 1 + (params.scaleFloor - 1) * ease;
  result.alpha = 1 + (params.alphaFloor - 1) * ease;
  return result;
}

/**
 * What a receding item's own alpha is multiplied by: its focus (0..1) times
 * its haze, never under the combined floor.
 * @param {number} focus
 * @param {number} haze `recedeFactors(...).alpha`.
 * @param {typeof RECEDE_DEFAULTS} params
 * @returns {number}
 */
export function recededAlpha(focus, haze, params) {
  return Math.max(params.combinedAlphaFloor, clamp(focus, 0, 1) * haze);
}
