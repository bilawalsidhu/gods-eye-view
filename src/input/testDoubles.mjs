/**
 * Test doubles for the input dispatcher: a stand-in for Cesium's
 * `ScreenSpaceEventHandler`, and a dispatcher made on it ahead of the code
 * under test, so that code's `inputFor(viewer)` gets the fake. Imported by
 * tests only.
 *
 * The dispatcher's input port is the Cesium adapter's (`findInput`, over the
 * fake handler), and its clicks pick through {@link sceneQuery}: the
 * viewer's renderer's query port where it has one that picks, else the
 * viewer double's own `scene.pick` and `drillPick`, read as the renderer's
 * picks are.
 */
import * as Cesium from 'cesium';
// The adapter's unbound input port and a click's own Cesium picks.
import '../render/cesium/input.js';
import '../render/cesium/nativeClick.js';
import { rendererOf } from '../render/rendererOf.js';
import { fakeScenePicks } from '../testSupport/fakeCesiumScene.mjs';
import { provideStyleStageAlias } from '../styles/styleStages.js';
import { inputFor } from './dispatcher.js';

/** Cesium's own event types, the ones the input port binds. */
export const FAKE_EVENT_TYPES = Cesium.ScreenSpaceEventType;

// Tests record sensor styles on the viewer double's scene, as the code under
// them once did: the dispatcher, which looks them up by the viewer, finds
// them there too.
provideStyleStageAlias((viewer) => viewer?.scene ?? null);

/**
 * A query port for a viewer double's clicks: its renderer's, where that
 * picks; else one over the double's scene (`fakeScenePicks`), with its depth
 * and ellipsoid picks.
 * @param {object} viewer
 */
export function sceneQuery(viewer) {
  const bound = () => {
    const query = rendererOf(viewer)?.query;
    return typeof query?.pick === 'function' ? query : null;
  };
  const at = (x, y) => new Cesium.Cartesian2(x, y);
  const own = {
    ...fakeScenePicks(viewer),
    pickPosition(x, y) {
      const scene = viewer.scene;
      if (
        !scene?.pickPositionSupported ||
        typeof scene.pickPosition !== 'function'
      )
        return null;
      return scene.pickPosition(at(x, y)) ?? null;
    },
    pickEllipsoid(x, y) {
      const camera = viewer.camera ?? viewer.scene?.camera;
      return camera?.pickEllipsoid?.(at(x, y)) ?? null;
    },
  };
  return new Proxy(own, {
    get(target, key) {
      const query = bound();
      if (query) {
        const value = query[key];
        return typeof value === 'function' ? value.bind(query) : value;
      }
      return target[key];
    },
  });
}

export class FakeScreenSpaceEventHandler {
  constructor() {
    this.actions = new Map();
    this.destroyed = false;
  }
  /** One action per type and modifier, as Cesium keeps them. */
  static key(type, modifier) {
    return modifier === undefined ? type : `${type}+${modifier}`;
  }
  setInputAction(fn, type, modifier) {
    this.actions.set(FakeScreenSpaceEventHandler.key(type, modifier), fn);
  }
  getInputAction(type, modifier) {
    return this.actions.get(FakeScreenSpaceEventHandler.key(type, modifier));
  }
  removeInputAction(type, modifier) {
    this.actions.delete(FakeScreenSpaceEventHandler.key(type, modifier));
  }
  /** Raise an action as Cesium does for a press with no modifier held. */
  fire(type, event) {
    this.actions.get(type)?.(event);
  }
  isDestroyed() {
    return this.destroyed;
  }
  destroy() {
    this.destroyed = true;
  }
}

/**
 * Make `viewer`'s dispatcher on a fake handler and return ways to drive it.
 * @param {object} viewer
 * @param {{now?: () => number}} [options]
 */
export function fakeInput(viewer, { now } = {}) {
  const handler = new FakeScreenSpaceEventHandler();
  // A Cesium viewer's canvas is its scene's.
  if (!('canvas' in viewer))
    Object.defineProperty(viewer, 'canvas', {
      configurable: true,
      get: () => viewer.scene?.canvas,
    });
  const input = inputFor(viewer, {
    createHandler: () => handler,
    document: null,
    query: sceneQuery(viewer),
    ...(now ? { now } : {}),
  });
  const T = FAKE_EVENT_TYPES;
  return {
    input,
    handler,
    down: (position) => handler.fire(T.LEFT_DOWN, { position }),
    move: (endPosition, startPosition = endPosition) =>
      handler.fire(T.MOUSE_MOVE, { startPosition, endPosition }),
    up: (position) => handler.fire(T.LEFT_UP, { position }),
    /** A bare LEFT_CLICK, as Cesium raises it after a tap. */
    click: (position = { x: 10, y: 10 }) =>
      handler.fire(T.LEFT_CLICK, { position }),
    /** Down, up and click at one spot. */
    tap(position = { x: 10, y: 10 }) {
      handler.fire(T.LEFT_DOWN, { position });
      handler.fire(T.LEFT_UP, { position });
      handler.fire(T.LEFT_CLICK, { position });
    },
    dblclick: (position = { x: 10, y: 10 }) =>
      handler.fire(T.LEFT_DOUBLE_CLICK, { position }),
    /** Whether the viewer's stock `select` or `dblclickFollow` runs now. */
    stockEnabled: (name) => input.stockEnabled(name),
    destroy: () => input.destroy(),
  };
}
