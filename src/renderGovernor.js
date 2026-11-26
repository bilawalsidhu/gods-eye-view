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
 * Frame rate: a hold may say the most frames a second it needs
 * (`holdContinuousRender(owner, { maxFps })`); while held the loop draws at
 * the highest rate its holders asked for, and at the display's own refresh
 * rate as soon as one holder asked for none. Moving layers hold through
 * their pace (renderPace.js) at 15 to 30; a followed target counts as
 * FOLLOW_FRAME_RATE unless a pointer or the wheel is steering the camera.
 * While nothing holds it, the loop ticks at the display's rate too, drawing
 * only what is asked for. Every rate is capped by the frame rate the user
 * sets in the Display panel (`setFrameRateCap`, DEFAULT_FRAME_RATE until
 * then; 0, unlimited, leaves the display's). The frame port says when its first hold is taken and its last
 * released (`onHeldChange`), the renderer's own holds included (animated
 * visual styles), so those draw at the full rate too. Camera movement takes
 * a 'camera' hold from `moveStart` to `moveEnd`, so drags and flights run at
 * the full rate as well.
 *
 * The governor is O(1) passive: no per-frame work of its own, ever.
 */

import { PACE_MAX_HZ } from './renderPace.js';

/** @typedef {import('./render/contract/frame').FramePort} FramePort */
/** @typedef {import('./render/contract/camera').CameraPort} CameraPort */

/** The most frames a second drawn until the user sets their own (the Display
 *  panel's Frame rate, ./viewFrameRate.js). */
export const DEFAULT_FRAME_RATE = 60;
/** The most frames a second drawn, whatever moves; 0: the display's rate. */
let _frameRateCap = DEFAULT_FRAME_RATE;
/**
 * Frames a second for a camera that only rides along with what it follows:
 * the most a moving layer draws (renderPace.js), leaving room in the frame
 * for everything else. The person steering it still gets the display's rate.
 */
export const FOLLOW_FRAME_RATE = PACE_MAX_HZ;

let _frame = null;
/** Owners holding, each with the frame port's release once installed. */
const _holds = new Map();
/** Removes the camera move listeners added at install. */
let _removeCameraListeners = null;
/** Stops hearing the installed port's holds. */
let _offHeldChange = null;

/** The most frames a second each owner said its hold needs; none: the display's. */
const _rateOf = new Map();
/**
 * Whether a pointer is down, or the wheel turned in the last moment: the
 * person is steering the camera. Kept apart, so the wheel's moment ending
 * never ends a drag.
 */
const _pointersDown = new Set();
let _wheeling = false;
let _steeringTimer = null;
const steering = () => _pointersDown.size > 0 || _wheeling;

/**
 * The camera's own moves (a drag, a zoom, a flight) draw at the display's
 * rate. A camera carried by what it follows needs only the follow rate,
 * unless the person is steering it at the same time.
 */
function cameraRate() {
  return !steering() && _holds.has('tracked-entity') ? FOLLOW_FRAME_RATE : 0;
}

/**
 * The rate while held: the highest any holder asked for, and the display's
 * (0) as soon as one holder asked for none. The renderer's own holds
 * (animated styles) ask for none; a frame port with `onHoldsChange` says
 * when one is taken or let go, and one without it is heard at the loop's
 * first hold and last release only.
 */
function heldRate() {
  let rate = 0;
  for (const owner of _frame.diagnostics().holds) {
    const asked = owner === 'camera' ? cameraRate() : _rateOf.get(owner);
    if (!asked) return 0;
    if (asked > rate) rate = asked;
  }
  return rate;
}

/** `rate` under the user's cap (0 for either: no limit from it). */
function capped(rate) {
  if (!_frameRateCap) return rate;
  return rate > 0 ? Math.min(rate, _frameRateCap) : _frameRateCap;
}

/** The loop's rate: the holders' while held, the display's while not, both
 *  under the user's cap. */
function applyRate(held = (_frame?.diagnostics().holds.length ?? 0) > 0) {
  _frame?.setTargetFps(capped(held ? heldRate() : 0));
}

/**
 * The most frames a second the loop draws, whatever moves: the Display
 * panel's Frame rate. 0 (or less, or not a number) is unlimited: the
 * display's own rate.
 * @param {number} fps
 */
export function setFrameRateCap(fps) {
  const value = Number(fps);
  _frameRateCap = Number.isFinite(value) && value > 0 ? value : 0;
  applyRate();
}

/** The cap `setFrameRateCap` set; 0 is unlimited. */
export function frameRateCap() {
  return _frameRateCap;
}

/** Change the steering inputs, and the rate if steering changed. */
function changeSteering(change) {
  const was = steering();
  change();
  if (steering() !== was) applyRate();
}

/**
 * Pointer and wheel input on the page: the person is steering the camera.
 * A release the page never hears (the pointer let go over another window)
 * ends when the page loses focus or is hidden.
 */
function watchSteering(target, { schedule, unschedule }) {
  if (typeof target?.addEventListener !== 'function') return null;
  // Every pointer down counts (a pinch is two), until it is let go.
  const down = (event) =>
    changeSteering(() => _pointersDown.add(event?.pointerId ?? 0));
  const up = (event) =>
    changeSteering(() => _pointersDown.delete(event?.pointerId ?? 0));
  const allUp = () => changeSteering(() => _pointersDown.clear());
  // The window's own blur, not an element's inside the page.
  const blur = (event) => {
    if (!event || event.target === target) allUp();
  };
  const wheel = () => {
    changeSteering(() => (_wheeling = true));
    if (_steeringTimer !== null) unschedule(_steeringTimer);
    _steeringTimer = schedule(() => {
      _steeringTimer = null;
      changeSteering(() => (_wheeling = false));
    }, 300);
  };
  const hidden = () => {
    if (globalThis.document?.visibilityState === 'hidden') allUp();
  };
  const options = { passive: true, capture: true };
  target.addEventListener('pointerdown', down, options);
  target.addEventListener('pointerup', up, options);
  target.addEventListener('pointercancel', up, options);
  target.addEventListener('blur', blur, options);
  target.addEventListener('wheel', wheel, options);
  const doc = globalThis.document;
  doc?.addEventListener?.('visibilitychange', hidden);
  return () => {
    target.removeEventListener('pointerdown', down, options);
    target.removeEventListener('pointerup', up, options);
    target.removeEventListener('pointercancel', up, options);
    target.removeEventListener('blur', blur, options);
    target.removeEventListener('wheel', wheel, options);
    doc?.removeEventListener?.('visibilitychange', hidden);
    if (_steeringTimer !== null) unschedule(_steeringTimer);
    _steeringTimer = null;
    _pointersDown.clear();
    _wheeling = false;
  };
}
/** Stops hearing the pointer and the wheel. */
let _removeSteeringListeners = null;

/** Debug trail of the most recent one-shot render requests (idle mode only). */
const _recentRequests = [];
const RECENT_REQUEST_CAP = 16;

function holdOnFrame(ownerId) {
  if (_frame && !_holds.get(ownerId))
    _holds.set(ownerId, _frame.holdContinuous(ownerId));
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
 * Hold continuous render while the camera moves. The camera port's
 * `moveStart` takes the hold and `moveEnd` releases it. Cesium compares the
 * pose with the last frame's to the last rounding error, and at some poses
 * the camera drifts by a rounding error every frame, so `moveEnd` never
 * comes (see `installGlobeInViewRecovery` in app/globeInViewRecovery.js). So from `moveStart` until
 * `moveEnd` the pose is also sampled every 250 ms with a tolerance for that
 * drift: half a second at rest releases the hold and a later move takes it
 * again (Cesium raises no new `moveStart` under that drift). Sampling runs
 * until `moveEnd`, however long that takes; it costs four checks a second.
 * @returns {(() => void)|null} Removes the listeners and the sampling.
 */
function watchCameraMotion(camera, { schedule, unschedule }) {
  if (typeof camera?.on !== 'function') return null;
  const pose = () => camera.pose?.() ?? null;
  const last = { position: null, direction: null };
  let timer = null;
  let restingSamples = 0;
  const copy = (v) => (v ? { x: v.x, y: v.y, z: v.z } : null);
  const remember = () => {
    const now = pose();
    last.position = copy(now?.position);
    last.direction = copy(now?.direction);
  };
  const stopSampling = () => {
    if (timer !== null) unschedule(timer);
    timer = null;
  };
  const sample = () => {
    timer = null;
    const now = pose();
    const position = now?.position;
    const direction = now?.direction;
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
  const removeStart = camera.on('moveStart', () => {
    holdContinuousRender('camera');
    stopSampling();
    restingSamples = 0;
    remember();
    timer = schedule(sample, CAMERA_SAMPLE_MS);
  });
  const removeEnd = camera.on('moveEnd', () => {
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
 * Install the governor on the renderer's frame port, which keeps the loop
 * drawing every frame while any owner holds and on demand otherwise (and
 * draws one settling frame when the last hold goes). Idempotent. Before
 * install, hold/release still record into the holds (and apply at install
 * time); requests are safe no-ops — so modules can call all three
 * unconditionally in tests without a renderer. With `camera`, a camera move
 * holds the loop drawing every frame (see watchCameraMotion); installing
 * again watches the camera given then.
 * @param {FramePort} frame
 * @param {{camera?: CameraPort|null, setTimeout?: Function,
 *   clearTimeout?: Function}} [options] The renderer's camera port, and
 *   injectable timers for tests.
 * @returns {void}
 */
export function installRenderGovernor(
  frame,
  {
    camera = null,
    setTimeout: schedule = globalThis.setTimeout,
    clearTimeout: unschedule = globalThis.clearTimeout,
  } = {},
) {
  if (
    typeof frame?.holdContinuous !== 'function' ||
    typeof frame.onHeldChange !== 'function'
  )
    throw new TypeError('installRenderGovernor requires a frame port');
  _removeCameraListeners?.();
  _removeCameraListeners = null;
  releaseContinuousRender('camera');
  if (_frame !== frame) {
    if (_frame) releaseFrameHolds();
    _offHeldChange?.();
    _frame = frame;
    const offHeld = frame.onHeldChange(applyRate);
    const offHolds = frame.onHoldsChange?.(() => applyRate()) ?? null;
    _offHeldChange = () => {
      offHeld();
      offHolds?.();
    };
    applyRate(frame.diagnostics().holds.length > 0);
    for (const ownerId of _holds.keys()) holdOnFrame(ownerId);
  }
  _removeCameraListeners = watchCameraMotion(camera, { schedule, unschedule });
  _removeSteeringListeners?.();
  _removeSteeringListeners = watchSteering(globalThis.window, {
    schedule,
    unschedule,
  });
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
export function holdContinuousRender(ownerId, { maxFps = 0 } = {}) {
  if (!ownerId) return;
  if (maxFps > 0) _rateOf.set(ownerId, maxFps);
  else _rateOf.delete(ownerId);
  if (!_holds.has(ownerId)) _holds.set(ownerId, null);
  holdOnFrame(ownerId);
  // A second holder, or a new rate, changes the rate without changing
  // whether the loop is held.
  applyRate();
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
  _rateOf.delete(ownerId);
  release?.();
  applyRate();
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
  _removeCameraListeners?.();
  _removeCameraListeners = null;
  _removeSteeringListeners?.();
  _removeSteeringListeners = null;
  releaseFrameHolds();
  _offHeldChange?.();
  _offHeldChange = null;
  _frame = null;
  _holds.clear();
  _rateOf.clear();
  _recentRequests.length = 0;
}

/** Test seam: reset module state between unit tests. */
export function _resetRenderGovernorForTest() {
  _frameRateCap = DEFAULT_FRAME_RATE;
  _removeCameraListeners?.();
  _removeCameraListeners = null;
  _removeSteeringListeners?.();
  _removeSteeringListeners = null;
  _offHeldChange?.();
  _offHeldChange = null;
  _frame = null;
  _holds.clear();
  _rateOf.clear();
  _recentRequests.length = 0;
}
