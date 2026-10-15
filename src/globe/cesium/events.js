// Contract events in front of Cesium events. The Cesium subscription exists
// only while the contract event has listeners, so creating the engine adds
// nothing to the scene (Cesium does per-frame work for camera.changed only
// while someone listens).

import { createEngineEvent } from '../contract.js';

/**
 * @param {{ addEventListener: Function, removeEventListener: Function }} source A Cesium.Event.
 * @param {(...args: any[]) => any[]} [mapArgs] Cesium arguments → contract arguments.
 * @returns {{ event: import('../contract.js').EngineEvent, detach: () => void }}
 */
export function bridgeEvent(source, mapArgs) {
  const event = createEngineEvent();
  const forward = mapArgs
    ? (...args) => event.raiseEvent(...mapArgs(...args))
    : (...args) => event.raiseEvent(...args);
  let attached = false;
  let detached = false;
  const sync = () => {
    const wanted = !detached && event.numberOfListeners > 0;
    if (wanted === attached) return;
    attached = wanted;
    if (wanted) source.addEventListener(forward);
    else source.removeEventListener(forward);
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
