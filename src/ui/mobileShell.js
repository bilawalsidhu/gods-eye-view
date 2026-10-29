/**
 * Phone shell for narrow viewports (≤720px). The globe stays full screen and a
 * bottom tab bar opens one sheet at a time; each sheet shows existing panels,
 * which stay where they are in the rails and dock while CSS presents them
 * (styles/mobile-shell.css). Desktop never sees the class or the sheet state.
 *
 * Sheets borrow panels: the panels a sheet expands are put back exactly as
 * they were when the sheets close, and nothing a sheet does is persisted or
 * treated as the user's own panel choice.
 *
 * Adapted from the phone tab-shell proposed in public PR #203 by blearymoth.
 */

import { EXCLUSIVE_SURFACE_CLASSES } from '../exclusiveSurfaces.js';
import { msg, t } from '../i18n/index.js';
import {
  MOBILE_SHELL_CLASS,
  MOBILE_SHELL_MEDIA_QUERY,
} from './mobileShellContract.js';

export { MOBILE_SHELL_CLASS, MOBILE_SHELL_MEDIA_QUERY };
export const MOBILE_SHEET_ATTR = 'data-mobile-sheet';

/**
 * Panels each sheet expands. A sheet also shows its rail's other panels
 * collapsed (Scenes under Layers), per styles/mobile-shell.css.
 */
export const MOBILE_SHEET_PANELS = Object.freeze({
  layers: Object.freeze(['data-panel']),
  cameras: Object.freeze(['cctv-panel', 'street-level-panel']),
  context: Object.freeze(['global-context-panel']),
  search: Object.freeze(['location-bar']),
  more: Object.freeze(['control-panel', 'pp-toggles']),
});

export const MOBILE_TABS = Object.freeze([
  Object.freeze({ sheet: 'layers', label: msg('Layers'), icon: 'layers' }),
  Object.freeze({ sheet: 'cameras', label: msg('Cameras'), icon: 'videocam' }),
  Object.freeze({ sheet: 'context', label: msg('Context'), icon: 'radar' }),
  Object.freeze({ sheet: 'search', label: msg('Search'), icon: 'search' }),
  Object.freeze({ sheet: 'more', label: msg('More'), icon: 'more_horiz' }),
]);

/**
 * Surfaces that own the screen close the open sheet and keep sheets closed.
 * Scene playback is the exception: its STOP control lives in the Scenes panel
 * (Layers sheet), and a phone has no Escape key to stop it otherwise.
 */
const SHEET_BLOCKING_CLASSES = Object.freeze(
  EXCLUSIVE_SURFACE_CLASSES.filter((name) => name !== 'scene-playback-mode'),
);

/** Every panel any sheet borrows; the dock trays close each other. */
const BORROWED_PANELS = Object.freeze([
  ...new Set(Object.values(MOBILE_SHEET_PANELS).flat()),
]);

const BORROW_OPTIONS = Object.freeze({ persist: false, syncShare: false });

/**
 * @param {string} panelId
 * @returns {string|null} The sheet that presents `panelId`.
 */
export function sheetForPanelId(panelId) {
  for (const [sheet, ids] of Object.entries(MOBILE_SHEET_PANELS)) {
    if (ids.includes(panelId)) return sheet;
  }
  return null;
}

/**
 * The sheet after a tab press: the same tab closes its sheet, another opens.
 * @param {string|null} current
 * @param {string|null} pressed
 * @returns {string|null}
 */
export function nextSheet(current, pressed) {
  if (!pressed || !Object.hasOwn(MOBILE_SHEET_PANELS, pressed)) return null;
  return current === pressed ? null : pressed;
}

function sheetBlocked(body) {
  return SHEET_BLOCKING_CLASSES.some((name) => body.classList.contains(name));
}

function currentSheetOf(body) {
  const value = body.getAttribute(MOBILE_SHEET_ATTR);
  return value && Object.hasOwn(MOBILE_SHEET_PANELS, value) ? value : null;
}

function buildChrome(documentRef) {
  const backdrop = documentRef.createElement('div');
  backdrop.id = 'mobile-sheet-backdrop';
  backdrop.hidden = true;

  const tabBar = documentRef.createElement('nav');
  tabBar.id = 'mobile-tab-bar';
  tabBar.setAttribute('aria-label', t('Panels'));
  for (const tab of MOBILE_TABS) {
    const button = documentRef.createElement('button');
    button.type = 'button';
    button.className = 'mobile-tab';
    button.dataset.mobileSheet = tab.sheet;
    button.setAttribute('aria-expanded', 'false');
    const icon = documentRef.createElement('span');
    icon.className = 'material-symbols-outlined mobile-tab-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = tab.icon;
    const label = documentRef.createElement('span');
    label.className = 'mobile-tab-label';
    label.textContent = t(tab.label);
    button.append(icon, label);
    tabBar.append(button);
  }
  documentRef.body.append(backdrop, tabBar);
  return { backdrop, tabBar };
}

/**
 * Wires the phone shell: the media gate, tab bar, backdrop, Escape, focus,
 * and closing for full-screen modes.
 * @param {object} input
 * @param {(panelId: string, collapsed: boolean, options?: object) => void} input.setPanelCollapsed
 * @param {Document} [input.documentRef]
 * @param {(query: string) => MediaQueryList} [input.matchMedia]
 * @param {typeof MutationObserver} [input.MutationObserverImpl]
 * @param {typeof ResizeObserver} [input.ResizeObserverImpl]
 * @param {(callback: () => void) => number} [input.requestFrame]
 * @param {() => void} [input.onSheetsClosed] Runs after the last sheet closes
 *   and its panels are put back (e.g. to refresh the share link).
 * @param {(sheet: string) => void} [input.onTabOpened] Runs only when the user
 *   opens a sheet from its tab, never on close or programmatic presentation.
 * @returns {{ destroy: () => void, setSheet: (sheet: string|null) => void, getSheet: () => string|null, sharedCollapsed: (panelId: string) => boolean|undefined }}
 */
export function initMobileShell({
  setPanelCollapsed,
  documentRef = globalThis.document,
  matchMedia = globalThis.matchMedia?.bind(globalThis),
  MutationObserverImpl = globalThis.MutationObserver,
  ResizeObserverImpl = globalThis.ResizeObserver,
  requestFrame = globalThis.requestAnimationFrame?.bind(globalThis),
  onSheetsClosed = () => {},
  onTabOpened = () => {},
} = {}) {
  const body = documentRef.body;
  const { backdrop, tabBar } = buildChrome(documentRef);
  const viewport = documentRef.querySelector('meta[name="viewport"]');
  const viewportContent = viewport?.getAttribute('content') ?? null;
  const removers = [];
  const listen = (target, type, handler, options) => {
    target.addEventListener(type, handler, options);
    removers.push(() => target.removeEventListener(type, handler, options));
  };
  const element = (id) => documentRef.getElementById(id);
  const rails = ['left-panel-stack', 'right-context-rail']
    .map(element)
    .filter(Boolean);
  const dock = element('command-dock');
  const shown = (node) =>
    node && globalThis.getComputedStyle?.(node).display !== 'none';

  /**
   * Panel states from before the first sheet opened (`before`) and right after
   * the open sheet was set up (`applied`); null when closed.
   */
  let borrowed = null;
  let returnFocus = null;
  let swipe = null;
  const written = new Map();

  const writeVar = (name, value) => {
    if (written.get(name) === value) return;
    written.set(name, value);
    body.style.setProperty(name, value);
  };

  // The dock (Presets, Search) sits on top of whichever rail is the sheet,
  // and the required map attribution sits above everything the sheet covers.
  const measureSheet = () => {
    if (!body.classList.contains(MOBILE_SHELL_CLASS)) return;
    const height = Math.max(
      0,
      ...rails.map((rail) =>
        shown(rail) ? rail.getBoundingClientRect().height : 0,
      ),
    );
    writeVar('--mobile-sheet-height', `${Math.round(height)}px`);
    const viewportHeight = globalThis.innerHeight || 0;
    const cover = Math.max(
      0,
      ...[...rails, currentSheetOf(body) ? dock : null]
        .filter(shown)
        .map((node) => viewportHeight - node.getBoundingClientRect().top),
    );
    writeVar('--mobile-sheet-cover', `${Math.round(cover)}px`);
  };

  const resize =
    typeof ResizeObserverImpl === 'function'
      ? new ResizeObserverImpl(measureSheet)
      : null;
  removers.push(() => resize?.disconnect());

  const isCollapsed = (panelId) =>
    element(panelId)?.classList.contains('collapsed') ?? true;
  // The user's preference, as share links record it: a collapse that layout
  // applies only for space (Tactical, Cyber) still counts as expanded.
  const prefersCollapsed = (panelId) => {
    const classes = element(panelId)?.classList;
    if (!classes) return true;
    return (
      classes.contains('collapsed') &&
      !classes.contains('layout-auto-collapsed') &&
      !classes.contains('rail-owner-collapsed')
    );
  };

  const panelStates = () =>
    new Map(
      BORROWED_PANELS.map((panelId) => [panelId, prefersCollapsed(panelId)]),
    );

  // Undo only what opening the sheet did (including side effects, such as dock
  // trays closing each other). A panel the user changed since stays as they
  // left it, and becomes the state later sheets put back.
  const restoreBorrowed = () => {
    if (!borrowed) return;
    for (const [panelId, before] of borrowed.before) {
      const now = prefersCollapsed(panelId);
      if (now !== borrowed.applied.get(panelId))
        borrowed.before.set(panelId, now);
      else if (now !== before)
        setPanelCollapsed(panelId, before, BORROW_OPTIONS);
    }
  };

  const present = (sheet) => {
    if (sheet) body.setAttribute(MOBILE_SHEET_ATTR, sheet);
    else body.removeAttribute(MOBILE_SHEET_ATTR);
    backdrop.hidden = !sheet;
    for (const button of tabBar.querySelectorAll('[data-mobile-sheet]'))
      button.setAttribute(
        'aria-expanded',
        String(button.dataset.mobileSheet === sheet),
      );
    measureSheet();
  };

  /** The first visible control of the sheet's first panel, for focus on open. */
  const sheetFocusTarget = (sheet) => {
    if (sheet === 'search') return element('location-search');
    const panel = element(MOBILE_SHEET_PANELS[sheet][0]);
    const controls =
      panel?.querySelectorAll?.(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ) ?? [];
    // Sheets hide some panel chrome (tray toggles, pins) that stays in the
    // DOM, and a panel's own collapse control is a poor first stop.
    return (
      [...controls].find(
        (control) =>
          control.getClientRects().length > 0 &&
          !control.matches?.('.panel-collapse-btn'),
      ) ?? null
    );
  };

  const setSheet = (requested) => {
    swipe = null;
    if (!body.classList.contains(MOBILE_SHELL_CLASS)) return;
    const sheet = sheetBlocked(body) ? null : requested;
    const previous = currentSheetOf(body);
    if (previous === sheet) return;
    if (!previous) {
      borrowed = { before: panelStates(), applied: panelStates() };
      returnFocus = documentRef.activeElement ?? null;
    } else {
      if (previous === 'search') element('location-search')?.blur?.();
      restoreBorrowed();
    }
    present(sheet);
    if (!sheet) {
      borrowed = null;
      onSheetsClosed();
      const focus = returnFocus;
      returnFocus = null;
      if (focus && focus !== body && body.contains?.(focus)) focus.focus?.();
      return;
    }
    for (const panelId of MOBILE_SHEET_PANELS[sheet])
      if (isCollapsed(panelId))
        setPanelCollapsed(panelId, false, BORROW_OPTIONS);
    borrowed.applied = panelStates();
    // Rail layout settles on a later frame; what it does is part of opening.
    const opening = (borrowed.opening ?? 0) + 1;
    borrowed.opening = opening;
    const opened = borrowed;
    requestFrame?.(() => {
      if (borrowed === opened && opened.opening === opening)
        opened.applied = panelStates();
    });
    measureSheet();
    sheetFocusTarget(sheet)?.focus?.();
  };

  const tabFor = (sheet) =>
    [...tabBar.querySelectorAll('[data-mobile-sheet]')].find(
      (button) => button.dataset.mobileSheet === sheet,
    );

  const onMedia = (matches) => {
    if (matches) {
      body.classList.add(MOBILE_SHELL_CLASS);
      // Lets the page draw under the notch and system bars; the shell's CSS
      // keeps its chrome clear of them.
      if (viewport && !/viewport-fit\s*=/.test(viewportContent || ''))
        viewport.setAttribute(
          'content',
          `${viewportContent || ''}, viewport-fit=cover`,
        );
      for (const node of [...rails, dock].filter(Boolean))
        resize?.observe(node);
      measureSheet();
    } else {
      // Crossing to desktop closes the sheet, which puts its panels back.
      setSheet(null);
      body.classList.remove(MOBILE_SHELL_CLASS);
      present(null);
      resize?.disconnect();
      if (viewport && viewportContent !== null)
        viewport.setAttribute('content', viewportContent);
    }
    tabBar.setAttribute('aria-hidden', String(!matches));
  };

  const media =
    typeof matchMedia === 'function'
      ? matchMedia(MOBILE_SHELL_MEDIA_QUERY)
      : null;
  onMedia(Boolean(media?.matches));
  const onChange = (event) => onMedia(event.matches);
  if (media?.addEventListener) {
    media.addEventListener('change', onChange);
    removers.push(() => media.removeEventListener('change', onChange));
  } else if (media?.addListener) {
    // Safari before 14 only offers the legacy listener API.
    media.addListener(onChange);
    removers.push(() => media.removeListener(onChange));
  }

  listen(tabBar, 'click', (event) => {
    const button = event.target?.closest?.('[data-mobile-sheet]');
    if (!button) return;
    event.preventDefault();
    const sheet = nextSheet(currentSheetOf(body), button.dataset.mobileSheet);
    // Closing from the tab bar returns focus to the tab that was pressed.
    if (!sheet) returnFocus = button;
    setSheet(sheet);
    if (sheet && currentSheetOf(body) === sheet) onTabOpened(sheet);
  });
  listen(backdrop, 'click', () => setSheet(null));
  // Touch events let native scrolling continue until a downward pull at the
  // top is intentional. Pointer capture/touch-action:none would also seize
  // ordinary vertical scrolling inside the borrowed panels.
  const sheetRoot = (target, sheet) => {
    const roots =
      sheet === 'layers'
        ? [element('left-panel-stack')]
        : sheet === 'search'
          ? [dock]
          : sheet === 'more'
            ? [element('right-context-rail'), dock]
            : [element('right-context-rail')];
    return roots.find((root) => root?.contains(target));
  };
  const scrolled = (target, root) => {
    for (let node = target; node; node = node.parentElement) {
      if (node.scrollTop > 0) return true;
      if (node === root) break;
    }
    return false;
  };
  listen(
    documentRef,
    'touchstart',
    (event) => {
      swipe = null;
      const sheet = currentSheetOf(body);
      const target = event.target;
      if (
        !sheet ||
        !body.classList.contains(MOBILE_SHELL_CLASS) ||
        event.defaultPrevented ||
        event.touches.length !== 1 ||
        target?.closest?.(
          'button, a, input, select, textarea, label, [contenteditable]:not([contenteditable="false"]), [role="slider"], [role="button"]',
        )
      )
        return;
      const root = sheetRoot(target, sheet);
      if (!root || scrolled(target, root)) return;
      const touch = event.touches[0];
      swipe = {
        sheet,
        target,
        root,
        id: touch.identifier,
        x: touch.clientX,
        y: touch.clientY,
        claimed: false,
      };
    },
    { passive: true },
  );
  listen(
    documentRef,
    'touchmove',
    (event) => {
      if (!swipe) return;
      const touch = event.touches[0];
      if (
        event.defaultPrevented ||
        event.touches.length !== 1 ||
        touch.identifier !== swipe.id ||
        currentSheetOf(body) !== swipe.sheet ||
        scrolled(swipe.target, swipe.root)
      ) {
        swipe = null;
        return;
      }
      const dx = touch.clientX - swipe.x;
      const dy = touch.clientY - swipe.y;
      if (!swipe.claimed) {
        // Claim direction before the browser crosses its native scroll slop.
        // Android can make the next move non-cancelable after a ~9px first move.
        if (Math.max(Math.abs(dx), Math.abs(dy)) < 4) return;
        if (dy <= Math.abs(dx) * 1.25 || !event.cancelable) {
          swipe = null;
          return;
        }
        swipe.claimed = true;
      }
      // Cancelling only the claimed pull leaves taps, sliders and normal scroll
      // native, and suppresses the synthetic click at the end of a dismissal.
      event.preventDefault();
    },
    { passive: false },
  );
  listen(
    documentRef,
    'touchend',
    (event) => {
      const pull = swipe;
      swipe = null;
      if (!pull?.claimed || event.touches.length) return;
      const touch = [...event.changedTouches].find(
        (item) => item.identifier === pull.id,
      );
      if (!touch || currentSheetOf(body) !== pull.sheet) return;
      const dx = Math.abs(touch.clientX - pull.x);
      const dy = touch.clientY - pull.y;
      if (dy < 64 || dy <= dx * 1.25) return;
      returnFocus = tabFor(pull.sheet) ?? returnFocus;
      setSheet(null);
    },
    { passive: true },
  );
  listen(
    documentRef,
    'touchcancel',
    () => {
      swipe = null;
    },
    { passive: true },
  );
  // Bubble phase, so fields cancelling an edit, lightboxes, viewers and tools
  // take Escape first; panels yield it to the sheet (PanelChrome), and an open
  // dialog keeps its own native close.
  listen(documentRef, 'keydown', (event) => {
    if (event.key !== 'Escape' || event.defaultPrevented) return;
    const sheet = currentSheetOf(body);
    if (!sheet || documentRef.querySelector('dialog[open]')) return;
    event.preventDefault();
    returnFocus = tabFor(sheet) ?? returnFocus;
    setSheet(null);
  });

  if (typeof MutationObserverImpl === 'function') {
    const observer = new MutationObserverImpl(() => {
      if (currentSheetOf(body) && sheetBlocked(body)) setSheet(null);
    });
    observer.observe(body, { attributes: true, attributeFilter: ['class'] });
    removers.push(() => observer.disconnect());
  }

  return {
    setSheet,
    getSheet: () => currentSheetOf(body),
    /**
     * The collapsed state to share for a panel a sheet borrowed: its state
     * before the sheets, or the user's own change since. Undefined otherwise.
     */
    sharedCollapsed(panelId) {
      if (!borrowed?.before.has(panelId)) return undefined;
      const now = prefersCollapsed(panelId);
      return now !== borrowed.applied.get(panelId)
        ? now
        : borrowed.before.get(panelId);
    },
    destroy() {
      setSheet(null);
      for (const remove of removers.splice(0)) remove();
      body.classList.remove(MOBILE_SHELL_CLASS);
      body.removeAttribute(MOBILE_SHEET_ATTR);
      body.style.removeProperty('--mobile-sheet-height');
      body.style.removeProperty('--mobile-sheet-cover');
      if (viewport && viewportContent !== null)
        viewport.setAttribute('content', viewportContent);
      backdrop.remove();
      tabBar.remove();
    },
  };
}
