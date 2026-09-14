/** Track listeners so a discarded controller leaves no active DOM callbacks. */
function listenerScope() {
  const removers = [];
  return {
    listen(target, type, callback, options) {
      if (!target) return;
      target.addEventListener(type, callback, options);
      removers.push(() => target.removeEventListener(type, callback, options));
    },
    destroy() {
      for (const remove of removers.splice(0)) remove();
    },
  };
}

/** Bind collapse buttons and bubbling Escape to an existing panel. */
export function bindPanelDisclosure({
  panel,
  buttons = [],
  onChange,
  onEscape,
}) {
  if (
    !panel ||
    typeof onChange !== 'function' ||
    typeof onEscape !== 'function'
  ) {
    throw new TypeError(
      'Panel disclosure requires a panel, onChange and onEscape',
    );
  }
  const scope = listenerScope();
  for (const button of new Set(buttons)) {
    scope.listen(button, 'click', () => {
      onChange(!panel.classList.contains('collapsed'), { explicit: true });
    });
  }
  scope.listen(panel, 'keydown', onEscape);
  return { destroy: () => scope.destroy() };
}

/** Close the nearest expanded panel and return focus to its disclosure. */
export function collapsePanelOnEscape(
  event,
  { panel, onChange, beforeCollapse },
) {
  if (event.key !== 'Escape' || event.defaultPrevented) return false;
  if (
    !panel ||
    panel.classList.contains('collapsed') ||
    !panel.contains(event.target)
  )
    return false;
  const focusedPanel = event.target?.closest?.(
    '.panel-collapsible:not(.collapsed), #param-slider-panel:not(.collapsed)',
  );
  if (focusedPanel && focusedPanel !== panel) return false;
  event.preventDefault();
  event.stopPropagation();
  beforeCollapse?.();
  onChange(true, { explicit: true });
  const disclosure =
    panel.querySelector(`[data-dock-toggle-target="${panel.id}"]`) ||
    panel.querySelector(`[data-collapse-target="${panel.id}"]`);
  const escapedFromDisclosure =
    event.target === disclosure || disclosure?.contains?.(event.target);
  if (escapedFromDisclosure) disclosure?.blur?.();
  else disclosure?.focus?.({ preventScroll: true });
  return true;
}

/**
 * Own hover/focus timing for an existing dock tray. Application callbacks own
 * collapsed state and optional content focus; destroying cancels every timer
 * and listener without changing saved state or moving focus.
 */
export function createHoverDisclosure({
  panel: panelEl,
  disclosure = null,
  onChange,
  onEscape,
  focusTarget = null,
  isActive = () => true,
  openDelayMs = 850,
  closeDelayMs = 1000,
  documentRef = panelEl?.ownerDocument,
}) {
  if (
    !panelEl ||
    !documentRef ||
    typeof onChange !== 'function' ||
    typeof onEscape !== 'function'
  ) {
    throw new TypeError(
      'Hover disclosure requires a panel, document, onChange and onEscape',
    );
  }
  const document = documentRef;
  const window = document.defaultView;
  const clearTimeout = window.clearTimeout.bind(window);
  const performance = window.performance;
  const scope = listenerScope();
  const listen = scope.listen;
  let destroyed = false;
  let openTimer = null;
  let closeTimer = null;
  let lastWheelTime = 0;
  let disclosureFocusTimer = null;
  let focusRequest = 0;

  const cancelPendingFocus = () => {
    clearTimeout(disclosureFocusTimer);
    disclosureFocusTimer = null;
    focusRequest += 1;
  };

  const clearOpen = () => {
    if (!openTimer) return;
    clearTimeout(openTimer);
    openTimer = null;
  };

  const clearClose = () => {
    if (!closeTimer) return;
    clearTimeout(closeTimer);
    closeTimer = null;
  };

  const scheduleOpen = () => {
    clearOpen();
    openTimer = window.setTimeout(() => {
      openTimer = null;
      if (destroyed || !isActive()) return;
      if (!panelEl.matches(':hover')) return;
      if (performance.now() - lastWheelTime < 280) return;
      if (!panelEl.classList.contains('collapsed')) return;
      onChange(false);
    }, openDelayMs);
  };

  // Focus inside the tray defers the unpinned auto-dismiss, but only for the
  // KEYBOARD: the disclosure hands focus to a Map Source tile on Enter/Space,
  // and closing the tray out from under that focus would strand the caret.
  // Plain `document.activeElement` is the wrong test — Chromium focuses a
  // <button> on mouse press, so once Map Source moved into this tray a tile
  // CLICK left focus parked inside and the popover never dismissed on
  // mouse-away (owner field report; Location, whose input is genuinely
  // keyboard-focused when clicked, still dismissed). `:focus-visible` is the
  // platform's own pointer-vs-keyboard focus signal, so a typed-into field
  // still holds the tray open while a clicked tile does not. A browser
  // without `:focus-visible` keeps the conservative hold.
  const keyboardFocusInside = () => {
    const active = document.activeElement;
    if (!active || !panelEl.contains(active)) return false;
    try {
      return active.matches(':focus-visible');
    } catch {
      return true;
    }
  };

  const scheduleClose = () => {
    clearClose();
    closeTimer = window.setTimeout(() => {
      closeTimer = null;
      if (destroyed || !isActive()) return;
      if (panelEl.matches(':hover') || keyboardFocusInside()) return;
      if (panelEl.classList.contains('dock-pinned')) return;
      if (panelEl.classList.contains('collapsed')) return;
      onChange(true);
    }, closeDelayMs);
  };

  listen(
    panelEl,
    'wheel',
    () => {
      lastWheelTime = performance.now();
      clearOpen();
    },
    { passive: true },
  );

  listen(panelEl, 'click', (event) => {
    if (event.target.closest('.panel-collapse-btn, .dock-tray-toggle')) return;
    clearOpen();
    clearClose();
    if (panelEl.classList.contains('collapsed')) {
      onChange(false, { explicit: true });
    }
  });

  listen(panelEl, 'pointerenter', (event) => {
    const pointerType = event.pointerType || 'mouse';
    if (pointerType !== 'mouse' && pointerType !== 'pen') return;
    clearClose();
    if (panelEl.classList.contains('collapsed')) {
      scheduleOpen();
    }
  });

  listen(panelEl, 'pointerleave', (event) => {
    const pointerType = event.pointerType || 'mouse';
    if (pointerType !== 'mouse' && pointerType !== 'pen') return;
    clearOpen();
    scheduleClose();
  });

  listen(panelEl, 'pointerdown', () => {
    cancelPendingFocus();
    clearOpen();
    clearClose();
  });

  const focusContent = () => {
    const target = focusTarget?.();
    if (destroyed || !isActive() || !target?.focus) return false;
    target.focus({ preventScroll: true });
    return document.activeElement === target;
  };

  // The tray opens behind a 180ms `visibility` transition (.dock-popover-content
  // in style.css), and a chip inside it cannot take focus until that lands.
  // A single fixed delay therefore races the transition: when the machine is
  // slow enough that the fade has not finished by the time the timer fires,
  // focus() silently does nothing and the keyboard user is stranded on the
  // disclosure with an open tray they cannot reach (#54). Retry on a short
  // cadence until focus actually lands, bounded so a permanently hidden tray
  // cannot spin.
  const scheduleContentFocus = () => {
    cancelPendingFocus();
    if (destroyed || !isActive() || !focusTarget) return;
    const request = focusRequest;
    let attempts = 0;
    const attemptFocus = () => {
      if (request !== focusRequest) return;
      disclosureFocusTimer = null;
      if (destroyed || !isActive() || panelEl.classList.contains('collapsed'))
        return;
      // A Tab or click elsewhere owns focus now. A delayed transition must
      // not pull the keyboard back into a tray the user has already left.
      if (document.activeElement !== disclosure) return;
      if (focusContent()) return;
      if (request !== focusRequest) return;
      if (++attempts > 24) return; // ~720ms past the first try, then give up
      disclosureFocusTimer = window.setTimeout(attemptFocus, 30);
    };
    disclosureFocusTimer = window.setTimeout(attemptFocus, 240);
  };

  const toggleDisclosure = ({ focusContent = false } = {}) => {
    if (destroyed || !isActive()) return;
    cancelPendingFocus();
    clearOpen();
    clearClose();
    const shouldOpen = panelEl.classList.contains('collapsed');
    onChange(!shouldOpen, { explicit: true });
    if (shouldOpen && focusContent) scheduleContentFocus();
  };

  listen(disclosure, 'click', (event) => {
    event.stopPropagation();
    // Keep native button activation semantics: Enter activates on keydown,
    // Space on keyup, and pointer clicks report a non-zero detail. Scheduling
    // focus from the synthesized click avoids a key latch that can outlive the
    // disclosure after a long Enter hold moves focus into the tray.
    toggleDisclosure({ focusContent: event.detail === 0 });
  });
  listen(disclosure, 'keydown', (event) => {
    if (event.key !== 'Enter') return;
    // Preserve immediate Enter activation while leaving Space to the native
    // button path, which emits its synthesized click only after key release.
    event.preventDefault();
    event.stopPropagation();
    if (event.repeat) return;
    toggleDisclosure({ focusContent: true });
  });

  listen(panelEl, 'focusin', () => clearClose());
  listen(panelEl, 'focusout', (event) => {
    cancelPendingFocus();
    if (panelEl.contains(event.relatedTarget)) return;
    scheduleClose();
  });
  listen(panelEl, 'keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (!event.defaultPrevented) onEscape(event);
    cancelPendingFocus();
    clearOpen();
    clearClose();
  });
  return {
    cancelPendingFocus,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      clearOpen();
      clearClose();
      cancelPendingFocus();
      scope.destroy();
    },
  };
}
