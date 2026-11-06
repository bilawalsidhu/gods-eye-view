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
 * Architecture — a binary mode driven by owner holds, kept by the
 * renderer's frame port (`src/render/contract/frame.d.ts`), which is the one
 * place the loop's mode is set:
 *
 * - **Continuous mode** (every frame drawn) while ANY hold is registered. Every per-frame animator — fleet
 *   interpolation, traffic sim, satellite motion, tracked-entity follow,
 *   style crossfades, CCTV projection — registers a hold for exactly the
 *   lifetime of its scene-loop listener or animation. While one is active,
 *   behavior is byte-identical to pre-governor main: the locked
 *   interpolation/tracking invariants are preserved by construction.
 * - **Idle mode** (drawn on demand) when zero holds. The renderer draws
 *   on camera input and tile loads by itself; every other scene mutation
 *   must call `governorRequestRender()` for its one frame. Discrete
 *   mutators (layer poll ticks, slider writes, annotation changes) route
 *   through that.
 *
 * Holds are identity-keyed (one per owner id), NOT a counter — a module
 * that double-holds or double-releases cannot corrupt the mode. Owners are
 * short stable strings ('flights', 'traffic', 'style-anim', …) so the
 * diagnostics read like a story.
 *
 * The governor is O(1) passive: no per-frame work of its own, ever.
 */

/** @typedef {import('./render/contract/frame').FramePort} FramePort */

let _frame = null;
/** Owners holding, each with the frame port's release once installed. */
const _holds = new Map();

/** Debug trail of the most recent one-shot render requests (idle mode only). */
const _recentRequests = [];
const RECENT_REQUEST_CAP = 16;

function holdOnFrame(ownerId) {
  if (_frame && !_holds.get(ownerId))
    _holds.set(ownerId, _frame.holdContinuous(ownerId));
}

/**
 * Install the governor on the renderer's frame port, which keeps the loop
 * drawing every frame while any owner holds and on demand otherwise (and
 * draws one settling frame when the last hold goes). Idempotent. Before
 * install, hold/release still record into the holds (and apply at install
 * time); requests are safe no-ops — so modules can call all three
 * unconditionally in tests without a renderer.
 * @param {FramePort} frame
 * @returns {void}
 */
export function installRenderGovernor(frame) {
  if (typeof frame?.holdContinuous !== 'function')
    throw new TypeError('installRenderGovernor requires a frame port');
  if (_frame === frame) return;
  if (_frame) releaseFrameHolds();
  _frame = frame;
  for (const ownerId of _holds.keys()) holdOnFrame(ownerId);
}

function releaseFrameHolds() {
  for (const [ownerId, release] of _holds) {
    release?.();
    _holds.set(ownerId, null);
  }
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
  if (!_holds.has(ownerId)) _holds.set(ownerId, null);
  holdOnFrame(ownerId);
}

/**
 * Release a hold. Safe when never held.
 * Call where the owner's per-frame work ENDS (listener removed, animation
 * settled, tracking stopped, layer disabled).
 * @param {string} ownerId
 * @returns {void}
 */
export function releaseContinuousRender(ownerId) {
  if (!ownerId || !_holds.has(ownerId)) return;
  const release = _holds.get(ownerId);
  _holds.delete(ownerId);
  release?.();
}

/**
 * One-shot render request for a discrete scene mutation (layer tick, slider
 * write, annotation change). Always forwards to the frame port — while held
 * that is harmless (and forwarding closes the request-then-last-release
 * race); only idle-mode requests are recorded in diagnostics. Cheap enough
 * to call unconditionally after any mutation.
 * @param {string} [reason] For diagnostics only.
 * @returns {void}
 */
export function governorRequestRender(reason = 'unspecified') {
  if (!_frame) return;
  if (_holds.size === 0) {
    _recentRequests.push({ reason, at: Date.now() });
    if (_recentRequests.length > RECENT_REQUEST_CAP) _recentRequests.shift();
  }
  _frame.requestRender(reason);
}

/**
 * @returns {{installed: boolean, mode: 'continuous'|'idle', holds: string[],
 *   recentRequests: Array<{reason: string, at: number}>}}
 */
export function getRenderGovernorDiagnostics() {
  return {
    installed: Boolean(_frame),
    mode: _holds.size > 0 ? 'continuous' : 'idle',
    holds: [..._holds.keys()].sort(),
    recentRequests: [..._recentRequests],
  };
}

/** Release the installed frame port after its animation owners have stopped. */
export function uninstallRenderGovernor(frame) {
  if (!_frame || _frame !== frame) return;
  releaseFrameHolds();
  _frame = null;
  _holds.clear();
  _recentRequests.length = 0;
}

/** Test seam: reset module state between unit tests. */
export function _resetRenderGovernorForTest() {
  _frame = null;
  _holds.clear();
  _recentRequests.length = 0;
}
