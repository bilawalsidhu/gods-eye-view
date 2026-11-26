/**
 * While Stories is open its screens own the keyboard. A key pressed inside
 * Stories reaches Stories' controls and stops at its root, before GEV's
 * document-level shortcuts; a key pressed anywhere else (nothing focused, or
 * a hidden GEV control) stops at the window, so nothing behind Stories acts
 * on it, unless it is one of a playing GEV scene's own on-globe controls.
 * Listeners on the window itself (Stories' own Escape and "/") still
 * run. Capture-phase listeners on the document run before the root and check
 * `body.stories-mode` themselves (hold Space to talk, focus traps).
 * @param {{root: HTMLElement, isOpen: () => boolean, win?: Window}} options
 * @returns {() => void} Removes the guard.
 */
export function guardStoriesKeyboard({ root, isOpen, win = window }) {
  const types = ['keydown', 'keyup', 'keypress'];
  // A GEV scene playing in Stories keeps its own controls (the A/B slider,
  // an embedded player's card): their keys reach them as outside Stories.
  const sceneControl = (target) =>
    root.ownerDocument.body.classList.contains('stories-scene') &&
    !!target?.closest?.('[data-globe-overlay]');
  const outside = (event) => {
    if (!isOpen() || root.contains(event.target)) return;
    if (sceneControl(event.target)) return;
    event.stopPropagation();
  };
  const inside = (event) => {
    if (isOpen()) event.stopPropagation();
  };
  for (const type of types) {
    win.addEventListener(type, outside, true);
    root.addEventListener(type, inside);
  }
  return () => {
    for (const type of types) {
      win.removeEventListener(type, outside, true);
      root.removeEventListener(type, inside);
    }
  };
}
