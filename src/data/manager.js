import { LayerLifecycle } from './lifecycle.js';
import { LayerPresentation } from '../app/layerPresentation.js';
export { layerFeedState } from '../ui/layers.js';

/** Compatibility facade for callers that construct a manager with its panel. */
export class DataLayerManager extends LayerLifecycle {
  constructor(viewer, options) {
    super(viewer, options);
    this._presentation = new LayerPresentation(this);
  }
  buildTogglePanel(container) {
    this._presentation.mount(container);
  }
  _refreshTogglePanel() {
    this._presentation.refresh();
  }

  /**
   * Repaint the toggle panel now. For layers whose data arrives outside their
   * manager tick (camera-driven loads such as Transit's proximity polls), so a
   * row shows its count when the data lands instead of at the next interval.
   * One DOM pass; skipped while the document is hidden.
   */
  refreshLayerStats() {
    this._refreshTogglePanel();
  }

  _buildMetaText(layer) {
    return this._presentation.panel._buildMetaText(layer);
  }
  _syncToggleButton(button, layer) {
    return this._presentation.panel._syncToggleButton(button, layer);
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
