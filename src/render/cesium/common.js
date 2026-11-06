/**
 * @module render/cesium/common
 * @description What the Cesium ports share: the contract's listener rules
 * and its positions as Cesium's.
 */
import * as Cesium from 'cesium';

/**
 * One subscription list under the contract's listener rules: subscription
 * order, one removed during delivery does not run, one added during
 * delivery waits for the next event, and a throw goes to `onThrow` while
 * the rest still run. Each subscription is its own entry, so a callback
 * subscribed twice runs twice.
 * @param {(error: unknown) => void} onThrow
 */
export function listenerList(onThrow) {
  const entries = [];
  return {
    get size() {
      return entries.length;
    },
    on(cb) {
      const entry = { cb, live: true };
      entries.push(entry);
      return () => {
        entry.live = false;
        const i = entries.indexOf(entry);
        if (i >= 0) entries.splice(i, 1);
      };
    },
    fire(...args) {
      for (const entry of entries.slice()) {
        if (!entry.live) continue;
        try {
          entry.cb(...args);
        } catch (error) {
          onThrow(error);
        }
      }
    },
    clear() {
      for (const entry of entries) entry.live = false;
      entries.length = 0;
    },
  };
}

/** A contract position as ECEF. */
export function toCartesian(pos) {
  if ('x' in pos) return new Cesium.Cartesian3(pos.x, pos.y, pos.z);
  return Cesium.Cartesian3.fromDegrees(pos.lon, pos.lat, pos.height ?? 0);
}

/**
 * Where a listener's throw goes with no `error` listener: the platform's
 * `reportError` (or a rethrow on a microtask), as a browser reports an event
 * listener's exception, loud, while the frame and the other listeners carry
 * on.
 */
export function uncaught(error) {
  if (typeof globalThis.reportError === 'function')
    globalThis.reportError(error);
  else
    queueMicrotask(() => {
      throw error;
    });
}
