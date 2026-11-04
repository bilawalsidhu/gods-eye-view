/**
 * Test doubles for the input dispatcher: a stand-in for Cesium's
 * `ScreenSpaceEventHandler`, and a dispatcher made on it ahead of the code
 * under test, so that code's `inputFor(viewer)` gets the fake.
 */
import { inputFor } from './dispatcher.js';

export const FAKE_EVENT_TYPES = Object.freeze({
  LEFT_DOWN: 'down',
  MOUSE_MOVE: 'move',
  LEFT_UP: 'up',
  LEFT_CLICK: 'click',
  LEFT_DOUBLE_CLICK: 'dblclick',
});

export class FakeScreenSpaceEventHandler {
  constructor() {
    this.actions = new Map();
    this.destroyed = false;
  }
  setInputAction(fn, type) {
    this.actions.set(type, fn);
  }
  getInputAction(type) {
    return this.actions.get(type);
  }
  removeInputAction(type) {
    this.actions.delete(type);
  }
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
 * @param {{now?: () => number, eventTypes?: object}} [options] `eventTypes`
 *   defaults to {@link FAKE_EVENT_TYPES}; pass Cesium's own when the code under
 *   test reads the viewer's stock actions by Cesium's type values.
 */
export function fakeInput(viewer, { now, eventTypes = FAKE_EVENT_TYPES } = {}) {
  const handler = new FakeScreenSpaceEventHandler();
  const input = inputFor(viewer, {
    createHandler: () => handler,
    eventTypes,
    ...(now ? { now } : {}),
  });
  const T = eventTypes;
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
    destroy: () => input.destroy(),
  };
}
