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
 * The governor is O(1) passive: no per-frame work of its own, ever.
 *
 * Continuous mode runs at 30 frames a second while only slow live feeds hold
 * it and the camera is still (AMBIENT_OWNERS below), at the full rate
 * otherwise.
 */

let _viewer = null;
let _installed = false;
const _holds = new Set();

/**
 * Live feeds whose marks drift slowly across a parked view. While they are
 * the only animators and the camera is still, 30 frames a second looks the
 * same as 60 and halves the render work; any camera motion, tracking,
 * cockpit, camera verb, capture or other hold restores the full rate.
 */
const AMBIENT_OWNERS = new Set([
  'flights',
  'military',
  'ais-vessels',
  'satellites',
  'rocket-launches',
  'traffic',
  'transit',
  'military-awareness',
  'wind',
]);
const AMBIENT_FRAME_RATE = 30;
let _fullFrameRate = 60;
let _cameraMoving = false;
let _removeCameraListeners = null;

function applyFrameRate() {
  if (!_installed || !_viewer) return;
  let ambientOnly = _holds.size > 0 && !_cameraMoving;
  if (ambientOnly) {
    for (const owner of _holds) {
      if (!AMBIENT_OWNERS.has(owner)) {
        ambientOnly = false;
        break;
      }
    }
  }
  const target = ambientOnly ? AMBIENT_FRAME_RATE : _fullFrameRate;
  if (_viewer.targetFrameRate !== target) _viewer.targetFrameRate = target;
}

/** How long the camera must hold still before the ambient rate returns. */
const CAMERA_SETTLE_MS = 500;
/** Camera travel (m) and turn (1 − cos) that count as motion between frames. */
const CAMERA_MOVE_M = 0.05;
const CAMERA_TURN = 1e-7;

/**
 * Track camera motion from rendered frames. Cesium's moveStart/moveEnd pair
 * is unreliable here (a camera nudged by a few millimetres every frame never
 * raises moveEnd), so compare the pose after each frame instead: a few
 * multiplications, and only on frames that render anyway.
 */
function watchCameraMotion(viewer) {
  const camera = viewer.camera;
  const postRender = viewer.scene?.postRender;
  if (!camera || !postRender?.addEventListener) return null;
  const last = { x: 0, y: 0, z: 0, dx: 0, dy: 0, dz: 0 };
  let lastMoveAt = 0;
  const remove = postRender.addEventListener(() => {
    const p = camera.positionWC;
    const d = camera.directionWC;
    if (!p || !d) return;
    const now = performance.now();
    const moved = Math.hypot(p.x - last.x, p.y - last.y, p.z - last.z);
    const turned = 1 - (d.x * last.dx + d.y * last.dy + d.z * last.dz);
    if (moved > CAMERA_MOVE_M || turned > CAMERA_TURN) {
      lastMoveAt = now;
      last.x = p.x;
      last.y = p.y;
      last.z = p.z;
      last.dx = d.x;
      last.dy = d.y;
      last.dz = d.z;
    }
    const moving = now - lastMoveAt < CAMERA_SETTLE_MS;
    if (moving !== _cameraMoving) {
      _cameraMoving = moving;
      applyFrameRate();
    }
  });
  return () => {
    remove?.();
    _removeCameraListeners = null;
  };
}

/** Debug trail of the most recent one-shot render requests (idle mode only). */
const _recentRequests = [];
const RECENT_REQUEST_CAP = 16;

function applyMode() {
  if (!_installed || !_viewer?.scene) return;
  applyFrameRate();
  const continuous = _holds.size > 0;
  const scene = _viewer.scene;
  if (scene.requestRenderMode === !continuous) return;
  scene.requestRenderMode = !continuous;
  if (!continuous) {
    // Entering idle: render one settling frame so anything the last
    // continuous frame mutated is on screen before the loop stops.
    scene.requestRender?.();
  }
}

/**
 * Install the governor on the viewer. Idempotent. Before install,
 * hold/release still record into the holds set (and apply at install time);
 * requests are safe no-ops — so modules can call all three unconditionally
 * in tests without a viewer.
 * @param {Cesium.Viewer} viewer
 * @returns {void}
 */
export function installRenderGovernor(viewer) {
  if (!viewer?.scene)
    throw new TypeError('installRenderGovernor requires a Cesium viewer');
  if (_viewer !== viewer) {
    _removeCameraListeners?.();
    _fullFrameRate = Number(viewer.targetFrameRate) || 60;
    _removeCameraListeners = watchCameraMotion(viewer);
  }
  _viewer = viewer;
  _installed = true;
  // Never let Cesium re-render on simulation-time deltas behind our back —
  // idle means idle. All re-renders are camera/tiles (Cesium-native) or
  // explicit requests.
  viewer.scene.maximumRenderTimeChange = Infinity;
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
    cameraMoving: _cameraMoving,
    recentRequests: [..._recentRequests],
  };
}

/** Release the installed viewer after its animation owners have stopped. */
export function uninstallRenderGovernor(viewer) {
  if (_viewer !== viewer) return;
  _removeCameraListeners?.();
  _cameraMoving = false;
  if (viewer) viewer.targetFrameRate = _fullFrameRate;
  _viewer = null;
  _installed = false;
  _holds.clear();
  _recentRequests.length = 0;
}

/** Test seam: reset module state between unit tests. */
export function _resetRenderGovernorForTest() {
  _removeCameraListeners?.();
  _cameraMoving = false;
  _fullFrameRate = 60;
  _viewer = null;
  _installed = false;
  _holds.clear();
  _recentRequests.length = 0;
}
