// src/data/cameraSensitivity.js
/**
 * Shared claims on `camera.percentageChanged`.
 *
 * `camera.changed` fires once the view has moved by this fraction, and it is a
 * single number on the camera that every listener in the app shares. Several
 * layers want it finer than the default — traffic, bikeshare and transit all
 * ask for 0.05 so they notice they have entered a coverage area — and each of
 * them used to write the number directly and hand back whatever it remembered.
 *
 * That cannot work, because a number is not an owner. Two layers asking for the
 * same 0.05 write the same value, so when the first one leaves it sees its own
 * number still in place, concludes nothing else has claimed it, and restores
 * the coarse default out from under a layer that is still running. The symptom
 * is a camera-driven layer that quietly stops noticing the camera: Transit is
 * turned off and Bikeshare stops loading new cities until something else nudges
 * it.
 *
 * So ownership is tracked explicitly. Claims are named, the camera gets the
 * finest value anyone has asked for, and the original value returns only when
 * the last claim is gone. Claiming twice under one name replaces that claim.
 *
 * This is bookkeeping, not policy: it never decides what a layer should ask
 * for, only that nobody's answer is taken away while they still need it.
 */

/** @type {WeakMap<object, {base: number, claims: Map<string, number>}>} */
const _cameras = new WeakMap();

/** The value Cesium starts a camera at, used when the camera reports nothing. */
const DEFAULT_PERCENTAGE_CHANGED = 0.5;

function ledgerFor(camera) {
  let ledger = _cameras.get(camera);
  if (!ledger) {
    const base = Number.isFinite(camera.percentageChanged)
      ? camera.percentageChanged
      : DEFAULT_PERCENTAGE_CHANGED;
    ledger = { base, claims: new Map() };
    _cameras.set(camera, ledger);
  }
  return ledger;
}

function applyLedger(camera, ledger) {
  let value = ledger.base;
  for (const claimed of ledger.claims.values()) {
    if (claimed < value) value = claimed;
  }
  camera.percentageChanged = value;
  return value;
}

/**
 * Ask for a camera-change sensitivity at least as fine as `value`.
 * @param {object|null|undefined} camera A Cesium camera (or anything with `percentageChanged`).
 * @param {string} owner Stable claim name, usually the layer id.
 * @param {number} value Requested `percentageChanged`.
 * @returns {number|null} The value now in force, or null when there is no camera.
 */
export function claimCameraSensitivity(camera, owner, value) {
  if (!camera || !owner || !Number.isFinite(value)) return null;
  const ledger = ledgerFor(camera);
  ledger.claims.set(owner, value);
  return applyLedger(camera, ledger);
}

/**
 * Give up one claim. The camera keeps the finest value still claimed by
 * somebody else, and returns to its original only when none are left.
 * @param {object|null|undefined} camera
 * @param {string} owner
 * @returns {number|null} The value now in force, or null when there is no camera.
 */
export function releaseCameraSensitivity(camera, owner) {
  if (!camera || !owner) return null;
  const ledger = _cameras.get(camera);
  if (!ledger) return null;
  if (!ledger.claims.delete(owner)) return camera.percentageChanged;
  const applied = applyLedger(camera, ledger);
  if (ledger.claims.size === 0) _cameras.delete(camera);
  return applied;
}

/**
 * Who currently holds a claim. For tests and diagnostics only.
 * @param {object|null|undefined} camera
 * @returns {Array<string>}
 */
export function cameraSensitivityClaims(camera) {
  const ledger = camera ? _cameras.get(camera) : null;
  return ledger ? [...ledger.claims.keys()] : [];
}
