/**
 * Limb-relative recession for distant aircraft billboards.
 *
 * This multiplies the billboard's ordinary scale, which Cesium then composes
 * with the locked NearFarScalar. It never edits that scalar, culls a contact,
 * or allows alpha to reach zero.
 */

export const DEFAULT_AIRCRAFT_RECESSION_PARAMS = Object.freeze({
  startLimbRatio: 0.5,
  scaleFloor: 0.45,
  alphaFloor: 0.35,
  combinedAlphaFloor: 0.20,
  globeViewBlendStartM: 3_500_000,
  globeViewBlendEndM: 4_500_000,
  earthRadiusM: 6_378_137,
  writeEpsilon: 0.005,
});

let _params = { ...DEFAULT_AIRCRAFT_RECESSION_PARAMS };
const _scratchFactors = { scale: 1, alpha: 1, limbRatio: null };
const _treatmentResult = {
  scale: 1,
  alpha: 1,
  scaleWrites: 0,
  alphaWrites: 0,
  factors: _scratchFactors,
};

/**
 * Clamp a value into a closed range.
 * @param {number} value Value to constrain.
 * @param {number} min Inclusive lower bound.
 * @param {number} max Inclusive upper bound; assumed >= `min`.
 * @returns {number} `value` bounded to [min, max], or a bound when it lies outside.
 */
function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/**
 * Merge caller overrides over the module tuning without mutating module state.
 * @param {Partial<typeof DEFAULT_AIRCRAFT_RECESSION_PARAMS>|undefined} overrides
 *   Per-call tuning, e.g. from a unit test. The live `_params` reference (or a
 *   falsy value) short-circuits to the cached object so the hot path allocates
 *   nothing.
 * @returns {typeof DEFAULT_AIRCRAFT_RECESSION_PARAMS} Effective tuning for this call.
 */
function resolvedParams(overrides) {
  if (!overrides || overrides === _params) return _params;
  return { ..._params, ...overrides };
}

/**
 * Compute limb-relative recession factors into a caller-supplied accumulator.
 * @param {number} cameraDistanceM Distance from camera to the sprite in metres;
 *   non-finite or negative disables the taper.
 * @param {number} cameraHeightM Camera height above the ellipsoid in metres;
 *   must be inside the (0, globeViewBlendEndM) band.
 * @param {typeof DEFAULT_AIRCRAFT_RECESSION_PARAMS} tuning Effective taper tuning.
 * @param {{scale:number, alpha:number, limbRatio:(number|null)}} result
 *   Scratch object written in place so the per-frame path allocates nothing.
 * @returns {{scale:number, alpha:number, limbRatio:(number|null)}} The same
 *   `result` object: identity factors with `limbRatio: null` when the taper is
 *   inactive, otherwise the smoothstep-eased multipliers against the limb.
 */
function aircraftRecessionFactorsResolved(cameraDistanceM, cameraHeightM, tuning, result) {
  if (!Number.isFinite(cameraDistanceM) || cameraDistanceM < 0
    || !Number.isFinite(cameraHeightM) || cameraHeightM <= 0
    || cameraHeightM >= tuning.globeViewBlendEndM) {
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

  const rawT = (limbRatio - tuning.startLimbRatio) / (1 - tuning.startLimbRatio);
  const t = clamp(rawT, 0, 1);
  const limbEase = t * t * (3 - 2 * t); // smoothstep: zero slope at both band edges
  const globeRawT = (cameraHeightM - tuning.globeViewBlendStartM)
    / (tuning.globeViewBlendEndM - tuning.globeViewBlendStartM);
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
 * @param {Partial<typeof DEFAULT_AIRCRAFT_RECESSION_PARAMS>} [patch] Tuning
 *   overrides; unknown keys and non-finite values are ignored, and every
 *   recognized key is re-clamped to its documented range.
 * @returns {typeof DEFAULT_AIRCRAFT_RECESSION_PARAMS} A defensive copy of the
 *   tuning now in effect, so later `set` calls cannot mutate a captured snapshot.
 */
export function setAircraftRecessionParams(patch = {}) {
  const next = { ..._params };
  if (Number.isFinite(patch.startLimbRatio)) {
    next.startLimbRatio = clamp(patch.startLimbRatio, 0, 0.99);
  }
  if (Number.isFinite(patch.scaleFloor)) next.scaleFloor = clamp(patch.scaleFloor, 0.05, 1);
  if (Number.isFinite(patch.alphaFloor)) next.alphaFloor = clamp(patch.alphaFloor, 0.05, 1);
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
  if (Number.isFinite(patch.earthRadiusM)) next.earthRadiusM = Math.max(1, patch.earthRadiusM);
  if (Number.isFinite(patch.writeEpsilon)) next.writeEpsilon = Math.max(0, patch.writeEpsilon);
  _params = next;
  return { ..._params };
}

/** @returns {typeof DEFAULT_AIRCRAFT_RECESSION_PARAMS} Current tuning. */
export function getAircraftRecessionParams() {
  return _params;
}

/**
 * Straight-line tangent distance from a camera above a spherical Earth to its
 * geometric limb. The WGS84 semi-major radius is sufficient for a visual
 * taper; the occluder remains the authoritative far-side visibility test.
 * @param {number} cameraHeightM Camera altitude above the ellipsoid in metres;
 *   non-positive yields NaN so callers can treat the answer as "no limb".
 * @param {number} [earthRadiusM] Sphere radius to use; defaults to the WGS84
 *   semi-major axis.
 * @returns {number} Tangent (slant) distance to the horizon in metres.
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
 * @param {object} input Camera-relative geometry for one aircraft.
 * @param {number} input.cameraDistanceM Sprite-to-camera distance.
 * @param {number} input.cameraHeightM Camera height above the ellipsoid.
 * @param {Partial<typeof DEFAULT_AIRCRAFT_RECESSION_PARAMS>} [params] Tuning
 *   override for tests and A-B capture; omitted means the module tuning.
 * @returns {{scale:number,alpha:number,limbRatio:number|null}} Fresh multiplier
 *   object each call — safe to retain, unlike the treatment helper's result.
 */
export function aircraftRecessionFactors({ cameraDistanceM, cameraHeightM }, params) {
  const tuning = resolvedParams(params);
  return aircraftRecessionFactorsResolved(
    cameraDistanceM,
    cameraHeightM,
    tuning,
    { scale: 1, alpha: 1, limbRatio: null },
  );
}

/**
 * Production wire helper: compose base scale/alpha, focus emphasis, and limb
 * recession into one deadband-gated billboard write site.
 * @param {object} input The billboard to write plus the look it should carry.
 * @param {object} input.billboard Cesium BillboardCollection billboard, mutated
 *   in place only where the change exceeds `writeEpsilon`.
 * @param {number} input.baseScale Untapered sprite scale.
 * @param {number} input.baseAlpha Untapered sprite alpha, already including the
 *   keyhole.
 * @param {{withAlpha:(alpha:number)=>object}} input.baseColor Color object whose
 *   `withAlpha` produces the tinted color assigned to the billboard.
 * @param {number} input.focusFactor Focus-emphasis multiplier in [0, 1].
 * @param {number} input.cameraDistanceM Sprite-to-camera distance in metres.
 * @param {number} input.cameraHeightM Camera altitude in metres.
 * @param {Partial<typeof DEFAULT_AIRCRAFT_RECESSION_PARAMS>} [input.params]
 *   Tuning override; omitted means the module tuning.
 *
 * IMPORTANT: the returned object (including `factors`) is a module-owned
 * mutable singleton. Consume every needed property before the next call;
 * never retain it as a snapshot.
 * @returns {{scale:number,alpha:number,scaleWrites:number,alphaWrites:number,factors:object}}
 *   Composed scale/alpha actually applied, one flag per property that crossed
 *   the deadband and was written, and the raw recession factors.
 */
export function applyAircraftBillboardTreatment({
  billboard,
  baseScale,
  baseAlpha,
  baseColor,
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
  const scale = baseScale * factors.scale;
  const composedTreatment = Math.max(
    tuning.combinedAlphaFloor,
    clamp(focusFactor, 0, 1) * factors.alpha,
  );
  const alpha = baseAlpha * composedTreatment;
  let scaleWrites = 0;
  let alphaWrites = 0;
  if (!Number.isFinite(billboard.scale) || Math.abs(billboard.scale - scale) > tuning.writeEpsilon) {
    billboard.scale = scale;
    scaleWrites = 1;
  }
  if (!Number.isFinite(billboard.color?.alpha)
    || Math.abs(billboard.color.alpha - alpha) > tuning.writeEpsilon) {
    billboard.color = baseColor.withAlpha(alpha);
    alphaWrites = 1;
  }
  _treatmentResult.scale = scale;
  _treatmentResult.alpha = alpha;
  _treatmentResult.scaleWrites = scaleWrites;
  _treatmentResult.alphaWrites = alphaWrites;
  return _treatmentResult;
}

/**
 * Apply the already-composed aircraft alpha to an ambient glTF model without
 * disturbing Cesium's existing MIX/colorBlendAmount presentation semantics.
 * @param {object} input The model to tint plus the alpha already composed for
 *   its billboard.
 * @param {object} input.model Cesium model entity, mutated in place.
 * @param {{withAlpha:(alpha:number)=>object}} input.baseColor Base color whose
 *   `withAlpha` builds the replacement color.
 * @param {number} input.alpha Final aircraft alpha from the billboard pass.
 * @param {Partial<typeof DEFAULT_AIRCRAFT_RECESSION_PARAMS>} [input.params]
 *   Tuning override; only `writeEpsilon` is consulted here.
 * @returns {number} One when a color write occurred, otherwise zero.
 */
export function applyAircraftModelTreatment({ model, baseColor, alpha, params }) {
  const tuning = resolvedParams(params);
  if (!model || !baseColor || !Number.isFinite(alpha)) return 0;
  if (Number.isFinite(model.color?.alpha)
    && Math.abs(model.color.alpha - alpha) <= tuning.writeEpsilon) return 0;
  model.color = baseColor.withAlpha(alpha);
  return 1;
}
