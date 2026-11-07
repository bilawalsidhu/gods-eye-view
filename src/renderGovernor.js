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
 * Globe engine: the governor is the Cesium engine's render backend.
 * `engine.render.request()/setContinuous()` (src/globe/cesium/render.js)
 * delegate here, so the governor never uses `engine.render` (that would be a
 * cycle) and keeps the viewer for what the contract leaves to the engine:
 * `scene.requestRenderMode`, `scene.maximumRenderTimeChange` and
 * `scene.requestRender()`. It needs no frame events (`engine.frames`).
 *
 * Any other globe engine (Navara) is the governor's backend instead: install
 * it on the engine (installEngineRenderGovernor) and the owner-counted holds
 * drive `engine.render.setContinuous`, requests go to `engine.render.request`.
 */

let _viewer = null;
/** The non-Cesium engine the governor drives, or null (Cesium: `_viewer`). */
let _engine = null;
let _installed = false;
const _holds = new Set();

/** Debug trail of the most recent one-shot render requests (idle mode only). */
const _recentRequests = [];
const RECENT_REQUEST_CAP = 16;

function applyMode() {
  if (!_installed) return;
  const continuous = _holds.size > 0;
  if (_engine) {
    if (_engine.render.isContinuous() === continuous) return;
    _engine.render.setContinuous(continuous);
    if (!continuous) _engine.render.request('governor-idle');
    return;
  }
  if (!_viewer?.scene) return;
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
 * Install the governor on a Cesium viewer, as the Cesium engine's render
 * backend. Idempotent. Before install, hold/release still record into the
 * holds set (and apply at install time); requests are safe no-ops — so
 * modules can call all three unconditionally in tests without a viewer.
 * @param {Cesium.Viewer} viewer
 * @returns {void}
 */
export function installRenderGovernor(viewer) {
  if (!viewer?.scene)
    throw new TypeError('installRenderGovernor requires a Cesium viewer');
  _engine = null;
  _viewer = viewer;
  _installed = true;
  // Never let Cesium re-render on simulation-time deltas behind our back —
  // idle means idle. All re-renders are camera/tiles (Cesium-native) or
  // explicit requests.
  viewer.scene.maximumRenderTimeChange = Infinity;
  applyMode();
}

/**
 * Install the governor on a globe engine that renders by itself (Navara):
 * the holds drive `engine.render.setContinuous`, requests go to
 * `engine.render.request`. Idempotent, like installRenderGovernor.
 * @param {import('./globe/contract.js').GlobeEngine} engine
 * @returns {void}
 */
export function installEngineRenderGovernor(engine) {
  if (typeof engine?.render?.setContinuous !== 'function')
    throw new TypeError('installEngineRenderGovernor requires a globe engine');
  _engine = engine;
  _viewer = engine;
  _installed = true;
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
  if (!_installed || (!_engine && !_viewer?.scene)) return;
  if (_holds.size === 0) {
    _recentRequests.push({ reason, at: Date.now() });
    if (_recentRequests.length > RECENT_REQUEST_CAP) _recentRequests.shift();
  }
  if (_engine) _engine.render.request(reason);
  else _viewer.scene.requestRender?.();
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

/**
 * Whether the governor is installed on this viewer (its render requests then
 * go through `governorRequestRender`).
 * @param {object} viewer
 * @returns {boolean}
 */
export function isRenderGovernorInstalled(viewer) {
  return _installed && viewer != null && _viewer === viewer;
}

/** Release the installed viewer after its animation owners have stopped. */
export function uninstallRenderGovernor(viewer) {
  if (_viewer !== viewer) return;
  _viewer = null;
  _engine = null;
  _installed = false;
  _holds.clear();
  _recentRequests.length = 0;
}

/** Test seam: reset module state between unit tests. */
export function _resetRenderGovernorForTest() {
  _viewer = null;
  _engine = null;
  _installed = false;
  _holds.clear();
  _recentRequests.length = 0;
}
