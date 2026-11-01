const ROW_GRACE_MS = 700;

/** Manual presentation only. Session and action events belong to the host. */
export function createManualVoicePanel({
  ui,
  card,
  getPreviewEnabled,
  getCockpitActive = () => false,
  copy,
  onPresentationIntent,
}) {
  if (!ui?.voicePanel || typeof getPreviewEnabled !== 'function')
    throw new TypeError(
      'A voice panel and Preview preference reader are required.',
    );
  if (
    typeof copy?.previewEmpty !== 'string' ||
    typeof copy?.previewDisabled !== 'string'
  )
    throw new TypeError('Localized Preview messages are required.');
  const lifetime = new AbortController();
  const panel = ui.voicePanel;
  const tabs = [ui.previewTab, ui.settingsTab];
  const doc = panel.ownerDocument;
  let disposed = false;
  let open = false;
  let view = 'preview';
  const enabled = () => getPreviewEnabled() === true;
  const suppressed = () => view === 'preview' && getCockpitActive() === true;
  const visible = (element) =>
    Boolean(
      element &&
      !element.hidden &&
      element.isConnected !== false &&
      element.checkVisibility?.({
        opacityProperty: true,
        visibilityProperty: true,
      }) !== false,
    );
  const snapshot = () => ({
    view,
    panelOpen: !disposed && open,
    settingsOpen: !disposed && open && view === 'settings',
    previewEnabled: enabled(),
    previewVisible:
      !disposed &&
      open &&
      view === 'preview' &&
      !suppressed() &&
      enabled() &&
      visible(ui.card),
  });
  const sync = () => {
    if (disposed) return;
    const hidePanel = !open || suppressed();
    const restoreFocus = hidePanel && panel.contains?.(doc?.activeElement);
    panel.hidden = hidePanel;
    panel.dataset.view = view;
    if (ui.previewPanel)
      ui.previewPanel.hidden = !open || view !== 'preview' || suppressed();
    if (ui.voiceSettingsPanel)
      ui.voiceSettingsPanel.hidden = !open || view !== 'settings';
    ui.voiceSettingsButton?.setAttribute(
      'aria-expanded',
      String(open && view === 'settings'),
    );
    tabs.forEach((tab, index) => {
      if (!tab) return;
      const selected = view === (index === 0 ? 'preview' : 'settings');
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
    });
    card?.setPresented?.(open && view === 'preview' && !suppressed());
    if (ui.previewEmpty) {
      ui.previewEmpty.hidden = Boolean(ui.card && !ui.card.hidden);
      ui.previewEmpty.textContent = enabled()
        ? copy.previewEmpty
        : copy.previewDisabled;
    }
    if (restoreFocus)
      [ui.voiceSettingsButton, ui.button].find(visible)?.focus?.();
  };
  const refuse = (reason) => ({
    ok: false,
    changed: false,
    reason,
    ...snapshot(),
  });
  const select = (next, { focus = false, automatic = false } = {}) => {
    if (disposed) return refuse('disposed');
    if (!['preview', 'settings'].includes(next)) return refuse('unknown-view');
    const changed = !open || view !== next;
    const outgoing =
      view === 'preview' ? ui.previewPanel : ui.voiceSettingsPanel;
    const transferFocus = changed && outgoing?.contains?.(doc?.activeElement);
    open = true;
    view = next;
    onPresentationIntent?.({ automatic });
    sync();
    const tab = tabs[next === 'preview' ? 0 : 1];
    if ((focus || transferFocus) && visible(panel) && visible(tab))
      tab.focus?.();
    return { ok: true, changed, ...snapshot() };
  };
  const close = (onlyView) => {
    if (disposed) return refuse('disposed');
    if (onlyView && !['preview', 'settings'].includes(onlyView))
      return refuse('unknown-view');
    if (onlyView && onlyView !== view)
      return { ok: true, changed: false, ...snapshot() };
    const changed = open;
    open = false;
    onPresentationIntent?.();
    sync();
    return { ok: true, changed, ...snapshot() };
  };
  const listen = (element, type, handler) =>
    element?.addEventListener(type, handler, { signal: lifetime.signal });
  const toggleSettings = () =>
    open && view === 'settings'
      ? close('settings')
      : select('settings', { focus: true });
  try {
    listen(ui.voiceSettingsButton, 'click', toggleSettings);
    tabs.forEach((tab, index) => {
      listen(tab, 'click', () =>
        select(index === 0 ? 'preview' : 'settings', { focus: true }),
      );
      listen(tab, 'keydown', (event) => {
        const next =
          event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? 1
              : ['ArrowLeft', 'ArrowRight'].includes(event.key)
                ? 1 - index
                : null;
        if (next === null) return;
        event.preventDefault();
        select(next === 0 ? 'preview' : 'settings', { focus: true });
      });
    });
    listen(ui.voiceSettingsClose, 'click', () => close());
    listen(panel, 'keydown', (event) => {
      if (event.key !== 'Escape' || !open) return;
      event.preventDefault();
      close();
    });
    // Keep the raised row reachable across pinned trays without intercepting
    // their controls. The same lifetime owns the listeners and pending timer.
    let graceTimer;
    const endGrace = () => {
      clearTimeout(graceTimer);
      if (ui.root) delete ui.root.dataset.rowGrace;
    };
    listen(ui.root, 'pointerleave', (event) => {
      if (event.pointerType === 'touch') return;
      endGrace();
      ui.root.dataset.rowGrace = 'true';
      graceTimer = setTimeout(endGrace, ROW_GRACE_MS);
    });
    listen(ui.root, 'pointerenter', endGrace);
    lifetime.signal.addEventListener('abort', endGrace, { once: true });
    sync();
  } catch (error) {
    lifetime.abort();
    throw error;
  }
  return {
    select,
    close,
    sync,
    snapshot,
    destroy() {
      if (disposed) return;
      open = false;
      sync();
      disposed = true;
      lifetime.abort();
    },
  };
}
