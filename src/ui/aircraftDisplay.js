import { useDisplayStore } from './stores/display.js';
import { applicationPinia } from './vueRuntime.js';

/** Own the shared aircraft display preference and its controls. */
export class AircraftDisplay {
  constructor({
    elements,
    readDataManager,
    layout,
    store = useDisplayStore(applicationPinia()),
  }) {
    Object.assign(this, elements, {
      readDataManager,
      store,
      _layoutRightPanels: layout,
    });
    // Both aircraft layers default to models enabled in proximity mode.
    this._models3dEnabled = true;
    this._models3dMode = 'proximity';
    // What the button, mode row and mode segments show; null until first
    // synced, so the initial markup stands. Enabling from the button leaves
    // the row to its own sync, so each is held apart.
    this._models3dPressedShown = null;
    this._models3dRowShown = null;
    this._models3dModeShown = null;
  }
  get _dataManager() {
    return this.readDataManager();
  }
  _setModels3dParams(params, { origin = 'user' } = {}) {
    this._dataManager?.setLayerParams('flights', params, { origin });
    this._dataManager?.setLayerParams('military', params, { origin });
  }

  _syncModels3dFromLayerState(state) {
    const options = state?.options?.flights;
    if (!options) return;
    this._models3dEnabled = options.models3d === true;
    this._models3dMode = options.models3dMode === 'all' ? 'all' : 'proximity';
    this._models3dPressedShown = this._models3dEnabled;
    this._models3dRowShown = this._models3dEnabled;
    this._models3dModeShown = this._models3dMode;
    this._publishModels3d();
    this._layoutRightPanels();
  }

  _syncModels3dModeRow() {
    this._models3dRowShown = this._models3dEnabled;
    this._publishModels3d();
    this._layoutRightPanels();
  }

  /** Present the 3D aircraft group as its controls show it. */
  _publishModels3d() {
    this.store.publishModels3d({
      pressed: this._models3dPressedShown,
      rowVisible: this._models3dRowShown,
      mode: this._models3dModeShown,
    });
  }

  _initModels3dToggle() {
    if (!this._models3dBtn) return;
    this._syncModels3dButtonState();
    this._syncModels3dModeRow();
  }

  _setModels3dEnabled(enabled) {
    this._models3dEnabled = !!enabled;
    this._setModels3dParams({ models3d: this._models3dEnabled });
    this._syncModels3dButtonState();
  }

  _setModels3dMode(mode) {
    const normalized = mode === 'all' ? 'all' : 'proximity';
    this._models3dMode = normalized;
    this._setModels3dParams({ models3dMode: normalized });
    this._models3dModeShown = normalized;
    this._syncModels3dButtonState();
  }

  _syncModels3dButtonState() {
    // The lit/dark state is a colour to a sighted operator and nothing at all to
    // a screen reader without aria-pressed, which the view renders with it. It
    // matters more now that the button ships ACTIVE from markup (default-on,
    // 2026-08-22): the very first thing assistive tech reported was an
    // unpressed-looking control over an armed layer.
    this._models3dPressedShown = this._models3dEnabled;
    this._publishModels3d();
  }
}
