// Move the same provider-owned viewer between Context’s home, card and dock.
import { isContextSurfaceVisible, MOBILE_SHEET_ATTR } from './mobileSheets.js';

let home = null;
let wrap = null;

let sheetWatch = null;

/**
 * Vue calls this as the home's function ref (ContextView.vue): with its
 * element on mount and on each update, and with null on unmount.
 * @param {HTMLElement|null} element The viewer's offscreen home.
 */
export function registerStreetLevelViewerHome(element) {
  const next = element || null;
  if (next !== home) {
    releaseHome();
    home = next;
    // Found once: while it sits in the card it is no longer under home.
    wrap = home?.querySelector('#sl-viewer-wrap') ?? null;
  }
  watchSheets();
  placeStreetLevelViewer();
}

/**
 * Let the old home go: its viewer goes back under it, out of the card, and
 * the sheet watcher stops.
 */
function releaseHome() {
  sheetWatch?.disconnect();
  sheetWatch = null;
  if (home && wrap && wrap.parentElement !== home) home.appendChild(wrap);
  home = null;
  wrap = null;
}

/** A phone sheet switch changes whether the card can host the viewer. */
function watchSheets() {
  const body = home?.ownerDocument?.body;
  if (!home || !body || sheetWatch || typeof MutationObserver !== 'function')
    return;
  sheetWatch = new MutationObserver(() => placeStreetLevelViewer());
  sheetWatch.observe(body, {
    attributes: true,
    attributeFilter: [MOBILE_SHEET_ATTR, 'class'],
  });
  const rail = body.querySelector('#right-context-rail');
  if (rail)
    sheetWatch.observe(rail, { attributes: true, attributeFilter: ['class'] });
}

/** Whether a slot or one of its ancestors is hidden. */
function slotShown(slot) {
  if (slot.closest('[hidden]')) return false;
  for (let node = slot; node; node = node.parentElement)
    if (node.style?.display === 'none') return false;
  return true;
}

/** Native fullscreen and an open popover must stay attached to their original parent. */
export function isStreetViewerExpanded(element = wrap) {
  return Boolean(
    element &&
    (element.ownerDocument.fullscreenElement === element ||
      (element.hasAttribute('popover') && element.matches(':popover-open'))),
  );
}
const lifted = () =>
  wrap.classList.contains('sl-viewer-wrap-embed') || isStreetViewerExpanded();

/** Prefer a visible card, then a visible dock, then home. */
export function placeStreetLevelViewer() {
  if (!home || !wrap || lifted()) return;
  const doc = home.ownerDocument;
  const card = doc.getElementById('sl-viewer-slot');
  const loading = doc.getElementById('sl-viewer-loading-slot');
  const dock = doc.getElementById('sl-docked-slot');
  const contextSlot = isContextSurfaceVisible(doc.body)
    ? [card, loading].find((slot) => slot && slotShown(slot))
    : null;
  const target = contextSlot ?? (dock && slotShown(dock) ? dock : home);
  if (wrap.parentElement !== target) target.appendChild(wrap);
}

/**
 * Send the viewer home before its slot goes. Only from that slot: the
 * viewer may already be in the other slot or at home.
 * @param {string} slotId The card or dock slot being removed.
 */
export function returnStreetLevelViewerHome(slotId = 'sl-viewer-slot') {
  if (!home || !wrap || lifted()) return;
  if (wrap.parentElement?.id !== slotId) return;
  home.appendChild(wrap);
}
