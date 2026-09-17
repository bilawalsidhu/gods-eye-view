import {
  holdContinuousRender,
  releaseContinuousRender,
} from '../renderGovernor.js';

/**
 * Keyboard camera flight: WASD to move, Q/E to turn.
 *
 *   W / S  forward / backward along the view direction
 *   A / D  strafe left / right (heading unchanged)
 *   Q / E  turn the view left / right in place
 *
 * Speed scales with camera height above the ellipsoid, clamped at both ends,
 * so one key press feels the same in orbit and at a street corner. Held keys
 * are applied once per animation frame from real elapsed time rather than on
 * OS key-repeat, and the loop only runs while a key is down, holding the
 * render governor for that span.
 *
 * Listeners bind in the capture phase and call preventDefault so the bubbling
 * single-letter shortcuts (f, d, ...) do not fire for the same press.
 *
 * Ported from the community WASD module in faris315mfaf-ai/gods-eye-view
 * (MIT), with yaw moved from F/G to Q/E because upstream uses F for layers.
 */
const RENDER_OWNER = 'keyboard-flight';
const MIN_MOVE_RATE_MPS = 12;
const MAX_MOVE_RATE_MPS = 900_000;
const MOVE_RATE_PER_HEIGHT = 0.6;
const TURN_RATE_RAD_PER_SEC = Math.PI / 3;
const MAX_FRAME_DELTA_SEC = 0.1;

export const KEYBOARD_FLIGHT_ROLES = Object.freeze({
  keyw: 'forward',
  keys: 'backward',
  keya: 'left',
  keyd: 'right',
  keyq: 'turnLeft',
  keye: 'turnRight',
});

function isTypingTarget(event, searchInput) {
  const target = event?.target;
  if (!target) return false;
  if (target === searchInput) return true;
  if (target.isContentEditable) return true;
  return Boolean(
    target.matches?.('input, textarea, select, [contenteditable]'),
  );
}

/**
 * @param {object} options
 * @param {object} options.viewer Cesium Viewer.
 * @param {Document} [options.documentRef]
 * @param {HTMLElement} [options.searchInput] Editing target to leave alone.
 * @param {() => boolean} [options.isEnabled] Extra gate (cockpit mode, ...).
 * @param {() => void} [options.onMoveStart] Called when a flight begins from
 *   rest; the shell cancels authored camera motion here.
 * @param {(cb: FrameRequestCallback) => number} [options.requestFrame]
 * @param {(id: number) => void} [options.cancelFrame]
 * @returns {{destroy: Function, active: () => string[]}}
 */
export function bindKeyboardFlight({
  viewer,
  documentRef = document,
  searchInput = null,
  isEnabled = () => true,
  onMoveStart = () => {},
  requestFrame = (cb) => requestAnimationFrame(cb),
  cancelFrame = (id) => cancelAnimationFrame(id),
}) {
  const active = new Set();
  let rafId = 0;
  let lastFrameAt = null;
  let holding = false;

  const releaseHold = () => {
    if (!holding) return;
    holding = false;
    releaseContinuousRender(RENDER_OWNER);
  };
  const stopLoop = () => {
    if (rafId) {
      cancelFrame(rafId);
      rafId = 0;
    }
    lastFrameAt = null;
    releaseHold();
  };
  const moveRateFor = (camera) => {
    const height = Number(camera?.positionCartographic?.height);
    if (!Number.isFinite(height)) return MIN_MOVE_RATE_MPS;
    const scaled = Math.abs(height) * MOVE_RATE_PER_HEIGHT;
    return Math.min(MAX_MOVE_RATE_MPS, Math.max(MIN_MOVE_RATE_MPS, scaled));
  };

  const step = (timestamp) => {
    rafId = 0;
    if (!active.size) return stopLoop();
    const camera = viewer?.camera;
    if (!camera || viewer?.isDestroyed?.()) {
      active.clear();
      return stopLoop();
    }
    const previous = lastFrameAt === null ? timestamp : lastFrameAt;
    lastFrameAt = timestamp;
    const delta = Math.min(
      MAX_FRAME_DELTA_SEC,
      Math.max(0, (timestamp - previous) / 1000),
    );
    if (delta > 0) {
      const distance = moveRateFor(camera) * delta;
      const turn = TURN_RATE_RAD_PER_SEC * delta;
      if (active.has('forward')) camera.moveForward(distance);
      if (active.has('backward')) camera.moveBackward(distance);
      if (active.has('left')) camera.moveLeft(distance);
      if (active.has('right')) camera.moveRight(distance);
      if (active.has('turnRight')) camera.lookRight(turn);
      if (active.has('turnLeft')) camera.lookLeft(turn);
    }
    rafId = requestFrame(step);
  };

  const startLoop = () => {
    if (!holding) {
      holding = true;
      holdContinuousRender(RENDER_OWNER);
      try {
        viewer?.camera?.cancelFlight?.();
        onMoveStart();
      } catch {
        /* A cancelled animation must never block the keys. */
      }
    }
    if (!rafId) {
      lastFrameAt = null;
      rafId = requestFrame(step);
    }
  };

  const onKeyDown = (event) => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (isTypingTarget(event, searchInput)) return;
    const role = KEYBOARD_FLIGHT_ROLES[String(event.code || '').toLowerCase()];
    if (!role || !isEnabled()) return;
    event.preventDefault();
    if (active.has(role)) return;
    active.add(role);
    startLoop();
  };
  const onKeyUp = (event) => {
    const role = KEYBOARD_FLIGHT_ROLES[String(event.code || '').toLowerCase()];
    if (!role) return;
    active.delete(role);
    if (!active.size) stopLoop();
  };
  // Alt-Tab never delivers keyup; release everything on blur.
  const onWindowBlur = () => {
    active.clear();
    stopLoop();
  };

  documentRef.addEventListener('keydown', onKeyDown, true);
  documentRef.addEventListener('keyup', onKeyUp, true);
  const view = documentRef.defaultView || globalThis;
  view.addEventListener?.('blur', onWindowBlur);

  return {
    active: () => [...active],
    destroy() {
      documentRef.removeEventListener('keydown', onKeyDown, true);
      documentRef.removeEventListener('keyup', onKeyUp, true);
      view.removeEventListener?.('blur', onWindowBlur);
      active.clear();
      stopLoop();
    },
  };
}
