import { createExclusivePointer } from '../exclusivePointer.js';
// Screen input for the Navara engine, from DOM pointer events on Navara's
// canvas, with Cesium's ScreenSpaceEventHandler semantics: left button only,
// a click is a down and up within 5 px, positions are CSS px from the
// canvas's top-left corner, and a listener with a modifier fires only while
// that key is held (shift over ctrl over alt), one without only while none is.
//
// Camera inputs map to Navara's controller flags (view.camera.options).
// Navara 0.2.1 lets a flyTo run on under user input, where Cesium cancels it;
// `onCameraInput` reports user camera input so the engine can do the same.

import { INPUT_TYPES, normalizeInputOptions } from '../contract.js';
import { createPickDelivery } from '../pickDelivery.js';

const CLICK_PIXEL_TOLERANCE = 5; // Cesium's _clickPixelTolerance
const SCREEN_EVENTS = ['pointerdown', 'pointerup', 'pointermove', 'dblclick'];
const CAMERA_EVENTS = ['pointerdown', 'wheel', 'touchstart'];

function modifierOf(event) {
  if (event.shiftKey) return 'shift';
  if (event.ctrlKey) return 'ctrl';
  if (event.altKey) return 'alt';
  return undefined;
}

/**
 * @param {{ canvas: HTMLCanvasElement, camera: { options: object } }} view
 * @param {{ onCameraInput?: (type: string) => void,
 *   picker?: { clickPick: Function, pick: Function, drillPick: Function },
 *   scheduleFrame?: (run: () => void) => void }} [options] `picker`
 *   answers listeners with { pick, drill } (picking.js): clicks from the
 *   GPU pick of the gesture, moves from the CPU pick once a frame.
 * @returns {{ input: object, destroy: () => void }}
 */
export function createNavaraInput(
  view,
  {
    onCameraInput = () => {},
    picker = null,
    scheduleFrame = (run) => requestAnimationFrame(run),
  } = {},
) {
  const { canvas } = view;
  const listeners = new Map(INPUT_TYPES.map((type) => [type, new Set()]));
  let attached = false;
  let destroyed = false;
  let cameraInputs = true;
  let cameraOptions = {};
  let downAt = null;
  let last = null;

  const pointer = createExclusivePointer();
  const delivery = createPickDelivery({
    pick: (position, type) =>
      type === 'move' ? picker?.pick(position) : picker?.clickPick(position),
    drill: (position, limit) => picker?.drillPick(position, limit) ?? [],
    schedule: (run) => scheduleFrame(() => !destroyed && run()),
  });
  const positionOf = (event) => {
    const rect = canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };
  const emit = (type, event, payload) => {
    const modifier = modifierOf(event);
    const group = listeners.get(type);
    const accepts = pointer.delivery();
    delivery.deliver(
      type,
      payload,
      [...group].filter((entry) => entry.modifier === modifier),
      { isLive: (entry) => group.has(entry) && accepts(entry) },
    );
  };

  const onScreenEvent = (event) => {
    const position = positionOf(event);
    switch (event.type) {
      case 'pointerdown':
        if (event.button !== 0) break;
        downAt = position;
        emit('down', event, { position });
        break;
      case 'pointerup': {
        if (event.button !== 0) break;
        emit('up', event, { position });
        const start = downAt;
        downAt = null;
        if (
          start &&
          Math.hypot(position.x - start.x, position.y - start.y) <
            CLICK_PIXEL_TOLERANCE
        )
          emit('click', event, { position });
        break;
      }
      case 'pointermove':
        emit('move', event, {
          startPosition: last ?? position,
          endPosition: position,
        });
        break;
      case 'dblclick':
        emit('doubleClick', event, { position });
        break;
    }
    last = position;
  };
  const onCameraEvent = (event) => {
    if (cameraInputs) onCameraInput(event.type);
  };
  for (const type of CAMERA_EVENTS)
    canvas.addEventListener(type, onCameraEvent, {
      capture: true,
      passive: true,
    });

  let suspended = 0;
  const sendCameraInputs = () => {
    const enabled = cameraInputs && suspended === 0;
    input.setCameraOptions({
      enableSpin: enabled,
      enableZoom: enabled,
      enableTilt: enabled,
    });
  };
  const input = {
    acquirePointer: () => pointer.acquire(),
    on(type, listener, options = {}) {
      const { modifier, pick, drill } = normalizeInputOptions(type, options);
      if (destroyed) return () => {};
      if (!attached) {
        attached = true;
        for (const name of SCREEN_EVENTS)
          canvas.addEventListener(name, onScreenEvent);
      }
      const entry = {
        listener,
        modifier,
        pick,
        drill,
        pointer: options.pointer,
      };
      listeners.get(type).add(entry);
      return () => {
        listeners.get(type).delete(entry);
      };
    },
    setCameraInputs(enabled) {
      cameraInputs = Boolean(enabled);
      sendCameraInputs();
    },
    /** Off under any suspension, else the setCameraInputs choice. */
    cameraInputsEnabled: () => cameraInputs && suspended === 0,
    /**
     * Navara's spin, zoom and tilt off until the returned release (the
     * follow camera takes drag and wheel itself, as do the app's camera
     * owners); the app's setCameraInputs choice comes back after the last
     * release.
     */
    suspendCameraInputs() {
      suspended++;
      sendCameraInputs();
      let released = false;
      return () => {
        if (released) return;
        released = true;
        suspended--;
        sendCameraInputs();
      };
    },
    /**
     * Navara-only extension: camera controller options (zoom distances,
     * speeds, ...). Navara has no getter, so the engine keeps every option
     * set through it and always sends the merged set.
     */
    setCameraOptions(options) {
      cameraOptions = { ...cameraOptions, ...options };
      view.camera.options = { ...cameraOptions };
    },
  };
  return {
    input,
    /** Whether the app leaves the camera to the user (setCameraInputs). */
    cameraInputs: () => cameraInputs,
    destroy() {
      if (destroyed) return;
      pointer.destroy();
      destroyed = true;
      for (const type of CAMERA_EVENTS)
        canvas.removeEventListener(type, onCameraEvent, { capture: true });
      if (attached)
        for (const name of SCREEN_EVENTS)
          canvas.removeEventListener(name, onScreenEvent);
      attached = false;
      for (const set of listeners.values()) set.clear();
    },
  };
}
