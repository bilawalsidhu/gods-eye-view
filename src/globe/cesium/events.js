// Contract events in front of Cesium events. The Cesium subscription exists
// only while the contract event has listeners, so creating the engine adds
// nothing to the scene (Cesium does per-frame work for camera.changed only
// while someone listens).

import { createEngineEvent } from '../contract.js';

/**
 * @param {{ addEventListener: (listener: Function) => () => void }} source A
 *   Cesium.Event (its addEventListener returns the remover the bridge uses).
 * @param {{ unary?: (...args: any[]) => any }} [options] `unary` maps the
 *   Cesium arguments to the one contract argument without building an
 *   argument list (for per-frame events).
 * @returns {{ event: import('../contract.js').EngineEvent, detach: () => void }}
 */
export function bridgeEvent(source, { unary } = {}) {
  const event = createEngineEvent();
  const forward = unary
    ? (a, b, c) => event.raiseValue(unary(a, b, c))
    : (...args) => event.raiseEvent(...args);
  let removeForward = null;
  let detached = false;
  const sync = () => {
    const wanted = !detached && event.numberOfListeners > 0;
    if (wanted === (removeForward !== null)) return;
    if (wanted) removeForward = source.addEventListener(forward);
    else {
      const remove = removeForward;
      removeForward = null;
      remove();
    }
  };
  const add = event.addEventListener;
  const remove = event.removeEventListener;
  event.addEventListener = (listener) => {
    const removeListener = add(listener);
    sync();
    return () => {
      removeListener();
      sync();
    };
  };
  event.removeEventListener = (listener) => {
    const removed = remove(listener);
    sync();
    return removed;
  };
  return {
    event,
    detach() {
      detached = true;
      sync();
    },
  };
}
