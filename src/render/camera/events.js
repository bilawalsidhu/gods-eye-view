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
 *   `stepMoveDetection`, which keeps what it returns: a view it is handed
 *   again is the same eye, and a view is never changed once handed (a new
 *   eye is a new object); `pose` and `world` results are read, never
 *   changed; `thresholds`
 *   false (a renderer without `cameraChangeThreshold`) ignores a listener's
 *   own threshold, so every listener fires at 0.5.
 */
export function createCameraEvents({
  pose,
  world = pose,
  report,
  thresholds = true,
}) {
  // Lists are copied on change, not on delivery: a delivery runs over the
  // list as it stood, and a change made during it makes a new one.
  const listeners = Object.fromEntries(CAMERA_EVENTS.map((e) => [e, []]));
  let commandHooks = [];
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
    for (const entry of listeners[event]) deliver(entry);
  }

  /**
   * @param {string} event
   * @param {() => void} cb
   * @param {{threshold?: number}} [options]
   * @returns {() => void}
   */
  function on(event, cb, options = {}) {
    if (!listeners[event]) throw new Error(`Unknown camera event: ${event}`);
    const threshold = thresholds ? (options.threshold ?? 0.5) : 0.5;
    const entry = { cb, live: true, threshold };
    listeners[event] = [...listeners[event], entry];
    return () => {
      if (!entry.live) return;
      entry.live = false;
      listeners[event] = listeners[event].filter((e) => e !== entry);
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
    for (const entry of list) {
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
    // `world` hands its last view again while the eye stands: that one is
    // unchanged without comparing.
    const current = world();
    const changed =
      lastView !== null && current !== lastView && !sameView(lastView, current);
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
    for (const entry of commandHooks) {
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
    commandHooks = [...commandHooks, entry];
    return () => {
      if (!entry.live) return;
      entry.live = false;
      commandHooks = commandHooks.filter((e) => e !== entry);
    };
  }

  /** Drop every listener and hook, including those of an event under way. */
  function clear() {
    for (const event of CAMERA_EVENTS) {
      for (const entry of listeners[event]) entry.live = false;
      listeners[event] = [];
    }
    for (const entry of commandHooks) entry.live = false;
    commandHooks = [];
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
