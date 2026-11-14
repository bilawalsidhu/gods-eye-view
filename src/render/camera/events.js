/**
 * @module render/camera/events
 * @description The camera port's events, shared by the renderer, the stub and
 * camera controllers (the package's `./render/camera/events`
 * export):
 * the listener lists, delivery (a throwing listener is reported, the rest
 * still run), the contract's per-listener `changed` measure, move detection
 * (`moveStart` on a change, `moveEnd` 500 ms after the last one, as the
 * reference measures them: a followed target that moves keeps the eye
 * moving, one that stands still lets the move end) and the command hooks (`onCommand`). A renderer calls
 * `stepChanged()` and `stepMoveDetection()` once per frame, `command()`
 * before each camera command, and `emit()` for the events its engine
 * raises.
 */

import { acosClamped, distance, dot } from '../../geo/index.js';

const TWO_PI = Math.PI * 2;
/** `moveEnd` waits this long after the last change, ms, as the reference does. */
export const MOVE_END_WAIT_MS = 500;

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
 * Whether two world views are the same: the same position, directions and
 * ups whose dot products are each one's own, and the same `lens` (a
 * renderer's key for its field of view and aspect, where it gives one).
 */
function sameView(a, b) {
  return (
    a &&
    b &&
    a.lens === b.lens &&
    distance(a.position, b.position) === 0 &&
    dot(a.direction, b.direction) === dot(a.direction, a.direction) &&
    dot(a.up, b.up) === dot(a.up, a.up)
  );
}

/**
 * @param {{pose: () => import('../contract/camera').CameraPose,
 *   world?: () => {position: object, direction: object, up: object},
 *   report: (error: unknown) => void, thresholds?: boolean}} options `pose`
 *   is read only while a `changed` listener is registered; `world` (the
 *   eye in world coordinates; `pose()` when omitted) is read by
 *   `stepMoveDetection`; `thresholds`
 *   false (a renderer without `cameraChangeThreshold`) ignores a listener's
 *   own threshold, so every listener fires at 0.5.
 */
export function createCameraEvents({
  pose,
  world = pose,
  report,
  thresholds = true,
}) {
  const listeners = Object.fromEntries(CAMERA_EVENTS.map((e) => [e, []]));
  const commandHooks = [];
  let lastView = null;
  let moving = false;
  let lastMovedAt = 0;

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
    const threshold = thresholds ? (options.threshold ?? 0.5) : 0.5;
    const entry = { cb, live: true, threshold };
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

  /**
   * Once a frame, after `preUpdate`: `moveStart` when the eye changed since
   * the last frame, `moveEnd` once it has not for 500 ms (`now`, ms) and
   * nothing is followed.
   * @param {number} now
   */
  function stepMoveDetection(now) {
    const v = world();
    const current = {
      position: v.position,
      direction: v.direction,
      up: v.up,
      lens: v.lens,
    };
    const changed = lastView && !sameView(lastView, current);
    lastView = current;
    if (changed) {
      lastMovedAt = now;
      if (!moving) {
        moving = true;
        emit('moveStart');
      }
    } else if (moving && now - lastMovedAt >= MOVE_END_WAIT_MS) {
      moving = false;
      emit('moveEnd');
    }
  }

  /**
   * Tell every command hook about a command before it runs.
   * @param {import('../contract/camera').CameraCommand['kind']} kind
   */
  function command(kind) {
    for (const entry of commandHooks.slice()) {
      if (!entry.live) continue;
      try {
        entry.cb({ kind });
      } catch (error) {
        report(error);
      }
    }
  }

  /**
   * The contract's `onCommand`. Each registration is its own: its `Off`
   * removes only it, once.
   * @param {(command: import('../contract/camera').CameraCommand) => void} cb
   * @returns {() => void}
   */
  function onCommand(cb) {
    const entry = { cb, live: true };
    commandHooks.push(entry);
    return () => {
      entry.live = false;
      const i = commandHooks.indexOf(entry);
      if (i >= 0) commandHooks.splice(i, 1);
    };
  }

  /** Drop every listener and hook, including those of an event under way. */
  function clear() {
    for (const list of Object.values(listeners)) {
      for (const entry of list) entry.live = false;
      list.length = 0;
    }
    for (const entry of commandHooks) entry.live = false;
    commandHooks.length = 0;
  }

  return {
    on,
    emit,
    stepChanged,
    stepMoveDetection,
    command,
    onCommand,
    clear,
  };
}
