/**
 * Limb-relative recession for distant aircraft: the tuning the aircraft icon
 * and model sets recede by (`aircraftRecedeSpec`), and the factors and alpha
 * those sets draw with, for evidence and checks.
 *
 * It multiplies an icon's ordinary scale, which composes with its locked
 * NearFarScalar. It never edits that scalar, culls a contact, or allows alpha
 * to reach zero. The maths is the Cesium-free `render/recession.js`,
 * which the sets drawing aircraft recede by (`SetSpec.recede`).
 */
import {
  RECEDE_DEFAULTS,
  limbDistanceM,
  recedeFactors,
  recedeFrame,
  recedeParams,
  recededAlpha,
} from '../render/recession.js';

export const DEFAULT_AIRCRAFT_RECESSION_PARAMS = Object.freeze({
  ...RECEDE_DEFAULTS,
  writeEpsilon: 0.005,
});

let _params = { ...DEFAULT_AIRCRAFT_RECESSION_PARAMS };
const _scratchFactors = { scale: 1, alpha: 1, limbRatio: null };
const _scratchFrame = { active: false, limbM: 1, strength: 0 };
// The tuning `_recede` was made from, and the set option made from it.
let _recedeFor = null;
let _recede = null;

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
  return recedeFactors(
    cameraDistanceM,
    recedeFrame(cameraHeightM, tuning, _scratchFrame),
    tuning,
    result,
  );
}

/**
 * Patch runtime taper tuning for evidence capture/A-B work.
 * @param {Partial<typeof DEFAULT_AIRCRAFT_RECESSION_PARAMS>} [patch]
 * @returns {typeof DEFAULT_AIRCRAFT_RECESSION_PARAMS}
 */
export function setAircraftRecessionParams(patch = {}) {
  // Backward-compatible evidence override: the former hard threshold now
  // names the identity end of the blend band.
  const given = Number.isFinite(patch.globeViewHeightM)
    ? { ...patch, globeViewBlendEndM: patch.globeViewHeightM }
    : patch;
  const next = {
    ...recedeParams(given, _params),
    writeEpsilon: _params.writeEpsilon,
  };
  if (Number.isFinite(patch.writeEpsilon))
    next.writeEpsilon = Math.max(0, patch.writeEpsilon);
  _params = next;
  return { ..._params };
}

/**
 * The tuning as the `recede` of the sets that draw aircraft: the same
 * object until the tuning changes.
 * @returns {import('../render/contract/index').RecedeSpec}
 */
export function aircraftRecedeSpec() {
  if (_recedeFor !== _params) {
    _recedeFor = _params;
    _recede = Object.freeze(recedeParams(_params));
  }
  return _recede;
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
export const cameraLimbDistanceM = limbDistanceM;

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
  return baseAlpha * recededAlpha(focusFactor, factors.alpha, tuning);
}

/**
 * Apply layer-owned hue and composed aircraft alpha to an ambient glTF model without
 * changing the model's colour blend mode or amount.
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
