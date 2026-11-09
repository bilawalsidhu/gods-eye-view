import { createExclusivePointer } from '../exclusivePointer.js';
// Screen input for the Navara engine, from DOM pointer events on Navara's
// canvas, with Cesium's ScreenSpaceEventHandler semantics: left button only,
// a click is a down and up within 5 px, positions are CSS px from the
// canvas's top-left corner, and a listener with a modifier fires only while
// that key is held (shift over ctrl over alt), one without only while none is.
//
// Camera inputs map to Navara's controller flags (view.camera.options).
// Flights suspend camera inputs, matching Cesium's flight controller.

import { INPUT_TYPES, normalizeInputOptions } from '../contract.js';
import { createPickDelivery } from '../pickDelivery.js';

const CLICK_PIXEL_TOLERANCE = 5; // Cesium's _clickPixelTolerance
const SCREEN_EVENTS = [
  'pointerdown',
  'pointerup',
  'pointermove',
  'pointercancel',
  'dblclick',
];

function modifierOf(event) {
  if (event.shiftKey) return 'shift';
  if (event.ctrlKey) return 'ctrl';
  if (event.altKey) return 'alt';
  return undefined;
}

/**
 * @param {{ canvas: HTMLCanvasElement, camera: { options: object } }} view
 * @param {{ picker?: { clickPick: Function, pick: Function, drillPick: Function },
 *   scheduleFrame?: (run: () => void) => void }} [options] `picker`
 *   answers listeners with { pick, drill } (picking.js): clicks from the
 *   GPU pick of the gesture, moves from the CPU pick once a frame.
 * @returns {{ input: object, destroy: () => void }}
 */
export function createNavaraInput(
  view,
  { picker = null, scheduleFrame = (run) => requestAnimationFrame(run) } = {},
) {
  const { canvas } = view;
  const listeners = new Map(INPUT_TYPES.map((type) => [type, new Set()]));
  let attached = false;
  let destroyed = false;
  let cameraOptions = {};
  let downAt = null;
  const activePointers = new Set();
  let last = null;

  const pointer = createExclusivePointer();
  const gestures = new WeakMap();
  const delivery = createPickDelivery({
    pick: (position, type, window) => {
      if (type === 'move' || type === 'down')
        return picker?.pick(position, window?.width, window?.height);
      let gesture = gestures.get(position);
      if (!gesture) {
        gesture = Promise.resolve(picker?.clickPick(position));
        gestures.set(position, gesture);
      }
      if (!window) return gesture;
      return gesture.then(
        (hit) =>
          hit ??
          (window
            ? picker?.pick(position, window.width, window.height)
            : undefined),
      );
    },
    drill: (position, limit, window) =>
      picker?.drillPick(position, limit, window?.width, window?.height) ?? [],
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
        // A primary pointer starts a new gesture: pointers released off the
        // canvas cannot hold its click back.
        if (event.isPrimary === true) activePointers.clear();
        activePointers.add(event.pointerId);
        if (activePointers.size > 1 || event.isPrimary === false) {
          downAt = null;
          break;
        }
        if (event.button !== 0) break;
        downAt = { ...position, pointerId: event.pointerId };
        emit('down', event, { position });
        break;
      case 'pointerup': {
        activePointers.delete(event.pointerId);
        if (event.button !== 0) break;
        emit('up', event, { position });
        const start = downAt;
        downAt = null;
        if (
          start &&
          start.pointerId === event.pointerId &&
          Math.hypot(position.x - start.x, position.y - start.y) <
            CLICK_PIXEL_TOLERANCE
        )
          emit('click', event, { position });
        break;
      }
      case 'pointercancel':
        activePointers.delete(event.pointerId);
        downAt = null;
        break;
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
  let suspended = 0;
  const sendCameraInputs = () => {
    const enabled = suspended === 0;
    input.setCameraOptions({
      enableSpin: enabled,
      enableZoom: enabled,
      enableTilt: enabled,
    });
  };
  const input = {
    acquirePointer: () => pointer.acquire(),
    on(type, listener, options = {}) {
      const { modifier, pick, drill, pickWindow } = normalizeInputOptions(
        type,
        options,
      );
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
        pickWindow,
        pointer: options.pointer,
      };
      listeners.get(type).add(entry);
      return () => {
        listeners.get(type).delete(entry);
      };
    },
    /** Off under any suspension. */
    cameraInputsEnabled: () => suspended === 0,
    /**
     * Navara's spin, zoom and tilt off until the returned release (the
     * follow camera takes drag and wheel itself, as do the app's camera
     * owners). The last release enables the controls.
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
    destroy() {
      if (destroyed) return;
      pointer.destroy();
      destroyed = true;
      if (attached)
        for (const name of SCREEN_EVENTS)
          canvas.removeEventListener(name, onScreenEvent);
      attached = false;
      for (const set of listeners.values()) set.clear();
    },
  };
}
