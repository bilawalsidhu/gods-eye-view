const LAYER_ID = 'rocket-launches';
const PANEL_ID = 'space-missions-panel';

/**
 * The Space Missions panel's wiring. Space Missions is an ordinary layer: the
 * layer owns its data and Satellites dependency, and this connects it to its
 * panel. The panel shows while the layer is on, and opens when the person
 * turns the layer on (by hand or by voice) or picks a mission on the globe. Opening it closes the
 * other right-side panels, Context among them (see setPanelCollapsed).
 */
export class SpaceMissionsControls {
  /**
   * @param {object} options
   * @param {?object} options.layer The Space Missions layer.
   * @param {object} options.store The Space Missions store.
   * @param {object} options.actions
   * @param {(panelId: string, collapsed: boolean, options?: object) => void} options.actions.setPanelCollapsed
   * @param {() => boolean} options.actions.isCockpitActive
   * @param {() => void} [options.actions.revealPanel] Opens the phone sheet that
   *   holds the panel; does nothing on desktop.
   */
  constructor({ layer, store, actions }) {
    this._layer = layer || null;
    this._store = store;
    this._actions = actions;
    this._manager = null;
    this._unsubscribeManager = null;
    this.destroyed = false;
    store.connect(this._layer);
    store.publish(null);
    store.setEnabled(false);
    this._unsubscribePanel =
      this._layer?.subscribePanel?.((view) => store.publish(view)) ?? null;
    this._unsubscribeGlobePick =
      this._layer?.subscribeGlobePick?.(() => this._reveal()) ?? null;
  }

  /** Follow a data manager's Space Missions visibility; null disconnects. */
  connect(manager) {
    this._unsubscribeManager?.();
    this._unsubscribeManager = null;
    this._manager = manager || null;
    if (this.destroyed) return;
    this._syncEnabled();
    this._unsubscribeManager =
      this._manager?.subscribe?.((change) => this._handleChange(change)) ??
      null;
  }

  _syncEnabled() {
    this._store.setEnabled(Boolean(this._manager?.isEnabled?.(LAYER_ID)));
  }

  _handleChange(change) {
    if (this.destroyed || change?.layerId !== LAYER_ID) return;
    if (!String(change.type || '').startsWith('visibility')) return;
    this._syncEnabled();
    if (
      change.type === 'visibility' &&
      change.enabled &&
      (change.origin === 'user' || change.origin === 'voice')
    )
      this._reveal();
  }

  /** Open the panel, unless the Cockpit owns the screen. */
  _reveal() {
    if (this.destroyed || this._actions.isCockpitActive?.()) return;
    this._actions.setPanelCollapsed(PANEL_ID, false, { explicit: true });
    // A phone shows the rail only as tab sheets: open the Missions sheet too.
    this._actions.revealPanel?.();
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this._unsubscribeManager?.();
    this._unsubscribeManager = null;
    this._unsubscribePanel?.();
    this._unsubscribePanel = null;
    this._unsubscribeGlobePick?.();
    this._unsubscribeGlobePick = null;
    this._store.connect(null);
    this._store.publish(null);
    this._store.setEnabled(false);
  }
}
