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
  if (!ui?.panel || typeof getPreviewEnabled !== 'function')
    throw new TypeError(
      'A voice panel and Preview preference reader are required.',
    );
  if (
    typeof copy?.previewEmpty !== 'string' ||
    typeof copy?.previewDisabled !== 'string'
  )
    throw new TypeError('Localized Preview messages are required.');
  const offs = [];
  const tabs = ['previewTab', 'settingsTab'];
  const panes = { preview: 'previewPanel', settings: 'settingsPanel' };
  let disposed = false;
  let open = false;
  let view = 'preview';
  let graceTimer;
  const enabled = () => getPreviewEnabled() === true;
  const suppressed = () => view === 'preview' && getCockpitActive() === true;
  const holdsFocus = (name) =>
    Boolean(ui.element(name)?.contains?.(globalThis.document?.activeElement));
  const snapshot = () => ({
    view,
    panelOpen: !disposed && open,
    settingsOpen: !disposed && open && view === 'settings',
    previewEnabled: enabled(),
    // The card as presented, on a control the page shows.
    previewVisible:
      !disposed &&
      open &&
      view === 'preview' &&
      !suppressed() &&
      enabled() &&
      ui.state.card.visible &&
      // The error tray takes the card's place.
      ui.state.root.status !== 'error' &&
      ui.visible('root'),
  });
  const sync = () => {
    if (disposed) return;
    const hidePanel = !open || suppressed();
    const restoreFocus = hidePanel && holdsFocus('voicePanel');
    ui.update('voicePanel', {
      hidden: hidePanel,
      view,
      previewHidden: !open || view !== 'preview' || suppressed(),
      settingsHidden: !open || view !== 'settings',
      settingsExpanded: open && view === 'settings',
      selected: view,
    });
    card?.setPresented?.(open && view === 'preview' && !suppressed());
    const previewOn = enabled();
    ui.update('previewEmpty', {
      hidden: ui.state.card.visible,
      text: () => (previewOn ? copy.previewEmpty : copy.previewDisabled),
    });
    if (restoreFocus) void ui.focus(['settingsButton', 'button']);
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
    const transferFocus = changed && holdsFocus(panes[view]);
    open = true;
    view = next;
    onPresentationIntent?.({ automatic });
    sync();
    // The tab takes focus once it shows, inside a shown panel.
    if (focus || transferFocus)
      void ui.focus([tabs[next === 'preview' ? 0 : 1]]);
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
  const toggleSettings = () =>
    open && view === 'settings'
      ? close('settings')
      : select('settings', { focus: true });
  // Keep the raised row reachable across pinned trays without intercepting
  // their controls. The same lifetime owns the listeners and pending timer.
  const endGrace = () => {
    clearTimeout(graceTimer);
    if (ui.state.root.rowGrace) ui.update('root', { rowGrace: false });
  };
  offs.push(
    ui.on('settings-button', toggleSettings),
    ui.on('tab', (index) =>
      select(index === 0 ? 'preview' : 'settings', { focus: true }),
    ),
    ui.on('tab-keydown', (index, event) => {
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
    }),
    ui.on('settings-close', () => close()),
    ui.on('panel-keydown', (event) => {
      if (event.key !== 'Escape' || !open) return;
      event.preventDefault();
      close();
    }),
    ui.on('pointerleave', (event) => {
      if (event.pointerType === 'touch') return;
      endGrace();
      ui.update('root', { rowGrace: true });
      graceTimer = setTimeout(endGrace, ROW_GRACE_MS);
    }),
    ui.on('pointerenter', endGrace),
  );
  sync();
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
      for (const off of offs) off();
      endGrace();
    },
  };
}
