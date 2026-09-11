import * as Cesium from 'cesium';

/**
 * Windows Precision Touchpad pinch arrives as Ctrl+wheel. Cesium records
 * WHEEL+CTRL but only zooms on unmodified WHEEL, so pinch does nothing
 * (and two-finger scroll can tilt if the pad also emits touch). This module
 * binds modifier-wheel to zoom and keeps laptop two-finger motion from
 * tilting, without changing mouse wheel or touch-screen pinch-zoom.
 */

const INSTALLED = new WeakMap();

const WHEEL_ZOOM_MODIFIERS = [
  Cesium.KeyboardEventModifier.CTRL,
  Cesium.KeyboardEventModifier.SHIFT,
];

const DELTA_LINE_PX = 16;
const DELTA_PAGE_PX = 120;

/**
 * Per-pixel, height-scaled zoom for touchpad pinch (Ctrl+wheel) and
 * two-finger scroll. Cesium's own wheel path is about
 * `5 * 7.5°/px / canvasHeight` (~0.00073 on a 900px view). 0.002 is ~2.5–2.7×
 * that — snappy without a short flick jumping across the globe.
 * Discrete mouse notches (≥80px or line/page mode) stay on Cesium.
 */
export const TOUCHPAD_WHEEL_ZOOM_SCALE = 0.002;

/** Pixel deltas this large are treated as a mouse-wheel notch, not a touchpad. */
const MOUSE_WHEEL_NOTCH_PX = 80;

/** @param {Pick<WheelEvent, 'deltaMode' | 'deltaX' | 'deltaY'>} event */
export function wheelDeltaPixels(event) {
  const mode = Number(event?.deltaMode) || 0;
  const scale = mode === 1 ? DELTA_LINE_PX : mode === 2 ? DELTA_PAGE_PX : 1;
  return {
    x: Number(event?.deltaX) * scale || 0,
    y: Number(event?.deltaY) * scale || 0,
  };
}

/**
 * Zoom uses the dominant axis so a mostly-horizontal two-finger scroll still
 * zooms instead of disappearing into Cesium's deltaY-only wheel handler.
 * @param {Pick<WheelEvent, 'deltaMode' | 'deltaX' | 'deltaY'>} event
 */
export function wheelZoomDeltaPixels(event) {
  const { x, y } = wheelDeltaPixels(event);
  return Math.abs(x) > Math.abs(y) ? x : y;
}

/** @param {Pick<WheelEvent, 'ctrlKey' | 'metaKey'>} event */
export function isTouchpadPinchWheel(event) {
  return Boolean(event?.ctrlKey || event?.metaKey);
}

export function isHorizontalWheel(event) {
  const { x, y } = wheelDeltaPixels(event);
  return Math.abs(x) > Math.abs(y);
}

/**
 * Precision Touchpad pinch (Ctrl/Meta+wheel) or continuous two-finger
 * pixel-scroll. Leaves discrete mouse-wheel notches for Cesium.
 * @param {Pick<WheelEvent, 'ctrlKey' | 'metaKey' | 'deltaMode' | 'deltaX' | 'deltaY'>} event
 */
export function isTouchpadZoomWheel(event) {
  if (isTouchpadPinchWheel(event)) return true;
  const mode = Number(event?.deltaMode) || 0;
  if (mode !== 0) return false;
  const delta = Math.abs(wheelZoomDeltaPixels(event));
  return delta > 0 && delta < MOUSE_WHEEL_NOTCH_PX;
}

/**
 * Append Ctrl/Shift+wheel zoom bindings. Cesium already listens for those
 * modifier wheels (and preventDefaults them) but never consumes them.
 * @param {Array|object|undefined} eventTypes
 */
export function withModifierWheelZoomTypes(eventTypes) {
  const list = normalizeEventTypes(eventTypes);
  for (const modifier of WHEEL_ZOOM_MODIFIERS) {
    const exists = list.some((entry) => (
      entry
      && typeof entry === 'object'
      && entry.eventType === Cesium.CameraEventType.WHEEL
      && entry.modifier === modifier
    ));
    if (!exists) {
      list.push({
        eventType: Cesium.CameraEventType.WHEEL,
        modifier,
      });
    }
  }
  return list;
}

/**
 * Drop unmodified PINCH from tilt so a laptop touchpad that also emits
 * touch events cannot tilt/orbit on two-finger scroll. Pinch stays on zoom.
 * @param {Array|object|undefined} eventTypes
 */
export function withoutUnmodifiedPinchTilt(eventTypes) {
  return normalizeEventTypes(eventTypes).filter((entry) => !isUnmodifiedPinch(entry));
}

/** @param {(query: string) => { matches: boolean }} [matchMedia] */
export function prefersFinePointer(matchMedia = globalThis.matchMedia) {
  if (typeof matchMedia !== 'function') return true;
  try {
    return Boolean(matchMedia.call(globalThis, '(hover: hover) and (pointer: fine)')?.matches);
  } catch {
    return true;
  }
}

export function zoomAmountFromWheelPixels(pixels, heightMeters) {
  const delta = Number(pixels);
  const height = Number(heightMeters);
  if (!Number.isFinite(delta) || delta === 0) return 0;
  const altitude = Number.isFinite(height) && height > 0 ? height : 1000;
  return altitude * TOUCHPAD_WHEEL_ZOOM_SCALE * delta;
}

/**
 * Wire Precision Touchpad pinch / two-finger scroll. Idempotent per viewer.
 * @param {{ scene?: { canvas?: EventTarget, screenSpaceCameraController?: object }, camera?: { zoomIn?: Function, positionCartographic?: { height?: number } } }} viewer
 */
export function installTouchpadCamera(viewer) {
  const scene = viewer?.scene;
  const controller = scene?.screenSpaceCameraController;
  const canvas = scene?.canvas;
  if (!controller || !canvas?.addEventListener) return () => {};

  const existing = INSTALLED.get(viewer);
  if (existing) return existing;

  controller.zoomEventTypes = withModifierWheelZoomTypes(controller.zoomEventTypes);
  if (prefersFinePointer()) {
    controller.tiltEventTypes = withoutUnmodifiedPinchTilt(controller.tiltEventTypes);
  }

  const onWheel = (event) => {
    if (!controller.enableInputs || controller.enableZoom === false) return;
    // Own pinch and two-finger zoom so they share TOUCHPAD_WHEEL_ZOOM_SCALE.
    // Cesium's WHEEL listener is bubble-phase; stopImmediatePropagation here
    // (capture) keeps it from also applying its slower mapping.
    if (!isTouchpadZoomWheel(event)) return;
    const amount = zoomAmountFromWheelPixels(
      wheelZoomDeltaPixels(event),
      viewer.camera?.positionCartographic?.height,
    );
    if (isTouchpadPinchWheel(event) || amount) {
      // Browser page-zoom is Ctrl+wheel. Prevent in capture so Chrome cannot
      // zoom the UI if Cesium's bubble listener is late or missing.
      event.preventDefault();
    }
    if (!amount) return;
    event.stopImmediatePropagation?.();
    viewer.camera?.zoomIn?.(-amount);
    viewer.scene?.requestRender?.();
  };

  canvas.addEventListener('wheel', onWheel, { capture: true, passive: false });

  const dispose = () => {
    canvas.removeEventListener('wheel', onWheel, { capture: true });
    INSTALLED.delete(viewer);
  };
  INSTALLED.set(viewer, dispose);
  return dispose;
}

function normalizeEventTypes(eventTypes) {
  if (Array.isArray(eventTypes)) return [...eventTypes];
  if (eventTypes == null) return [];
  return [eventTypes];
}

function isUnmodifiedPinch(entry) {
  if (entry === Cesium.CameraEventType.PINCH) return true;
  return Boolean(
    entry
    && typeof entry === 'object'
    && entry.eventType === Cesium.CameraEventType.PINCH
    && entry.modifier == null,
  );
}
