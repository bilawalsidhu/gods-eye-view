// The follow camera's drag and wheel on Navara (src/globe/follow.js
// `gestures`): while following, Navara's own spin, zoom and tilt are off
// (they pan about the ground point under the cursor and zoom toward it) and
// a left drag turns the offset around the target, a wheel scales its range,
// as Cesium's tracked camera does: a drag across the whole canvas width is
// one turn of heading, across its height half a turn of pitch; one wheel
// notch (deltaY 100) is 20 % of the range.

const WHEEL_STEP = 1.2;

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
  return ({ orbit, zoom }) => {
    const resume = suspendCameraInputs();
    let last = null;
    const down = (event) => {
      if (event.button !== 0) return;
      last = { x: event.clientX, y: event.clientY };
    };
    const move = (event) => {
      if (!last) return;
      const dx = event.clientX - last.x;
      const dy = event.clientY - last.y;
      last = { x: event.clientX, y: event.clientY };
      const width = canvas.clientWidth || 1;
      const height = canvas.clientHeight || 1;
      orbit((-dx / width) * 2 * Math.PI, (dy / height) * Math.PI);
    };
    const up = () => {
      last = null;
    };
    const wheel = (event) => {
      if (!Number.isFinite(event.deltaY) || event.deltaY === 0) return;
      event.preventDefault?.();
      zoom(WHEEL_STEP ** (event.deltaY / 100));
    };
    canvas.addEventListener('pointerdown', down);
    windowTarget.addEventListener('pointermove', move);
    windowTarget.addEventListener('pointerup', up);
    canvas.addEventListener('wheel', wheel, { passive: false });
    return () => {
      canvas.removeEventListener('pointerdown', down);
      windowTarget.removeEventListener('pointermove', move);
      windowTarget.removeEventListener('pointerup', up);
      canvas.removeEventListener('wheel', wheel, { passive: false });
      resume();
    };
  };
}
