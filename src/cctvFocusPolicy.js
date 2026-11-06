/**
 * Activates the nearest CCTV record on layer enable and flies only when no
 * followed target or cockpit camera owns the view.
 * @param {Object} options Layer-enable focus inputs.
 * @param {*} options.followed What the camera follows, if anything
 *   (`followedOf`).
 * @param {boolean} options.cockpitActive Whether cockpit mode owns the camera.
 * @param {() => (string|null)} options.activate Nearest-camera activation.
 * @param {(cameraId: string) => *} options.fly Optional camera flight.
 * @returns {*} Activated camera ID for a held view, or the flight result.
 */
export function runCctvLayerEnableFocus({
  followed = null,
  cockpitActive = false,
  activate,
  fly,
} = {}) {
  const cameraId = activate?.();
  if (!cameraId) return false;
  if (followed || cockpitActive) return cameraId;
  return fly?.(cameraId);
}

/**
 * Merges camera ownership sampled on both sides of the awaited layer-enable
 * chain. Either observation suppresses the optional CCTV focus flight.
 * @param {Object} [before={}] Ownership immediately before the await.
 * @param {Object} [after={}] Ownership immediately after the await.
 * @returns {{ followed: *, cockpitActive: boolean }} Conservative ownership.
 */
function mergeCctvEnableOwnership(before = {}, after = {}) {
  return {
    followed: before.followed || after.followed || null,
    cockpitActive: !!(before.cockpitActive || after.cockpitActive),
  };
}

/**
 * Runs the awaited CCTV layer transition while preserving camera ownership
 * observed on either side for the optional enable-focus policy.
 *
 * @param {Object} options Transition dependencies.
 * @param {boolean} options.target Requested enabled state.
 * @param {(target: boolean) => Promise<*>} options.setEnabled Layer transition.
 * @param {() => Object} options.readOwnership Current tracked/cockpit state.
 * @param {() => boolean} options.shouldFocus Post-transition focus predicate.
 * @param {() => (string|null)} options.activate Nearest-camera activation.
 * @param {(cameraId: string) => *} options.fly Optional camera flight.
 * @param {Function} [options.debug] Diagnostic sink.
 * @returns {Promise<*>} Focus-policy result, or null when no focus was requested.
 */
export async function runCctvLayerEnableTransition({
  target,
  setEnabled,
  readOwnership,
  shouldFocus,
  activate,
  fly,
  debug = console.debug,
}) {
  const ownershipBefore = readOwnership?.() || {};
  if (target === true) {
    debug?.('[UI:CCTV] ownership before setEnabled await', {
      trackedId: ownershipBefore.followed?.key ?? null,
      cockpitActive: !!ownershipBefore.cockpitActive,
    });
  }
  await setEnabled?.(target);
  const ownershipAfter = readOwnership?.() || {};
  if (target === true) {
    debug?.('[UI:CCTV] ownership after setEnabled await', {
      trackedId: ownershipAfter.followed?.key ?? null,
      cockpitActive: !!ownershipAfter.cockpitActive,
    });
  }
  if (!target || !shouldFocus?.()) return null;
  return runCctvLayerEnableFocus({
    ...mergeCctvEnableOwnership(ownershipBefore, ownershipAfter),
    activate,
    fly,
  });
}
