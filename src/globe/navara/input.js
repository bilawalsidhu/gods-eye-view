// Screen input for the Navara engine, from DOM pointer events on Navara's
// canvas, with Cesium's ScreenSpaceEventHandler semantics: left button only,
// a click is a down and up within 5 px, positions are CSS px from the
// canvas's top-left corner, and a listener with a modifier fires only while
// that key is held (shift over ctrl over alt), one without only while none is.
//
// Camera inputs map to Navara's controller flags (view.camera.options, S4).
// Navara 0.2.1 lets a flyTo run on under user input, where Cesium cancels it;
// `onCameraInput` reports user camera input so the engine can do the same.

import { INPUT_TYPES, MODIFIERS } from '../contract.js';

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
 * @param {{ onCameraInput?: (type: string) => void }} [options]
 * @returns {{ input: object, destroy: () => void }}
 */
export function createNavaraInput(view, { onCameraInput = () => {} } = {}) {
  const { canvas } = view;
  const listeners = new Map(INPUT_TYPES.map((type) => [type, new Set()]));
  let attached = false;
  let destroyed = false;
  let cameraInputs = true;
  let cameraOptions = {};
  let downAt = null;
  let last = null;

  const positionOf = (event) => {
    const rect = canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };
  const emit = (type, event, payload) => {
    const modifier = modifierOf(event);
    for (const entry of [...listeners.get(type)])
      if (entry.modifier === modifier && listeners.get(type).has(entry))
        entry.listener(payload);
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

  const input = {
    on(type, listener, { modifier } = {}) {
      if (!INPUT_TYPES.includes(type))
        throw new TypeError(`Unknown input type: ${type}`);
      if (modifier !== undefined && !MODIFIERS.includes(modifier))
        throw new TypeError(`Unknown input modifier: ${modifier}`);
      if (destroyed) return () => {};
      if (!attached) {
        attached = true;
        for (const name of SCREEN_EVENTS)
          canvas.addEventListener(name, onScreenEvent);
      }
      const entry = { listener, modifier };
      listeners.get(type).add(entry);
      return () => {
        listeners.get(type).delete(entry);
      };
    },
    setCameraInputs(enabled) {
      cameraInputs = Boolean(enabled);
      input.setCameraOptions({
        enableSpin: cameraInputs,
        enableZoom: cameraInputs,
        enableTilt: cameraInputs,
      });
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
    destroy() {
      if (destroyed) return;
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
