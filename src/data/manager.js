import { LayerLifecycle } from './lifecycle.js';
import { LayerPresentation } from '../app/layerPresentation.js';
export { layerFeedState } from '../ui/layers.js';

/** Compatibility facade for callers that construct a manager with its panel. */
export class DataLayerManager extends LayerLifecycle {
  constructor(viewer, options) {
    super(viewer, { visibilityTarget: globalThis.document, ...options });
    this._presentation = new LayerPresentation(this);
  }
  buildTogglePanel(container) {
    this._presentation.mount(container);
  }
  _refreshTogglePanel() {
    this._presentation.refresh();
  }

  _buildMetaText(layer) {
    return this._presentation.panel._buildMetaText(layer);
  }
  get _layerPanel() {
    return this._presentation._panel;
  }
  get _panelRefreshPendingOnVisible() {
    return this._presentation.pendingVisible;
  }
  set _panelRefreshPendingOnVisible(value) {
    this._presentation.pendingVisible = value;
  }
}
