/** The window event the scene's map stack controller announces stack changes on. */
export const MAP_STACK_CHANGED_EVENT = 'gev:map-stack-changed';

/**
 * Listen for map stack changes; returns the remover. Inert without a window
 * (a node build of the catalog).
 * @param {(event: CustomEvent) => void} callback
 * @returns {() => void}
 */
export function subscribeMapStack(callback) {
  globalThis.window?.addEventListener?.(MAP_STACK_CHANGED_EVENT, callback);
  return () =>
    globalThis.window?.removeEventListener?.(MAP_STACK_CHANGED_EVENT, callback);
}
