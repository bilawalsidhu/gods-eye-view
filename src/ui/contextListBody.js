import { getLocale } from '../i18n/index.js';
import { contextListShown } from './contextLists.js';
import { watchDisplayed } from './displayWatch.js';
import { onPanelOpening } from './rail/panelContent.js';

/**
 * The body of Context's list `listId` is not repainted while it is not
 * displayed (Context folded, another tab or another list shown); it repaints
 * once when it is displayed again: at once when Context is presented open on
 * that list, otherwise when a ResizeObserver reports it displayed. `repaint`
 * gets `{ force: true }` in the first case and `{ force: false }` in the
 * second.
 *
 * `defer(force)` says whether a paint now is owed instead, because the body
 * is not displayed; a forced paint never is.
 * @param {Element} container
 * @param {string} listId
 * @param {(options: { force: boolean }) => void} repaint
 * @returns {{ defer: (force?: boolean) => boolean, disconnect: () => void }}
 */
export function watchContextListBody(container, listId, repaint) {
  let owed = false;
  const body = watchDisplayed(container, () => {
    if (owed) repaint({ force: false });
  });
  const offOpening = onPanelOpening(
    container.closest?.('[data-panel-id]'),
    ({ displayedOnly = false } = {}) => {
      if (!owed) return;
      if (
        displayedOnly
          ? !(container.getClientRects?.().length > 0)
          : !contextListShown(listId)
      )
        return;
      // The body is being shown: a later render paints it rather than owing it.
      body.assumeShown();
      repaint({ force: true });
    },
  );
  return {
    defer(force = false) {
      owed = !force && !body.shown();
      return owed;
    },
    disconnect() {
      body.disconnect();
      offOpening();
    },
  };
}

/**
 * What a render shows, to skip rendering an equal one again: its template
 * translates labels too, so the locale is part of it. Null for parts that
 * cannot be compared.
 */
export function renderKey(...parts) {
  try {
    return `${getLocale()}\u0000${JSON.stringify(parts)}`;
  } catch {
    return null;
  }
}
