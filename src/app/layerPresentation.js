import { LayerPanel } from '../ui/layers.js';
import { governorRequestRender } from '../renderGovernor.js';
import { markDetectionSourcesChanged } from '../data/detection.js';

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
    this._unsubscribe = manager.subscribeActivity((change) => {
      // A layer's state or its `panel.invalidate()`: the panel paints on its
      // next frame, whatever else changes before then included.
      if (change.type === 'status') this._panel?.invalidate();
      else if (change.type === 'panel') this._panel?.invalidate(change.layerId);
      else if (change.type === 'registrations') this._panel?.rerender();
      else if (change.type === 'destroy-all') this.destroy();
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
      });
    return this._panel;
  }
  mount(container) {
    this.panel.mount(container);
  }
  /** Hand the Recent Imagery readout factory to the panel (see LayerPanel). */
  attachRecentImagery(factory) {
    // Detaching never builds a panel that teardown already released.
    if (factory) this.panel.attachRecentImagery(factory);
    else this._panel?.attachRecentImagery(null);
  }
  /** The page is shown again: paint what was invalidated while it was hidden. */
  flushVisible() {
    this._panel?.paintPending();
  }
  destroy() {
    this._panel?.destroy();
    this._panel = null;
    this._unsubscribe?.();
    this._unsubscribe = null;
  }
}
