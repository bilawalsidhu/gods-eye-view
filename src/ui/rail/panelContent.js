/**
 * Content a panel owes. A surface that skips repainting while its panel is
 * closed registers how to catch up. Whatever shows a panel calls in here
 * before anything lays the panel out, measures it or reads its rows, so a
 * shown panel never shows, measures or answers with old content:
 * - the panel chrome as it presents one panel open (`flushPanelContent`);
 * - a phone sheet for the panels of its rail, expanded ones included;
 * - a change of mode that shows panels by a class on the page (clean view,
 *   Cockpit, scene playback: `flushAllPanelContent`);
 * - every panel layout pass, for what is displayed by then
 *   (`flushDisplayedPanelContent`), so nothing a class showed is measured
 *   with old content. Content that is still not displayed stays owed, so the
 *   pass that a repaint itself starts never repaints hidden content.
 */
const flushers = new Map();

/**
 * Call `flush` whenever `panel` is shown.
 * @param {Element | null | undefined} panel The panel's root (`[data-panel-id]`).
 * @param {(options: { displayedOnly: boolean }) => void} flush Repaints what
 *   the surface owes inside `panel`, the panel being shown; with
 *   `displayedOnly` only what has a layout box now. Cheap when nothing is
 *   owed.
 * @returns {() => void} Stops calling it.
 */
export function onPanelOpening(panel, flush) {
  if (!panel || typeof flush !== 'function') return () => {};
  let set = flushers.get(panel);
  if (!set) flushers.set(panel, (set = new Set()));
  // Each registration is its own entry, so one owner's release never drops
  // another's.
  const entry = (options) => flush(options);
  set.add(entry);
  return () => {
    set.delete(entry);
    if (set.size === 0 && flushers.get(panel) === set) flushers.delete(panel);
  };
}

/**
 * Repaint now whatever `panel`'s surfaces owe.
 * @param {Element | null | undefined} panel
 * @param {{ displayedOnly?: boolean }} [options] Only what has a layout box now.
 */
export function flushPanelContent(panel, { displayedOnly = false } = {}) {
  const set = panel && flushers.get(panel);
  if (!set) return;
  for (const flush of [...set]) {
    try {
      flush({ displayedOnly });
    } catch (error) {
      console.warn('[Panels] content flush error:', error);
    }
  }
}

/**
 * Repaint now whatever every panel that is not collapsed owes: a change of
 * mode shows panels but never opens a collapsed one, which repaints when it
 * is opened.
 */
export function flushAllPanelContent() {
  for (const panel of [...flushers.keys()])
    if (!panel.classList?.contains('collapsed')) flushPanelContent(panel);
}

/** Repaint now what every panel's surfaces owe and have a layout box for. */
export function flushDisplayedPanelContent() {
  for (const panel of [...flushers.keys()])
    flushPanelContent(panel, { displayedOnly: true });
}
