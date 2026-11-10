/**
 * @module render/cesium/ctrlWheelZoom
 * @description Browser trackpad pinches (small pixel-mode Ctrl+wheel
 * events) relayed to a Cesium scene at a usable speed, while the camera
 * controls' zoom inputs hold `ctrlWheel` (`cameraControls.js`).
 */

const PINCH_ZOOM_MULTIPLIER = 8;
const MAX_PINCH_PIXEL_DELTA = 120;

function boundedPinchDelta(delta) {
  if (!Number.isFinite(delta) || delta === 0) return delta;
  return (
    Math.sign(delta) *
    Math.min(Math.abs(delta) * PINCH_ZOOM_MULTIPLIER, MAX_PINCH_PIXEL_DELTA)
  );
}

/**
 * Relay browser trackpad pinches to the canvas, amplified and bounded, so
 * the camera controller's Ctrl+wheel binding zooms at a usable speed;
 * returns its disposer. Browsers expose this gesture as a small pixel-mode
 * Ctrl+wheel event. The binding itself is the controls' (`zoomInputs`).
 */
export function installTrackpadPinchRelay(
  viewer,
  { createWheelEvent = (type, init) => new WheelEvent(type, init) } = {},
) {
  const container = viewer?.container;
  const canvas = viewer?.canvas;
  if (!container || !canvas)
    throw new TypeError('A viewer with a container and a canvas is required');

  const relayedEvents = new WeakSet();
  const relayPinch = (event) => {
    if (
      !event.ctrlKey ||
      relayedEvents.has(event) ||
      event.deltaMode !== 0 ||
      !Number.isFinite(event.deltaY) ||
      event.deltaY === 0
    )
      return;
    let relayed;
    try {
      relayed = createWheelEvent('wheel', {
        deltaX: event.deltaX,
        deltaY: boundedPinchDelta(event.deltaY),
        deltaZ: event.deltaZ,
        deltaMode: event.deltaMode,
        screenX: event.screenX,
        screenY: event.screenY,
        clientX: event.clientX,
        clientY: event.clientY,
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
        view: globalThis.window,
      });
    } catch {
      // The Ctrl+wheel binding can still consume the original.
      return;
    }
    relayedEvents.add(relayed);
    event.preventDefault();
    event.stopPropagation();
    canvas.dispatchEvent(relayed);
  };
  container.addEventListener('wheel', relayPinch, {
    capture: true,
    passive: false,
  });

  let active = true;
  return () => {
    if (!active) return;
    active = false;
    container.removeEventListener('wheel', relayPinch, true);
  };
}
