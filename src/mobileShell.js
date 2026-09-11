/**
 * Phone tab-shell. Desktop (721px+) never sees this class or sheet state.
 * Panel DOM stays in the existing rails; CSS restyles the active sheet.
 */

export const MOBILE_SHELL_MEDIA_QUERY = '(max-width: 720px)';
export const MOBILE_SHELL_CLASS = 'mobile-shell';
export const MOBILE_SHEET_ATTR = 'data-mobile-sheet';

export const MOBILE_SHEET_PANELS = Object.freeze({
  layers: Object.freeze(['data-panel']),
  context: Object.freeze(['global-context-panel']),
  display: Object.freeze(['pp-toggles']),
  more: Object.freeze(['cctv-panel', 'scene-panel', 'geo-status-panel']),
  search: Object.freeze(['location-bar']),
  presets: Object.freeze(['control-panel']),
});

export const MOBILE_TAB_SHEETS = Object.freeze(['search', 'layers', 'context', 'display', 'presets', 'more']);

const EXCLUSIVE_BODY_CLASSES = Object.freeze([
  'cockpit-mode',
  'recording-mode',
  'scene-playback-mode',
  'tour-playback-mode',
  'ui-clean-view',
]);

/**
 * @param {string} panelId
 * @returns {string|null}
 */
export function sheetForPanelId(panelId) {
  for (const [sheet, ids] of Object.entries(MOBILE_SHEET_PANELS)) {
    if (ids.includes(panelId)) return sheet;
  }
  return null;
}

/**
 * Decide whether a panel collapse/expand should change the open sheet.
 * Restored desktop prefs never open a sheet. Missing mobile-shell is a no-op.
 *
 * @param {object} input
 * @param {boolean} input.mobileShellActive
 * @param {string|null} input.currentSheet
 * @param {string} input.panelId
 * @param {boolean} input.collapsed
 * @param {boolean} [input.restore=false]
 * @param {boolean} [input.explicit=false]
 * @returns {{ changed: boolean, sheet: string|null }}
 */
export function nextMobileSheetState({
  mobileShellActive,
  currentSheet,
  panelId,
  collapsed,
  restore = false,
  explicit = false,
}) {
  if (!mobileShellActive) return { changed: false, sheet: currentSheet ?? null };
  if (restore) return { changed: false, sheet: currentSheet ?? null };
  const sheet = sheetForPanelId(panelId);
  if (!sheet) return { changed: false, sheet: currentSheet ?? null };
  if (!collapsed) {
    return { changed: currentSheet !== sheet, sheet };
  }
  if (explicit && currentSheet === sheet) return { changed: true, sheet: null };
  return { changed: false, sheet: currentSheet ?? null };
}

/**
 * Apply or clear the mobile-shell class from a matchMedia result.
 * Crossing 721px always drops the open sheet so desktop rails resume cleanly.
 *
 * @param {object} input
 * @param {boolean} input.matches
 * @param {Element|null} input.body
 * @returns {boolean} Whether mobile-shell is now active.
 */
export function applyMobileShellMatch({ matches, body }) {
  if (!body) return false;
  if (matches) {
    body.classList.add(MOBILE_SHELL_CLASS);
    return true;
  }
  body.classList.remove(MOBILE_SHELL_CLASS);
  body.removeAttribute(MOBILE_SHEET_ATTR);
  return false;
}

function exclusiveSurfaceActive(body) {
  return EXCLUSIVE_BODY_CLASSES.some((name) => body.classList.contains(name));
}

function currentSheetOf(body) {
  const value = body.getAttribute(MOBILE_SHEET_ATTR);
  return value && value in MOBILE_SHEET_PANELS ? value : null;
}

/**
 * Sync sheet state from setPanelCollapsed. No-op without body.mobile-shell.
 *
 * @param {string} panelId
 * @param {object} [options]
 * @param {boolean} [options.collapsed]
 * @param {boolean} [options.restore=false]
 * @param {Document} [options.documentRef]
 */
export function syncMobileSheetFromPanel(panelId, {
  collapsed,
  restore = false,
  explicit = false,
  documentRef = globalThis.document,
} = {}) {
  const body = documentRef?.body;
  if (!body?.classList.contains(MOBILE_SHELL_CLASS)) return;
  const next = nextMobileSheetState({
    mobileShellActive: true,
    currentSheet: currentSheetOf(body),
    panelId,
    collapsed: Boolean(collapsed),
    restore,
    explicit,
  });
  if (!next.changed) return;
  applySheet(body, next.sheet, documentRef);
}

function resetSearchField(documentRef) {
  const input = documentRef.getElementById('location-search');
  const toggle = documentRef.getElementById('search-toggle');
  input?.classList.remove('expanded', 'searching');
  toggle?.classList.remove('is-open');
  toggle?.setAttribute('aria-expanded', 'false');
  if (toggle) toggle.title = 'Search any location';
}

function applySheet(body, sheet, documentRef) {
  const tabBar = documentRef.getElementById('mobile-tab-bar');
  const backdrop = documentRef.getElementById('mobile-sheet-backdrop');
  const closeBtn = documentRef.getElementById('mobile-modal-close');
  if (sheet) {
    body.setAttribute(MOBILE_SHEET_ATTR, sheet);
    backdrop?.removeAttribute('hidden');
    closeBtn?.removeAttribute('hidden');
  } else {
    body.removeAttribute(MOBILE_SHEET_ATTR);
    backdrop?.setAttribute('hidden', '');
    closeBtn?.setAttribute('hidden', '');
    resetSearchField(documentRef);
  }
  tabBar?.querySelectorAll('[data-mobile-sheet]').forEach((button) => {
    const pressed = button.dataset.mobileSheet === sheet;
    button.setAttribute('aria-pressed', String(pressed));
  });
}

function expandSheetPanels(sheet, setPanelCollapsed, documentRef = globalThis.document) {
  for (const panelId of MOBILE_SHEET_PANELS[sheet] || []) {
    setPanelCollapsed(panelId, false, {
      explicit: true,
      persist: false,
      syncShare: false,
    });
  }
  if (sheet === 'search') {
    const input = documentRef.getElementById('location-search');
    const toggle = documentRef.getElementById('search-toggle');
    input?.classList.add('expanded');
    toggle?.classList.add('is-open');
    toggle?.setAttribute('aria-expanded', 'true');
    if (toggle) toggle.title = 'Close search';
  }
}

function collapseSheetPanels(sheet, setPanelCollapsed) {
  for (const panelId of MOBILE_SHEET_PANELS[sheet] || []) {
    setPanelCollapsed(panelId, true, {
      persist: false,
      syncShare: false,
    });
  }
}

/**
 * Wire the tab bar, matchMedia gate, and exclusive-surface close.
 *
 * @param {object} input
 * @param {(panelId: string, collapsed: boolean, options?: object) => void} input.setPanelCollapsed
 * @param {Document} [input.documentRef]
 * @param {(query: string) => MediaQueryList} [input.matchMedia]
 * @returns {{ dispose: () => void, setSheet: (sheet: string|null) => void }}
 */
export function initMobileShell({
  setPanelCollapsed,
  documentRef = globalThis.document,
  matchMedia = globalThis.matchMedia?.bind(globalThis),
} = {}) {
  const body = documentRef.body;
  const tabBar = documentRef.getElementById('mobile-tab-bar');
  const backdrop = documentRef.getElementById('mobile-sheet-backdrop');
  const removers = [];

  const setSheet = (sheet) => {
    if (!body.classList.contains(MOBILE_SHELL_CLASS)) return;
    if (exclusiveSurfaceActive(body)) sheet = null;
    const previous = currentSheetOf(body);
    if (previous && previous !== sheet) {
      if (previous === 'search') resetSearchField(documentRef);
      collapseSheetPanels(previous, setPanelCollapsed);
    }
    applySheet(body, sheet, documentRef);
    if (sheet) expandSheetPanels(sheet, setPanelCollapsed, documentRef);
  };

  const onMedia = (matches) => {
    const active = applyMobileShellMatch({ matches, body });
    if (tabBar) tabBar.setAttribute('aria-hidden', active ? 'false' : 'true');
    if (!active) {
      applySheet(body, null, documentRef);
    }
  };

  const media = typeof matchMedia === 'function' ? matchMedia(MOBILE_SHELL_MEDIA_QUERY) : null;
  onMedia(Boolean(media?.matches));
  const mediaListener = (event) => onMedia(event.matches);
  media?.addEventListener?.('change', mediaListener);
  if (media && !media.addEventListener && media.addListener) media.addListener(mediaListener);
  removers.push(() => {
    media?.removeEventListener?.('change', mediaListener);
    media?.removeListener?.(mediaListener);
  });

  tabBar?.querySelectorAll('[data-mobile-sheet]').forEach((button) => {
    const onClick = (event) => {
      event.preventDefault();
      const next = button.dataset.mobileSheet;
      setSheet(currentSheetOf(body) === next ? null : next);
    };
    button.addEventListener('click', onClick);
    removers.push(() => button.removeEventListener('click', onClick));
  });

  const closeSheet = () => setSheet(null);
  backdrop?.addEventListener('click', closeSheet);
  removers.push(() => backdrop?.removeEventListener('click', closeSheet));

  const closeBtn = documentRef.getElementById('mobile-modal-close');
  closeBtn?.addEventListener('click', closeSheet);
  removers.push(() => closeBtn?.removeEventListener('click', closeSheet));

  const onKeydown = (event) => {
    if (event.key !== 'Escape' || event.defaultPrevented) return;
    if (!body.classList.contains(MOBILE_SHELL_CLASS)) return;
    if (!currentSheetOf(body)) return;
    if (exclusiveSurfaceActive(body)) return;
    event.preventDefault();
    closeSheet();
  };
  documentRef.addEventListener('keydown', onKeydown);
  removers.push(() => documentRef.removeEventListener('keydown', onKeydown));

  let touchStartY = null;
  const onTouchStart = (event) => {
    touchStartY = event.changedTouches?.[0]?.clientY ?? null;
  };
  const onTouchEnd = (event) => {
    const start = touchStartY;
    touchStartY = null;
    if (start == null) return;
    const endY = event.changedTouches?.[0]?.clientY;
    if (endY != null && endY - start > 56) closeSheet();
  };
  backdrop?.addEventListener('touchstart', onTouchStart, { passive: true });
  backdrop?.addEventListener('touchend', onTouchEnd, { passive: true });
  removers.push(() => {
    backdrop?.removeEventListener('touchstart', onTouchStart);
    backdrop?.removeEventListener('touchend', onTouchEnd);
  });

  const observer = new MutationObserver(() => {
    if (exclusiveSurfaceActive(body) && currentSheetOf(body)) closeSheet();
  });
  observer.observe(body, { attributes: true, attributeFilter: ['class'] });
  removers.push(() => observer.disconnect());

  return {
    dispose() {
      for (const remove of removers.splice(0)) remove();
    },
    setSheet,
  };
}
