import { LayerPanel } from '../ui/layers.js';
import { governorRequestRender } from '../renderGovernor.js';
import { markDetectionSourcesChanged } from '../data/detection.js';
import { CyberIntelPanel } from '../ui/cyberIntelPanel.js';

/** Own the layer panel and application reactions to lifecycle activity. */
export class LayerPresentation {
  constructor(
    manager,
    {
      weatherClock,
      requestRender = governorRequestRender,
      invalidateDetection = markDetectionSourcesChanged,
    } = {},
  ) {
    this.manager = manager;
    this.weatherClock = weatherClock;
    this._panel = null;
    this._cyberIntelPanel = null;
    this.pendingVisible = false;
    this._unsubscribe = manager.subscribeActivity((change) => {
      if (change.type === 'status') {
        this.refresh();
        this._refreshCyberIntel();
      } else if (change.type === 'destroy-all') this.destroy();
      else {
        const reason =
          change.type === 'data-updated'
            ? `layer-tick:${change.layerId}`
            : change.type === 'visibility-settled'
              ? 'layer-visibility'
              : change.type === 'params-settled'
                ? `layer-params:${change.layerId}`
                : null;
        if (!reason) return;
        this._refreshCyberIntel();
        requestRender(reason);
        if (change.type !== 'params-settled') invalidateDetection(reason);
      }
    });
  }
  get panel() {
    if (!this._panel)
      this._panel = new LayerPanel({
        weatherClock: this.weatherClock,
        getLayers: () => this.manager.getAll(),
        isEnabled: (id) => this.manager.isEnabled(id),
        setEnabled: (id, enabled, options) =>
          this.manager.setEnabled(id, enabled, options),
        setLayerParams: (id, params, options) =>
          this.manager.setLayerParams(id, params, options),
        getRowControls: (id) => {
          const module = this.manager.layers.get(id)?.module;
          try {
            return module?.getRowControls?.() || null;
          } catch (error) {
            console.warn(`[Data] ${id} getRowControls error:`, error);
            return null;
          }
        },
        hasRowControls: (id) =>
          typeof this.manager.layers.get(id)?.module?.getRowControls ===
          'function',
        subscribeRowControls: (id, listener) => {
          const module = this.manager.layers.get(id)?.module;
          module?.setRowControlsListener?.(listener);
          return () => module?.setRowControlsListener?.(null);
        },
        onHiddenRefresh: () => {
          this.pendingVisible = true;
        },
      });
    return this._panel;
  }
  mount(container) {
    this.panel.mount(container);
    this._cyberIntelPanel = new CyberIntelPanel();
    this._cyberIntelPanel.mount(this.manager.layers.get('cyber')?.module);
  }
  _refreshCyberIntel() {
    const module = this.manager.layers.get('cyber')?.module;
    if (module) this._cyberIntelPanel?.render(module.getThreatIntelState?.());
  }
  /** Hand the Recent Imagery readout factory to the panel (see LayerPanel). */
  attachRecentImagery(factory) {
    // Detaching never builds a panel that teardown already released.
    if (factory) this.panel.attachRecentImagery(factory);
    else this._panel?.attachRecentImagery(null);
  }
  refresh() {
    this._panel?._refreshTogglePanel();
  }
  flushVisible() {
    if (!this.pendingVisible) return;
    this.pendingVisible = false;
    this.refresh();
  }
  destroy() {
    this._panel?.destroy();
    this._panel = null;
    this._cyberIntelPanel?.destroy();
    this._cyberIntelPanel = null;
    this.pendingVisible = false;
    this._unsubscribe?.();
    this._unsubscribe = null;
  }
}
