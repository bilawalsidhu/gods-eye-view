import { createExclusivePointer } from '../exclusivePointer.js';
// Screen input on one lazily created ScreenSpaceEventHandler. Cesium keeps
// one action per (type, modifier); the engine fans it out to its listeners.

import * as Cesium from 'cesium';
import { normalizeInputOptions } from '../contract.js';
import { createPickDelivery } from '../pickDelivery.js';
import { toGeo2 } from './convert.js';

// Cesium reuses its event objects; listeners get geo copies.
const toEvent = (event) => {
  const result = {};
  for (const name of ['position', 'startPosition', 'endPosition'])
    if (event?.[name]) result[name] = toGeo2(event[name]);
  return result;
};

/**
 * @param {Cesium.Viewer} viewer
 * @param {{ createEventHandler?: (canvas: HTMLCanvasElement) => Cesium.ScreenSpaceEventHandler,
 *   picker?: { pick: Function, drillPick: Function },
 *   scheduleFrame?: (run: () => void) => void }} [options] `picker` answers
 *   listeners with { pick, drill } (the engine's picker); moves with picks
 *   wait for `scheduleFrame` (requestAnimationFrame).
 * @returns {{ input: object, destroy: () => void }}
 */
export function createCesiumInput(
  viewer,
  {
    createEventHandler = (canvas) => new Cesium.ScreenSpaceEventHandler(canvas),
    picker = null,
    scheduleFrame = (run) => requestAnimationFrame(run),
  } = {},
) {
  const TYPES = {
    click: Cesium.ScreenSpaceEventType.LEFT_CLICK,
    doubleClick: Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK,
    move: Cesium.ScreenSpaceEventType.MOUSE_MOVE,
    down: Cesium.ScreenSpaceEventType.LEFT_DOWN,
    up: Cesium.ScreenSpaceEventType.LEFT_UP,
  };
  const KEYS = {
    ctrl: Cesium.KeyboardEventModifier.CTRL,
    shift: Cesium.KeyboardEventModifier.SHIFT,
    alt: Cesium.KeyboardEventModifier.ALT,
  };

  const { scene } = viewer;
  let handler = null;
  let destroyed = false;
  const groups = new Map();
  // Camera-input suspensions held, and the enableInputs the last resume
  // puts back: the controller's own from before the first, or what
  // the controller had before the first suspension.
  let suspended = 0;
  let resumeTo = true;
  const pointer = createExclusivePointer(() => {
    const stock = viewer.screenSpaceEventHandler;
    const saved = [TYPES.click, TYPES.doubleClick].map((type) => {
      const action = stock?.getInputAction(type);
      stock?.removeInputAction(type);
      return [type, action];
    });
    return () => {
      if (stock?.isDestroyed?.()) return;
      for (const [type, action] of saved)
        if (action) stock?.setInputAction(action, type);
    };
  });
  const delivery = createPickDelivery({
    pick: (position, type, window) =>
      picker?.pick(position, window?.width, window?.height),
    drill: (position, limit, window) =>
      picker?.drillPick(position, limit, window?.width, window?.height) ?? [],
    schedule: (run) => scheduleFrame(() => !destroyed && run()),
  });

  const input = {
    acquirePointer: () => pointer.acquire(),
    on(type, listener, options = {}) {
      const { modifier, pick, drill, pickWindow } = normalizeInputOptions(
        type,
        options,
      );
      if (destroyed) return () => {};
      handler ??= createEventHandler(scene.canvas);
      const key = `${type}:${modifier}`;
      let listeners = groups.get(key);
      if (!listeners) {
        listeners = new Set();
        groups.set(key, listeners);
        handler.setInputAction(
          (event) => {
            const accepts = pointer.delivery();
            delivery.deliver(type, toEvent(event), [...listeners], {
              isLive: (entry) => listeners.has(entry) && accepts(entry),
            });
          },
          TYPES[type],
          KEYS[modifier],
        );
      }
      const entry = {
        listener,
        pick,
        drill,
        pickWindow,
        pointer: options.pointer,
      };
      listeners.add(entry);
      return () => {
        if (!listeners.delete(entry) || listeners.size) return;
        groups.delete(key);
        if (handler && !handler.isDestroyed?.())
          handler.removeInputAction(TYPES[type], KEYS[modifier]);
      };
    },
    // The controller's switch: whatever else turned it off counts too.
    cameraInputsEnabled: () =>
      scene.screenSpaceCameraController?.enableInputs !== false,
    suspendCameraInputs() {
      const controller = scene.screenSpaceCameraController;
      if (suspended++ === 0) resumeTo = controller.enableInputs;
      controller.enableInputs = false;
      let resumed = false;
      return () => {
        if (resumed) return;
        resumed = true;
        if (--suspended === 0)
          scene.screenSpaceCameraController.enableInputs = resumeTo;
      };
    },
  };
  return {
    input,
    destroy() {
      pointer.destroy();
      destroyed = true;
      groups.clear();
      handler?.destroy();
      handler = null;
    },
  };
}
