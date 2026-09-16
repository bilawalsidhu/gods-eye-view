/**
 * Idle render governor — the wave-2 flagship of the 2026-08-05 perf
 * investigation and the production idle-render measurements.
 *
 * The problem: Cesium's default render loop repaints every vsync forever, so
 * the app burned ~60% GPU + ~54% of a core with ZERO layers enabled and a
 * parked camera. The fix: flip the scene into Cesium's `requestRenderMode`
 * whenever nothing animates per frame, and return to the continuous loop the
 * moment something does.
 *
 * Architecture — a binary mode driven by ref-counted holds:
 *
 * - **Continuous mode** (`requestRenderMode = false`, today's behavior)
 *   while ANY hold is registered. Every per-frame animator — fleet
 *   interpolation, traffic sim, satellite motion, tracked-entity follow,
 *   style crossfades, CCTV projection — registers a hold for exactly the
 *   lifetime of its scene-loop listener or animation. While one is active,
 *   behavior is byte-identical to pre-governor main: the locked
 *   interpolation/tracking invariants are preserved by construction.
 * - **Idle mode** (`requestRenderMode = true`) when zero holds. Cesium
 *   auto-renders on camera input and tile loads; every other scene mutation
 *   must call `governorRequestRender()` for its one frame. Discrete
 *   mutators (layer poll ticks, slider writes, annotation changes) route
 *   through that.
 *
 * Holds are identity-keyed (a Set of owner ids), NOT a counter — a module
 * that double-holds or double-releases cannot corrupt the mode. Owners are
 * short stable strings ('flights', 'traffic', 'style-anim', …) so the
 * diagnostics read like a story.
 *
 * The governor is O(1) passive: no per-frame work of its own, ever.
 */

/** Milliseconds to keep continuous mode alive after the last hold releases.
 *  Prevents oscillation when a module briefly releases and re-acquires a hold
 *  within a short window (e.g. a rapid enable/disable cycle). */
const CONTINUOUS_COOLDOWN_MS = 100;

/** App baseline render-loop rate (set at boot in main.js; the governor owns
 *  the knob from install onward). */
export const BASE_TARGET_FRAME_RATE = 60;

/**
 * Scene frame rate while the ONLY continuous-render holder is the style
 * animation loop and the camera is still (Phase 9 Batch P). The style
 * shaders are wall-clock-timed, so 30 fps is visually identical for them
 * and halves the idle GPU cost of a retro/CRT-styled boot (the default
 * style keeps such a hold alive forever). Any second hold, any camera
 * motion, or full idle restores the baseline immediately.
 */
export const STYLE_ANIM_LOW_DEMAND_FPS = 30;

/** Owner id of the style loop's continuous-render hold (src/ui.js). */
export const STYLE_ANIM_OWNER_ID = 'style-anim';

let _viewer = null;
let _installed = false;
const _holds = new Set();

/** Timer handle for the continuous→idle transition delay. */
let _idleTransitionTimer = null;

/**
 * Camera-motion flag backing the low-demand policy. Starts TRUE at install
 * on purpose: boot flies the camera (flyToAustin / share-link restore) and
 * `camera.moveStart` may already have fired before we subscribe — assuming
 * "moving" until the first observed `moveEnd` keeps the boot flight at the
 * baseline rate instead of dropping it to 30 fps mid-animation.
 */
let _cameraActive = true;
let _cameraMoveStartRemover = null;
let _cameraMoveEndRemover = null;

/** Debug trail of the most recent one-shot render requests (idle mode only). */
const _recentRequests = [];
const RECENT_REQUEST_CAP = 16;

/**
 * Pure frame-rate decision for the current governor state.
 * @param {object} [options] - Governor state snapshot (defaults to the live module state).
 * @param {string[]} [options.holds] Active hold owner ids.
 * @param {boolean} [options.cameraActive] Whether camera motion is underway.
 * @param {number} [options.baseFps] Baseline loop rate.
 * @param {number} [options.lowDemandFps] Rate when style-anim is the only
 *   holder and the camera is still.
 * @returns {number} targetFrameRate the viewer should run at.
 */
export function resolveGovernorTargetFrameRate({
  holds = [],
  cameraActive = false,
  baseFps = BASE_TARGET_FRAME_RATE,
  lowDemandFps = STYLE_ANIM_LOW_DEMAND_FPS,
} = {}) {
  if (cameraActive) return baseFps;
  return holds.length === 1 && holds[0] === STYLE_ANIM_OWNER_ID ? lowDemandFps : baseFps;
}

/**
 * Push the resolved target frame rate onto the viewer when it changed. Cheap
 * enough to call on every hold/camera transition.
 * @returns {void}
 */
function applyFrameRatePolicy() {
  if (!_installed || !_viewer) return;
  const next = resolveGovernorTargetFrameRate({ holds: [..._holds], cameraActive: _cameraActive });
  if (_viewer.targetFrameRate !== next) _viewer.targetFrameRate = next;
}

/**
 * Reconcile Cesium's requestRenderMode with the hold set: continuous while any
 * hold exists, idle otherwise (with one settling frame on entry). No-op before
 * install. `_forceImmediate` is accepted for call-site symmetry with
 * releaseContinuousRender but makes no difference — the mode itself is applied
 * synchronously either way.
 *
 * @param {boolean} [_forceImmediate] Unused; see above.
 * @returns {void}
 */
function applyMode(_forceImmediate = false) {
  if (!_installed || !_viewer?.scene) return;
  const continuous = _holds.size > 0;
  const scene = _viewer.scene;
  if (scene.requestRenderMode === !continuous) {
    applyFrameRatePolicy(); // mode steady, but the hold set may have changed shape
    return;
  }
  scene.requestRenderMode = !continuous;
  applyFrameRatePolicy();
  if (!continuous) {
    // Entering idle: render one settling frame so anything the last
    // continuous frame mutated is on screen before the loop stops.
    scene.requestRender?.();
  }
}

/** Schedule a transition to idle after a cooldown period. Cancels any pending transition. */
function scheduleIdleTransition() {
  if (_idleTransitionTimer !== null) return; // already scheduled
  _idleTransitionTimer = setTimeout(() => {
    _idleTransitionTimer = null;
    // Only transition if still truly idle (no holds acquired during cooldown)
    if (_holds.size === 0) applyMode(true);
  }, CONTINUOUS_COOLDOWN_MS);
}

/** Cancel any pending idle transition (called when a new hold is acquired). */
function cancelIdleTransition() {
  if (_idleTransitionTimer !== null) {
    clearTimeout(_idleTransitionTimer);
    _idleTransitionTimer = null;
  }
}

/**
 * Install the governor on the viewer. Idempotent. Before install,
 * hold/release still record into the holds set (and apply at install time);
 * requests are safe no-ops — so modules can call all three unconditionally
 * in tests without a viewer.
 * @param {import('cesium').Viewer} viewer - Viewer whose scene/camera the
 *   governor takes over (its `targetFrameRate` and `requestRenderMode`).
 * @returns {void}
 */
export function installRenderGovernor(viewer) {
  if (!viewer?.scene) throw new TypeError('installRenderGovernor requires a Cesium viewer');
  _viewer = viewer;
  _installed = true;
  // Never let Cesium re-render on simulation-time deltas behind our back —
  // idle means idle. All re-renders are camera/tiles (Cesium-native) or
  // explicit requests.
  viewer.scene.maximumRenderTimeChange = Infinity;
  // Camera-motion watch for the low-demand frame-rate policy. Cesium Event
  // listeners return a remover; guard for stubbed viewers in tests.
  const camera = viewer.scene.camera;
  if (camera?.moveStart?.addEventListener) {
    _cameraMoveStartRemover = camera.moveStart.addEventListener(() => {
      if (!_cameraActive) {
        _cameraActive = true;
        applyFrameRatePolicy();
      }
    });
  }
  if (camera?.moveEnd?.addEventListener) {
    _cameraMoveEndRemover = camera.moveEnd.addEventListener(() => {
      if (_cameraActive) {
        _cameraActive = false;
        applyFrameRatePolicy();
      }
    });
  }
  applyMode();
}

/**
 * Register a continuous-render hold. Idempotent per owner.
 * Call where the owner's per-frame work BEGINS (scene listener installed,
 * animation starts, tracking begins).
 * @param {string} ownerId Short stable id, e.g. 'flights', 'traffic'.
 * @returns {void}
 */
export function holdContinuousRender(ownerId) {
  if (!ownerId) return;
  cancelIdleTransition(); // cancel any pending idle transition
  _holds.add(ownerId);
  applyMode();
}

/**
 * Release a hold. Safe when never held.
 * Call where the owner's per-frame work ENDS (listener removed, animation
 * settled, tracking stopped, layer disabled). Schedules an idle transition
 * after a short cooldown so rapid re-acquisition doesn't cause oscillation.
 * @param {string} ownerId - Same stable id the hold was registered under.
 * @param {boolean} [immediate] - If true, transitions to idle synchronously (bypasses
 * the cooldown). Used by tests to keep behavior synchronous.
 * @returns {void}
 */
export function releaseContinuousRender(ownerId, immediate = false) {
  if (!ownerId) return;
  _holds.delete(ownerId);
  if (_holds.size === 0) {
    if (immediate) {
      cancelIdleTransition();
      applyMode(true);
    } else {
      scheduleIdleTransition();
    }
  } else {
    // Remaining holders may change the frame-rate policy's shape even though
    // the mode itself stays continuous (e.g. flights releases while the
    // style-anim low-demand hold remains).
    applyMode();
  }
}

/**
 * One-shot render request for a discrete scene mutation (layer tick, slider
 * write, annotation change). Always forwards to scene.requestRender() — in
 * continuous mode that is a harmless flag set (and forwarding closes the
 * request-then-last-release race); only idle-mode requests are recorded in
 * diagnostics. Cheap enough to call unconditionally after any mutation.
 * @param {string} [reason] For diagnostics only.
 * @returns {void}
 */
export function governorRequestRender(reason = 'unspecified') {
  if (!_installed || !_viewer?.scene) return;
  if (_holds.size === 0) {
    _recentRequests.push({ reason, at: Date.now() });
    if (_recentRequests.length > RECENT_REQUEST_CAP) _recentRequests.shift();
  }
  _viewer.scene.requestRender?.();
}

/**
 * @returns {{installed: boolean, mode: 'continuous'|'idle', holds: string[],
 *   recentRequests: Array<{reason: string, at: number}>, targetFrameRate: number|null,
 *   cameraActive: boolean}}
 *   Read-only snapshot of the governor for QA harnesses and the HUD: whether it
 *   is installed, the derived mode, sorted hold owners, the last idle-mode
 *   render requests, the live frame rate (null pre-install), and the
 *   camera-motion flag behind the low-demand policy.
 */
export function getRenderGovernorDiagnostics() {
  return {
    installed: _installed,
    mode: _holds.size > 0 ? 'continuous' : 'idle',
    holds: [..._holds].sort(),
    recentRequests: [..._recentRequests],
    targetFrameRate: _installed ? _viewer?.targetFrameRate ?? null : null,
    cameraActive: _cameraActive,
  };
}

/** Test seam: reset module state between unit tests. */
export function _resetRenderGovernorForTest() {
  if (_idleTransitionTimer !== null) {
    clearTimeout(_idleTransitionTimer);
    _idleTransitionTimer = null;
  }
  _cameraMoveStartRemover?.();
  _cameraMoveEndRemover?.();
  _cameraMoveStartRemover = null;
  _cameraMoveEndRemover = null;
  _cameraActive = true; // matches the install-time conservative default
  _viewer = null;
  _installed = false;
  _holds.clear();
  _recentRequests.length = 0;
}
