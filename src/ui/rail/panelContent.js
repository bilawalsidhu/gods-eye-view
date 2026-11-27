/**
 * Content a panel owes. A surface that skips repainting while its panel is
 * closed registers how to catch up; the panel chrome calls that as it
 * presents the panel open, before anything lays the panel out or reads its
 * rows, so an opened panel never shows, measures or answers with old content.
 */
const flushers = new WeakMap();

/**
 * Call `flush` whenever `panel` is presented open.
 * @param {Element | null | undefined} panel The panel's root (`[data-panel-id]`).
 * @param {() => void} flush Repaints what the surface owes; cheap when nothing is owed.
 * @returns {() => void} Stops calling it.
 */
export function onPanelOpening(panel, flush) {
  if (!panel || typeof flush !== 'function') return () => {};
  let set = flushers.get(panel);
  if (!set) flushers.set(panel, (set = new Set()));
  // Each registration is its own entry, so one owner's release never drops
  // another's.
  const entry = () => flush();
  set.add(entry);
  return () => {
    set.delete(entry);
  };
}

/**
 * Repaint now whatever `panel`'s surfaces owe.
 * @param {Element | null | undefined} panel
 */
export function flushPanelContent(panel) {
  const set = panel && flushers.get(panel);
  if (!set) return;
  for (const flush of [...set]) {
    try {
      flush();
    } catch (error) {
      console.warn('[Panels] content flush error:', error);
    }
  }
}
