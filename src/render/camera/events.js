/**
 * @module render/camera/events
 * @description The camera port's events, shared by every renderer: the
 * listener lists, delivery (a throwing listener is reported, the rest still
 * run), and the contract's per-listener `changed` measure. A renderer calls
 * `stepChanged()` once per frame and `emit()` for the events its engine
 * raises.
 */

import { acosClamped, distance, dot } from '../../geo/index.js';

const TWO_PI = Math.PI * 2;

/** The contract's camera events. */
export const CAMERA_EVENTS = Object.freeze([
  'changed',
  'moveStart',
  'moveEnd',
  'followChanged',
  'flightEnd',
]);

/** How far an angle moved, as a fraction of π, the short way round. */
const angleDelta = (a, b) => {
  const d = Math.abs(a - b) % TWO_PI;
  return (d > Math.PI ? TWO_PI - d : d) / Math.PI;
};

/**
 * @param {{pose: () => import('../contract/camera').CameraPose,
 *   report: (error: unknown) => void}} options `pose` is read only while a
 *   `changed` listener is registered.
 */
export function createCameraEvents({ pose, report }) {
  const listeners = Object.fromEntries(CAMERA_EVENTS.map((e) => [e, []]));

  function deliver(entry) {
    if (!entry.live) return;
    try {
      entry.cb();
    } catch (error) {
      report(error);
    }
  }

  function emit(event) {
    for (const entry of listeners[event].slice()) deliver(entry);
  }

  /**
   * @param {string} event
   * @param {() => void} cb
   * @param {{threshold?: number}} [options]
   * @returns {() => void}
   */
  function on(event, cb, options = {}) {
    const list = listeners[event];
    if (!list) throw new Error(`Unknown camera event: ${event}`);
    const entry = { cb, live: true, threshold: options.threshold ?? 0.5 };
    list.push(entry);
    return () => {
      entry.live = false;
      const i = list.indexOf(entry);
      if (i >= 0) list.splice(i, 1);
    };
  }

  /**
   * Per listener, the reference camera's formula: heading and roll each
   * against their own last reported value, then direction and position
   * against the last reported view. Each can report in the same frame.
   */
  function stepChanged() {
    const list = listeners.changed;
    if (!list.length) return;
    const current = pose();
    for (const entry of list.slice()) {
      if (!entry.live) continue;
      const t = entry.threshold;
      entry.heading ??= current.heading;
      entry.roll ??= current.roll;
      const headingF = angleDelta(entry.heading, current.heading);
      const rollF = angleDelta(entry.roll, current.roll);
      if (headingF > t) entry.heading = current.heading;
      if (rollF > t) entry.roll = current.roll;
      if (headingF > t || rollF > t) deliver(entry);
      if (!entry.view) {
        entry.view = {
          position: current.position,
          direction: current.direction,
        };
        continue;
      }
      const dirF =
        acosClamped(dot(current.direction, entry.view.direction)) /
        (current.fovy * 0.5);
      const heightF =
        distance(current.position, entry.view.position) / current.height;
      if (dirF > t || heightF > t) {
        entry.view = {
          position: current.position,
          direction: current.direction,
        };
        deliver(entry);
      }
    }
  }

  /** Drop every listener, including those of an event under way. */
  function clear() {
    for (const list of Object.values(listeners)) {
      for (const entry of list) entry.live = false;
      list.length = 0;
    }
  }

  return { on, emit, stepChanged, clear };
}
