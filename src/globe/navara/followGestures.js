// The follow camera's drag and wheel on Navara (src/globe/follow.js
// `gestures`): while following, Navara's own spin, zoom and tilt are off
// (they pan about the ground point under the cursor and zoom toward it) and
// the gestures act on the offset as Cesium's tracked camera does
// (ScreenSpaceCameraController rotate3D and zoom3D):
// - left drag: heading turns by rate × dx / width × 2π and the camera rises
//   by rate × −dy / height × π, rate = 1.77 (Cesium's maximum rotate rate,
//   which a tracked camera beyond a few metres always reaches); the signed
//   window ratio uses Cesium's maximumMovementRatio cap; a drag
//   right turns the heading clockwise;
// - right drag: a dolly by dy / height (down closes in);
// - wheel: one notch (deltaY 100) is 20 % of the range;
// - two-finger pinch: the range scales by the fingers' distance ratio
//   (pointers are told apart by pointerId).

const WHEEL_STEP = 1.2;
const ROTATE_RATE = 1.77;
const MAX_MOVEMENT_RATIO = 0.1;

/**
 * @param {HTMLCanvasElement} canvas
 * @param {() => () => void} suspendCameraInputs The engine input's.
 * @param {Window | EventTarget} [windowTarget] Where moves and releases
 *   outside the canvas arrive.
 * @returns {(handlers: { orbit: Function, zoom: Function }) => () => void}
 */
export function navaraFollowGestures(
  canvas,
  suspendCameraInputs,
  windowTarget = globalThis.window ?? canvas,
) {
  return ({ orbit, zoom, dolly }) => {
    const resume = suspendCameraInputs();
    const pointers = new Map();
    const distance = () => {
      const [a, b] = pointers.values();
      return Math.hypot(a.x - b.x, a.y - b.y);
    };
    const down = (event) => {
      if (event.button !== 0 && event.button !== 2) return;
      pointers.set(event.pointerId, {
        x: event.clientX,
        y: event.clientY,
        button: event.button,
      });
    };
    const move = (event) => {
      const last = pointers.get(event.pointerId);
      if (!last) return;
      const before = pointers.size === 2 ? distance() : 0;
      const dx = event.clientX - last.x;
      const dy = event.clientY - last.y;
      last.x = event.clientX;
      last.y = event.clientY;
      if (pointers.size > 1) {
        const after = pointers.size === 2 ? distance() : 0;
        if (before > 0 && after > 0) zoom(before / after);
        return;
      }
      const width = canvas.clientWidth || 1;
      const height = canvas.clientHeight || 1;
      if (last.button === 2) {
        dolly?.(dy / height);
        return;
      }
      orbit(
        -ROTATE_RATE * Math.min(-dx / width, MAX_MOVEMENT_RATIO) * 2 * Math.PI,
        ROTATE_RATE * Math.min(-dy / height, MAX_MOVEMENT_RATIO) * Math.PI,
      );
    };
    const up = (event) => {
      pointers.delete(event.pointerId);
    };
    const wheel = (event) => {
      if (!Number.isFinite(event.deltaY) || event.deltaY === 0) return;
      event.preventDefault?.();
      zoom(WHEEL_STEP ** (event.deltaY / 100));
    };
    // The right button drags; no context menu over it.
    const contextMenu = (event) => event.preventDefault?.();
    canvas.addEventListener('pointerdown', down);
    windowTarget.addEventListener('pointermove', move);
    windowTarget.addEventListener('pointerup', up);
    windowTarget.addEventListener('pointercancel', up);
    canvas.addEventListener('wheel', wheel, { passive: false });
    canvas.addEventListener('contextmenu', contextMenu);
    return () => {
      canvas.removeEventListener('contextmenu', contextMenu);
      canvas.removeEventListener('pointerdown', down);
      windowTarget.removeEventListener('pointermove', move);
      windowTarget.removeEventListener('pointerup', up);
      windowTarget.removeEventListener('pointercancel', up);
      pointers.clear();
      canvas.removeEventListener('wheel', wheel, { passive: false });
      resume();
    };
  };
}
