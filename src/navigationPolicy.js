/**
 * Camera-ownership policy for explicit and deferred navigation.
 *
 * Immediate destinations refuse Cockpit before mutation, then stamp, release,
 * and fly. Deferred destinations stamp without releasing; after resolution
 * they must recheck the stamp and Cockpit immediately before releasing and
 * flying.
 */

import { t, msg } from './i18n/index.js';

export const NAVIGATION_AUTHORITY_EVENT = 'gev:navigation-authority-taken';

// The Cockpit refusal per destination noun. Nouns are English identifiers
// from the callers ('camera', 'location', 'photo'…);
// navigationPolicyFrame.test.mjs collects every noun the callers pass and
// fails when one has no sentence here.
const COCKPIT_REFUSALS = Object.freeze({
  camera: msg('Exit cockpit to fly to a camera'),
  location: msg('Exit cockpit to fly to a location'),
  photo: msg('Exit cockpit to fly to a photo'),
  'shared view': msg('Exit cockpit to fly to a shared view'),
  target: msg('Exit cockpit to fly to a target'),
  vessel: msg('Exit cockpit to fly to a vessel'),
  fire: msg('Exit cockpit to fly to a fire'),
  route: msg('Exit cockpit to fly to a route'),
  file: msg('Exit cockpit to fly to a file'),
  scene: msg('Exit cockpit to fly to a scene'),
  // Radar, satellite and lightning fly to the layer's coverage area (their
  // «View coverage» button); the cyclone layer flies to the selected storm.
  weather: msg('Exit cockpit to view weather coverage'),
  cyclone: msg('Exit cockpit to fly to a cyclone'),
  // Voice track_entity (TRACKABLE_FAMILIES kinds in gevActions.js) and
  // frame_overhead, which frames the contacts around the current view.
  aircraft: msg('Exit cockpit to fly to an aircraft'),
  satellite: msg('Exit cockpit to fly to a satellite'),
  frame: msg('Exit cockpit to frame contacts'),
});

/** The destination nouns with their own Cockpit refusal (for tests). */
export const COCKPIT_REFUSAL_NOUNS = Object.freeze(
  Object.keys(COCKPIT_REFUSALS),
);

function cockpitRefusal(noun) {
  return t(COCKPIT_REFUSALS[noun]);
}

/**
 * Announce that a layer-owned camera flight is taking navigation authority.
 *
 * Aircraft focus reaches the stamp for free: it assigns `viewer.trackedEntity`,
 * and the UI stamps on `trackedEntityChanged`. Vessel and installation focus
 * fly the camera WITHOUT ever setting a tracked entity, so they have no such
 * seam — an earlier deferred geocode would still match the generation it
 * captured and could resolve on top of the new Context focus. This is that
 * missing seam, kept explicit so the flight and the stamp cannot drift apart.
 * @param {string} reason Diagnostic label for the taking path.
 * @param {object} [options] Authority options.
 * @param {EventTarget} [options.eventTarget=globalThis.window] Dispatch target.
 * @param {boolean} [options.cancelPendingSelection=true] Whether this is newer
 * direct intent that may supersede a passive selected-entity restore.
 * @returns {boolean} Whether the announcement was dispatched.
 */
export function announceNavigationAuthority(
  reason,
  { eventTarget = globalThis.window, cancelPendingSelection = true } = {},
) {
  if (typeof eventTarget?.dispatchEvent !== 'function') return false;
  eventTarget.dispatchEvent(
    new CustomEvent(NAVIGATION_AUTHORITY_EVENT, {
      detail: {
        reason: String(reason || 'layer-focus'),
        cancelPendingSelection: Boolean(cancelPendingSelection),
      },
    }),
  );
  return true;
}

/**
 * Register one authority listener and return an idempotent disposer.
 * @param {EventTarget} eventTarget Listener host.
 * @param {Function} listener Authority handler.
 * @returns {() => void} Idempotent disposer.
 */
export function registerNavigationAuthorityListener(eventTarget, listener) {
  if (
    !eventTarget?.addEventListener ||
    !eventTarget?.removeEventListener ||
    typeof listener !== 'function'
  )
    return () => {};
  eventTarget.addEventListener(NAVIGATION_AUTHORITY_EVENT, listener);
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    eventTarget.removeEventListener(NAVIGATION_AUTHORITY_EVENT, listener);
  };
}

/**
 * Let a physical globe gesture supersede the delayed shared camera and Follow.
 * Ordinary layer visibility/options remain authoritative, but camera intent
 * from the recipient always wins over a passive selected-subject restore.
 * @param {Function} stamp Navigation stamp callback.
 * @returns {*} The callback result, when present.
 */
export function stampInitialShareGesture(stamp) {
  return stamp?.({ cancelPendingSelection: true });
}

/**
 * Run an immediate explicit camera navigation.
 * @param {Object} options
 * @returns {*} Navigation result, or false when disposed or Cockpit refuses.
 */
export function runExplicitNavigation({
  disposed = false,
  cockpitActive = false,
  noun = 'target',
  showToast,
  stamp,
  release,
  navigate,
} = {}) {
  if (disposed) return false;
  if (cockpitActive) {
    showToast?.(cockpitRefusal(noun));
    return false;
  }
  const generation = stamp?.();
  release?.();
  return navigate?.(generation);
}

/**
 * Accept a deferred navigation intent without releasing the current owner.
 * @param {Object} options
 * @returns {number|false} Generation stamp, or false when disposed or Cockpit refuses.
 */
export function beginDeferredNavigation({
  disposed = false,
  cockpitActive = false,
  noun = 'location',
  showToast,
  stamp,
} = {}) {
  if (disposed) return false;
  if (cockpitActive) {
    showToast?.(cockpitRefusal(noun));
    return false;
  }
  return stamp?.();
}

/**
 * Re-assert authority immediately before a deferred flight.
 * @param {Object} options
 * @returns {boolean} Whether the deferred flight still owns the camera.
 */
export function reassertNavigationHandoff({
  generation,
  currentGeneration,
  cockpitActive = false,
  disposed = false,
  showToast,
  release,
} = {}) {
  if (disposed || generation !== currentGeneration) return false;
  if (cockpitActive) {
    showToast?.(cockpitRefusal('location'));
    return false;
  }
  release?.();
  return true;
}
