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

/**
 * Bind bubbling Escape to an existing panel. Its collapse buttons are views
 * that ask the panel's owner to toggle it (PanelCollapseButton).
 */
export function bindPanelDisclosure({ panel, onEscape, ...retired }) {
  if (!panel || typeof onEscape !== 'function') {
    throw new TypeError('Panel disclosure requires a panel and onEscape');
  }
  // Buttons are views now; a caller still passing them would lose its clicks.
  if ('buttons' in retired || 'onChange' in retired) {
    throw new TypeError(
      'Panel disclosure binds Escape only; render the buttons as views',
    );
  }
  const scope = listenerScope();
  scope.listen(panel, 'keydown', onEscape);
  return { destroy: () => scope.destroy() };
}

/**
 * Close the nearest expanded panel and return focus to its disclosure, or to
 * `returnFocusTo()` when that names a control (a rail item standing in for a
 * panel that collapsing hid).
 */
export function collapsePanelOnEscape(
  event,
  { panel, onChange, beforeCollapse, returnFocusTo },
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
  const stand = returnFocusTo?.();
  if (stand) {
    stand.focus?.({ preventScroll: true });
    return true;
  }
  const disclosure = panel.querySelector(
    `[data-collapse-target="${panel.id}"]`,
  );
  const escapedFromDisclosure =
    event.target === disclosure || disclosure?.contains?.(event.target);
  if (escapedFromDisclosure) disclosure?.blur?.();
  else disclosure?.focus?.({ preventScroll: true });
  return true;
}
