/** Own panel collapsed-state preferences and the one-time layout-reset notice. */
/** Versioned localStorage namespace prefix to invalidate stale panel layouts. */
const PANEL_LAYOUT_STORAGE_VERSION = 'v6';
/**
 * Position keys are versioned separately from collapsed-state keys. The rails
 * now lay panels out themselves and store no position; the version still names
 * the layout-reset notice and the documented key.
 */
const PANEL_POSITION_STORAGE_VERSION = 'v8';
export class PanelPositionControls {
  constructor({ syncPanelCollapseButton, showToast }) {
    this._syncPanelCollapseButton = syncPanelCollapseButton;
    this._showToast = showToast;
  }

  _maybeNotifyLayoutReset() {
    try {
      const marker = `godsEyeView.${PANEL_POSITION_STORAGE_VERSION}.layoutResetNotified`;
      if (localStorage.getItem(marker)) return;
      localStorage.setItem(marker, '1');
      const hadOldPositions = Object.keys(localStorage).some((key) =>
        key.startsWith('godsEyeView.v6.panelPos.'),
      );
      if (hadOldPositions) {
        this._showToast(
          'Panel layout updated — positions reset to new defaults',
        );
      }
    } catch {
      // storage unavailable
    }
  }

  _panelCollapseStorageKey(panelId) {
    return `godsEyeView.${PANEL_LAYOUT_STORAGE_VERSION}.panelCollapsed.${panelId}`;
  }

  _restorePanelCollapsedState(panelId, { allowStored = true } = {}) {
    const panelEl = document.getElementById(panelId);
    if (!panelEl) return;
    let collapsed = panelEl.classList.contains('collapsed');
    let stored = null;
    if (allowStored) {
      try {
        stored = localStorage.getItem(this._panelCollapseStorageKey(panelId));
        if (stored === '1') collapsed = true;
        if (stored === '0') collapsed = false;
      } catch {
        // storage unavailable
      }
    }
    // DISPLAY starts COLLAPSED for a first-time visitor, then respects the
    // user's persisted choice like every other panel.
    //
    // It used to start expanded, to advertise the HUD / DETECT / 3D toggles.
    // That reason expired when those became ON by default: the rail now opens
    // to offer controls for things already happening, while competing with the
    // first-run mission card for the one first impression there is. A stored
    // choice still wins in both directions, so anyone who opens it keeps it.
    if (panelId === 'pp-toggles' && stored === null) collapsed = true;
    panelEl.classList.toggle('collapsed', collapsed);
    // Bodies that expand themselves on first appearance must not override a
    // choice the user (or a share link) already made.
    if (panelEl.dataset)
      panelEl.dataset.collapsedPreference = !allowStored
        ? 'share'
        : stored === null
          ? 'default'
          : 'stored';
    this._syncPanelCollapseButton(panelEl);
  }

  _savePanelCollapsedState(panelId, collapsed) {
    try {
      localStorage.setItem(
        this._panelCollapseStorageKey(panelId),
        collapsed ? '1' : '0',
      );
    } catch {
      // storage unavailable
    }
  }
}
