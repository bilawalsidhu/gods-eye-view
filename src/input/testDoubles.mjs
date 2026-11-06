/**
 * Test doubles for the input dispatcher: a stand-in for Cesium's
 * `ScreenSpaceEventHandler`, and a dispatcher made on it ahead of the code
 * under test, so that code's `inputFor(viewer)` gets the fake.
 */
import { HANDLER_EVENT_TYPES, inputFor } from './dispatcher.js';

/** Cesium's own event types, the ones the input port binds. */
export const FAKE_EVENT_TYPES = HANDLER_EVENT_TYPES;

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
  const input = inputFor(viewer, {
    createHandler: () => handler,
    document: null,
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
