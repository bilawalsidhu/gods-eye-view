/**
 * Limb-relative recession for distant aircraft: the factors icon sets apply in
 * their shader (ICON_RECEDES) and models apply through their colour alpha.
 *
 * It multiplies an icon's ordinary scale, which composes with its locked
 * NearFarScalar. It never edits that scalar, culls a contact, or allows alpha
 * to reach zero.
 */

export const DEFAULT_AIRCRAFT_RECESSION_PARAMS = Object.freeze({
  startLimbRatio: 0.5,
  scaleFloor: 0.45,
  alphaFloor: 0.35,
  combinedAlphaFloor: 0.2,
  globeViewBlendStartM: 3_500_000,
  globeViewBlendEndM: 4_500_000,
  earthRadiusM: 6_378_137,
  writeEpsilon: 0.005,
});

let _params = { ...DEFAULT_AIRCRAFT_RECESSION_PARAMS };
const _scratchFactors = { scale: 1, alpha: 1, limbRatio: null };

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function resolvedParams(overrides) {
  if (!overrides || overrides === _params) return _params;
  return { ..._params, ...overrides };
}

function aircraftRecessionFactorsResolved(
  cameraDistanceM,
  cameraHeightM,
  tuning,
  result,
) {
  if (
    !Number.isFinite(cameraDistanceM) ||
    cameraDistanceM < 0 ||
    !Number.isFinite(cameraHeightM) ||
    cameraHeightM <= 0 ||
    cameraHeightM >= tuning.globeViewBlendEndM
  ) {
    result.scale = 1;
    result.alpha = 1;
    result.limbRatio = null;
    return result;
  }
  const limbDistance = cameraLimbDistanceM(cameraHeightM, tuning.earthRadiusM);
  if (!Number.isFinite(limbDistance) || limbDistance <= 0) {
    result.scale = 1;
    result.alpha = 1;
    result.limbRatio = null;
    return result;
  }
  const limbRatio = cameraDistanceM / limbDistance;
  if (limbRatio <= tuning.startLimbRatio) {
    result.scale = 1;
    result.alpha = 1;
    result.limbRatio = limbRatio;
    return result;
  }

  const rawT =
    (limbRatio - tuning.startLimbRatio) / (1 - tuning.startLimbRatio);
  const t = clamp(rawT, 0, 1);
  const limbEase = t * t * (3 - 2 * t); // smoothstep: zero slope at both band edges
  const globeRawT =
    (cameraHeightM - tuning.globeViewBlendStartM) /
    (tuning.globeViewBlendEndM - tuning.globeViewBlendStartM);
  const globeT = clamp(globeRawT, 0, 1);
  const globeEase = globeT * globeT * (3 - 2 * globeT);
  const strength = 1 - globeEase;
  result.scale = 1 + (tuning.scaleFloor - 1) * limbEase * strength;
  result.alpha = 1 + (tuning.alphaFloor - 1) * limbEase * strength;
  result.limbRatio = limbRatio;
  return result;
}

/**
 * Patch runtime taper tuning for evidence capture/A-B work.
 * @param {Partial<typeof DEFAULT_AIRCRAFT_RECESSION_PARAMS>} [patch]
 * @returns {typeof DEFAULT_AIRCRAFT_RECESSION_PARAMS}
 */
export function setAircraftRecessionParams(patch = {}) {
  const next = { ..._params };
  if (Number.isFinite(patch.startLimbRatio)) {
    next.startLimbRatio = clamp(patch.startLimbRatio, 0, 0.99);
  }
  if (Number.isFinite(patch.scaleFloor))
    next.scaleFloor = clamp(patch.scaleFloor, 0.05, 1);
  if (Number.isFinite(patch.alphaFloor))
    next.alphaFloor = clamp(patch.alphaFloor, 0.05, 1);
  if (Number.isFinite(patch.combinedAlphaFloor)) {
    next.combinedAlphaFloor = clamp(patch.combinedAlphaFloor, 0.05, 1);
  }
  if (Number.isFinite(patch.globeViewBlendStartM)) {
    next.globeViewBlendStartM = Math.max(1, patch.globeViewBlendStartM);
  }
  if (Number.isFinite(patch.globeViewBlendEndM)) {
    next.globeViewBlendEndM = Math.max(
      next.globeViewBlendStartM + 1,
      patch.globeViewBlendEndM,
    );
  }
  // Backward-compatible evidence override: the former hard threshold now
  // names the identity end of the blend band.
  if (Number.isFinite(patch.globeViewHeightM)) {
    next.globeViewBlendEndM = Math.max(
      next.globeViewBlendStartM + 1,
      patch.globeViewHeightM,
    );
  }
  if (next.globeViewBlendStartM >= next.globeViewBlendEndM) {
    next.globeViewBlendStartM = Math.max(1, next.globeViewBlendEndM - 1);
  }
  if (Number.isFinite(patch.earthRadiusM))
    next.earthRadiusM = Math.max(1, patch.earthRadiusM);
  if (Number.isFinite(patch.writeEpsilon))
    next.writeEpsilon = Math.max(0, patch.writeEpsilon);
  _params = next;
  return { ..._params };
}

/** @returns {typeof DEFAULT_AIRCRAFT_RECESSION_PARAMS} Current tuning. */
export function getAircraftRecessionParams() {
  return _params;
}

/** Restore production defaults for deterministic QA. */
export function resetAircraftRecessionParams() {
  _params = { ...DEFAULT_AIRCRAFT_RECESSION_PARAMS };
}

/**
 * Straight-line tangent distance from a camera above a spherical Earth to its
 * geometric limb. The WGS84 semi-major radius is sufficient for a visual
 * taper; the occluder remains the authoritative far-side visibility test.
 * @param {number} cameraHeightM
 * @param {number} [earthRadiusM]
 * @returns {number}
 */
export function cameraLimbDistanceM(
  cameraHeightM,
  earthRadiusM = DEFAULT_AIRCRAFT_RECESSION_PARAMS.earthRadiusM,
) {
  if (!Number.isFinite(cameraHeightM) || cameraHeightM <= 0) return Number.NaN;
  return Math.sqrt(cameraHeightM * (2 * earthRadiusM + cameraHeightM));
}

/**
 * Pure recession factors for one aircraft.
 * @param {object} input
 * @param {number} input.cameraDistanceM Sprite-to-camera distance.
 * @param {number} input.cameraHeightM Camera height above the ellipsoid.
 * @param {Partial<typeof DEFAULT_AIRCRAFT_RECESSION_PARAMS>} [params]
 * @returns {{scale:number,alpha:number,limbRatio:number|null}}
 */
export function aircraftRecessionFactors(
  { cameraDistanceM, cameraHeightM },
  params,
) {
  const tuning = resolvedParams(params);
  return aircraftRecessionFactorsResolved(
    cameraDistanceM,
    cameraHeightM,
    tuning,
    { scale: 1, alpha: 1, limbRatio: null },
  );
}

/**
 * The alpha an aircraft draws with: base × max(combined floor, focus × limb
 * haze). Icon sets compose the same thing in their shader; models need it here.
 * @param {object} input
 * @param {number} input.baseAlpha
 * @param {number} input.focusFactor
 * @param {number} input.cameraDistanceM
 * @param {number} input.cameraHeightM
 * @param {Partial<typeof DEFAULT_AIRCRAFT_RECESSION_PARAMS>} [input.params]
 * @returns {number}
 */
export function aircraftTreatmentAlpha({
  baseAlpha,
  focusFactor,
  cameraDistanceM,
  cameraHeightM,
  params,
}) {
  const tuning = resolvedParams(params);
  const factors = aircraftRecessionFactorsResolved(
    cameraDistanceM,
    cameraHeightM,
    tuning,
    _scratchFactors,
  );
  return (
    baseAlpha *
    Math.max(
      tuning.combinedAlphaFloor,
      clamp(focusFactor, 0, 1) * factors.alpha,
    )
  );
}

/**
 * Apply layer-owned hue and composed aircraft alpha to an ambient glTF model without
 * disturbing Cesium's existing MIX/colorBlendAmount presentation semantics.
 * @param {object} input
 * @param {object} input.model
 * @param {{withAlpha:(alpha:number)=>object}} input.baseColor
 * @param {number} input.alpha
 * @param {Partial<typeof DEFAULT_AIRCRAFT_RECESSION_PARAMS>} [input.params]
 * @returns {number} One when a color write occurred, otherwise zero.
 */
export function applyAircraftModelTreatment({
  model,
  baseColor,
  alpha,
  params,
}) {
  const tuning = resolvedParams(params);
  if (!model || !baseColor || !Number.isFinite(alpha)) return 0;
  if (
    Number.isFinite(model.color?.alpha) &&
    Math.abs(model.color.alpha - alpha) <= tuning.writeEpsilon &&
    model.color.red === baseColor.red &&
    model.color.green === baseColor.green &&
    model.color.blue === baseColor.blue
  )
    return 0;
  model.color = baseColor.withAlpha(alpha);
  return 1;
}
