/**
 * Idle render governor — the wave-2 flagship of the 2026-08-05 perf
 * investigation.
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
 * Frame rate: in continuous mode the viewer draws at the display's own
 * refresh rate (no `targetFrameRate`). In idle mode it is capped at
 * IDLE_FRAME_RATE, because Cesium still ticks the clock, data sources and
 * every pre/post-update listener once per animation frame even when it skips
 * the draw. Camera movement takes a 'camera' hold from `moveStart` to
 * `moveEnd`, so drags and flights run at the full rate too.
 *
 * The governor is O(1) passive: no per-frame work of its own, ever.
 */

/** Frames a second the viewer ticks while nothing moves. */
export const IDLE_FRAME_RATE = 60;

let _viewer = null;
let _installed = false;
const _holds = new Set();
/** Removes the camera move listeners added at install. */
let _removeCameraListeners = null;

/** Debug trail of the most recent one-shot render requests (idle mode only). */
const _recentRequests = [];
const RECENT_REQUEST_CAP = 16;

function applyMode() {
  if (!_installed || !_viewer?.scene) return;
  const continuous = _holds.size > 0;
  const scene = _viewer.scene;
  _viewer.targetFrameRate = continuous ? undefined : IDLE_FRAME_RATE;
  if (scene.requestRenderMode === !continuous) return;
  scene.requestRenderMode = !continuous;
  if (!continuous) {
    // Entering idle: render one settling frame so anything the last
    // continuous frame mutated is on screen before the loop stops.
    scene.requestRender?.();
  }
}

/** Pose sampling while the camera moves (see watchCameraMotion). */
const CAMERA_SAMPLE_MS = 250;
const CAMERA_POSITION_TOLERANCE_M = 1e-3;
const CAMERA_DIRECTION_TOLERANCE = 1e-9;

function near(a, b, tolerance) {
  return (
    Math.abs(a.x - b.x) <= tolerance &&
    Math.abs(a.y - b.y) <= tolerance &&
    Math.abs(a.z - b.z) <= tolerance
  );
}

/**
 * Hold continuous render while the camera moves. Cesium's `moveStart` takes
 * the hold and `moveEnd` releases it. Cesium compares the pose with the last
 * frame's to the last rounding error, and at some poses the camera drifts by
 * a rounding error every frame, so `moveEnd` never comes (see
 * `installGlobeInViewRecovery` in app/viewer.js). So from `moveStart` until
 * `moveEnd` the pose is also sampled every 250 ms with a tolerance for that
 * drift: half a second at rest releases the hold and a later move takes it
 * again (Cesium raises no new `moveStart` under that drift). Sampling runs
 * until `moveEnd`, however long that takes; it costs four checks a second.
 * @returns {(() => void)|null} Removes the listeners and the sampling.
 */
function watchCameraMotion(camera, { schedule, unschedule }) {
  if (!camera?.moveStart || !camera?.moveEnd) return null;
  const last = { position: null, direction: null };
  let timer = null;
  let restingSamples = 0;
  const copy = (v) => (v ? { x: v.x, y: v.y, z: v.z } : null);
  const remember = () => {
    last.position = copy(camera.positionWC);
    last.direction = copy(camera.directionWC);
  };
  const stopSampling = () => {
    if (timer !== null) unschedule(timer);
    timer = null;
  };
  const sample = () => {
    timer = null;
    const position = camera.positionWC;
    const direction = camera.directionWC;
    const atRest =
      !position ||
      !direction ||
      !last.position ||
      (near(position, last.position, CAMERA_POSITION_TOLERANCE_M) &&
        near(direction, last.direction, CAMERA_DIRECTION_TOLERANCE));
    if (atRest) {
      restingSamples += 1;
      if (restingSamples >= 2) releaseContinuousRender('camera');
    } else {
      restingSamples = 0;
      holdContinuousRender('camera');
    }
    remember();
    timer = schedule(sample, CAMERA_SAMPLE_MS);
  };
  const removeStart = camera.moveStart.addEventListener(() => {
    holdContinuousRender('camera');
    stopSampling();
    restingSamples = 0;
    remember();
    timer = schedule(sample, CAMERA_SAMPLE_MS);
  });
  const removeEnd = camera.moveEnd.addEventListener(() => {
    stopSampling();
    releaseContinuousRender('camera');
  });
  return () => {
    stopSampling();
    removeStart();
    removeEnd();
  };
}

/**
 * Install the governor on the viewer. Idempotent. Before install,
 * hold/release still record into the holds set (and apply at install time);
 * requests are safe no-ops — so modules can call all three unconditionally
 * in tests without a viewer.
 * @param {Cesium.Viewer} viewer
 * @param {{setTimeout?: Function, clearTimeout?: Function}} [timers] Injectable
 *   timers for tests.
 * @returns {void}
 */
export function installRenderGovernor(
  viewer,
  {
    setTimeout: schedule = globalThis.setTimeout,
    clearTimeout: unschedule = globalThis.clearTimeout,
  } = {},
) {
  const timers = { schedule, unschedule };
  if (!viewer?.scene)
    throw new TypeError('installRenderGovernor requires a Cesium viewer');
  _viewer = viewer;
  _installed = true;
  // Never let Cesium re-render on simulation-time deltas behind our back —
  // idle means idle. All re-renders are camera/tiles (Cesium-native) or
  // explicit requests.
  viewer.scene.maximumRenderTimeChange = Infinity;
  _removeCameraListeners?.();
  _holds.delete('camera');
  _removeCameraListeners = watchCameraMotion(
    viewer.camera ?? viewer.scene.camera,
    timers,
  );
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
  _holds.add(ownerId);
  applyMode();
}

/**
 * Release a hold. Safe when never held.
 * Call where the owner's per-frame work ENDS (listener removed, animation
 * settled, tracking stopped, layer disabled).
 * @param {string} ownerId
 * @returns {void}
 */
export function releaseContinuousRender(ownerId) {
  if (!ownerId) return;
  _holds.delete(ownerId);
  applyMode();
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
 *   recentRequests: Array<{reason: string, at: number}>}}
 */
export function getRenderGovernorDiagnostics() {
  return {
    installed: _installed,
    mode: _holds.size > 0 ? 'continuous' : 'idle',
    holds: [..._holds].sort(),
    recentRequests: [..._recentRequests],
  };
}

/** Release the installed viewer after its animation owners have stopped. */
export function uninstallRenderGovernor(viewer) {
  if (_viewer !== viewer) return;
  _removeCameraListeners?.();
  _removeCameraListeners = null;
  _viewer = null;
  _installed = false;
  _holds.clear();
  _recentRequests.length = 0;
}

/** Test seam: reset module state between unit tests. */
export function _resetRenderGovernorForTest() {
  _removeCameraListeners?.();
  _removeCameraListeners = null;
  _viewer = null;
  _installed = false;
  _holds.clear();
  _recentRequests.length = 0;
}
