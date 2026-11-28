// Test harness: a layer lifecycle constructed with its panel, as the tests drive it.
import { LayerLifecycle } from '../data/lifecycle.js';
import { LayerPresentation } from '../app/layerPresentation.js';

export class DataLayerManager extends LayerLifecycle {
  constructor(viewer, options) {
    super(viewer, { visibilityTarget: globalThis.document, ...options });
    this._presentation = new LayerPresentation(this);
  }
  buildTogglePanel(container) {
    this._presentation.mount(container);
  }

  _buildMetaText(layer) {
    return this._presentation.panel._buildMetaText(layer);
  }
  get _layerPanel() {
    return this._presentation._panel;
  }
}
