const STYLE_KEYS = Object.freeze({
  1: 'normal',
  2: 'retro',
  3: 'surveillance',
  4: 'thermal',
  5: 'anime',
  6: 'noir',
});

/**
 * Bind the application's existing bubbling keyboard shortcuts.
 * Capture-phase surfaces keep first refusal. The caller owns each action and
 * persistence; form controls keep native typing, and a key held with Cmd,
 * Ctrl or Alt is left to the browser.
 * @param {object} options
 * @param {Document} options.documentRef Keyboard event target.
 * @param {object} options.actions Existing application operations.
 * @returns {{destroy: Function}} Synchronous, idempotent listener cleanup.
 */
export function bindApplicationShortcuts({ documentRef, actions }) {
  const onKeyDown = (event) => {
    if (event.target?.matches?.('select, input, textarea')) return;
    // Cmd+C, Ctrl+F, Cmd+1 and the like belong to the browser and the system.
    // Shift is not a chord here: Shift+C is still C.
    if (event.metaKey || event.ctrlKey || event.altKey) return;

    if (STYLE_KEYS[event.key]) actions.setStyle(STYLE_KEYS[event.key]);
    const key = event.key.toLowerCase();
    if (key === 'h') actions.toggleHud();
    if (key === 'o') actions.toggleOrbit();
    if (key === 'v') actions.toggleCleanView();
    if (key === 'f') actions.toggleLayers();
    if (key === 'd') actions.cycleDetection();
    if (key === 'c') actions.toggleCctv();
  };
  documentRef.addEventListener('keydown', onKeyDown);
  return {
    destroy() {
      documentRef.removeEventListener('keydown', onKeyDown);
    },
  };
}
