// Screen input on one lazily created ScreenSpaceEventHandler. Cesium keeps
// one action per (type, modifier); the engine fans it out to its listeners.

import * as Cesium from 'cesium';
import { INPUT_TYPES, MODIFIERS } from '../contract.js';
import { toGeo2 } from './convert.js';

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

// Cesium reuses its event objects; listeners get geo copies.
const toEvent = (event) => {
  const result = {};
  for (const name of ['position', 'startPosition', 'endPosition'])
    if (event?.[name]) result[name] = toGeo2(event[name]);
  return result;
};

/**
 * @param {Cesium.Viewer} viewer
 * @param {{ createEventHandler?: (canvas: HTMLCanvasElement) => Cesium.ScreenSpaceEventHandler }} [options]
 * @returns {{ input: object, destroy: () => void }}
 */
export function createCesiumInput(
  viewer,
  {
    createEventHandler = (canvas) => new Cesium.ScreenSpaceEventHandler(canvas),
  } = {},
) {
  const { scene } = viewer;
  let handler = null;
  let destroyed = false;
  const groups = new Map();

  const input = {
    on(type, listener, { modifier } = {}) {
      if (!INPUT_TYPES.includes(type))
        throw new TypeError(`Unknown input type: ${type}`);
      if (modifier !== undefined && !MODIFIERS.includes(modifier))
        throw new TypeError(`Unknown input modifier: ${modifier}`);
      if (destroyed) return () => {};
      handler ??= createEventHandler(scene.canvas);
      const key = `${type}:${modifier}`;
      let listeners = groups.get(key);
      if (!listeners) {
        listeners = new Set();
        groups.set(key, listeners);
        handler.setInputAction(
          (event) => {
            const converted = toEvent(event);
            for (const entry of [...listeners])
              if (listeners.has(entry)) entry.listener(converted);
          },
          TYPES[type],
          KEYS[modifier],
        );
      }
      const entry = { listener };
      listeners.add(entry);
      return () => {
        if (!listeners.delete(entry) || listeners.size) return;
        groups.delete(key);
        if (handler && !handler.isDestroyed?.())
          handler.removeInputAction(TYPES[type], KEYS[modifier]);
      };
    },
    setCameraInputs(enabled) {
      scene.screenSpaceCameraController.enableInputs = Boolean(enabled);
    },
  };
  return {
    input,
    destroy() {
      destroyed = true;
      groups.clear();
      handler?.destroy();
      handler = null;
    },
  };
}
