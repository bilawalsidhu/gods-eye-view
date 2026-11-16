import {
  EMPTY_CCTV_FRAME,
  _clearCctvFrame,
  _queueCctvFrame,
  _setCctvFrame,
  _settleCctvFrame,
  _syncCctvSourceBadge,
} from './cctvFrames.js';
import {
  _activeCctvCameraId,
  _resetCctvCalibration,
  _beginCctvCalValueEdit,
} from './cctvCalibration.js';
import {
  _calBadgeLabel,
  _renderCctvState,
  _publishCctvChip,
  _typeCctvSummary,
  _updateCctvSyncChip,
} from './cctvPresentation.js';
import { _initCctvPanel } from './cctvBindings.js';
import { useCctvStore } from './stores/cctv.js';
import { useStatusStore } from './stores/status.js';
import { applicationPinia } from './vueRuntime.js';
import { onLocaleChange } from '../i18n/index.js';
import { createQuebecCctvOverlay } from './quebecCctvOverlay.js';

/**
 * Own camera-panel interaction and presentation; receive the camera port and
 * application actions. The panel view renders the buttons, CAL chip and meta
 * line from what this publishes (`gev-cctv` store), and the scene chrome the
 * camera grid chip (`gev-status` store).
 */
export class CctvControls {
  constructor({
    elements,
    cctv,
    viewer = null,
    actions,
    store = useCctvStore(applicationPinia()),
    statusStore = useStatusStore(applicationPinia()),
  }) {
    Object.assign(this, elements);
    this.store = store;
    this.statusStore = statusStore;
    this.cctv = cctv;
    this._quebecCctvOverlay = createQuebecCctvOverlay(viewer);
    this.actions = actions;
    this.destroyed = false;
    this.listeners = new AbortController();
    this._cctvUnsubscribe = null;
    this._cctvState = null;
    this._lastQuebecSelectionRevision = null;
    this._cctvSummaryTypingTimer = null;
    this._lastCctvSummaryText = '';
    this._lastSeenCctvActiveId = null;
    this._wasCctvEnabled = false;
    this._cctvChipHideTimer = null;
    this._cctvChipWasBusy = false;
    // The camera grid chip as last published; its label stays while hidden.
    this._cctvChip = null;
    this._cctvFrameRequestToken = 0;
    this._cctvFramePreloader = null;
    this._frame = EMPTY_CCTV_FRAME;
    this._calibrationEdit = null;
    this._actionGeneration = 0;
    this._initCctvPanel();
    // The panel and the grid chip hold translated text; show it again in a
    // new locale, from a fresh layer state when there is one (its summary is
    // worded by the layer).
    this._offLocale = onLocaleChange(() => {
      const state = this.cctv?.getUIState?.() ?? this._cctvState;
      if (state) this._renderCctvState(state);
      if (this._cctvChip) this._publishCctvChip({});
    });
    if (this._cctvVideo && typeof MutationObserver !== 'undefined') {
      this._videoVisibilityObserver = new MutationObserver(() =>
        this._renderCctvState(this._cctvState),
      );
      if (this._cctvPanel)
        this._videoVisibilityObserver.observe(this._cctvPanel, {
          attributes: true,
          attributeFilter: ['class', 'hidden'],
        });
      this.listen(document, 'visibilitychange', () =>
        this._renderCctvState(this._cctvState),
      );
    }
  }
  listen(target, type, handler, options = {}) {
    target?.addEventListener(type, handler, {
      ...options,
      signal: this.listeners.signal,
    });
  }
  getState() {
    return this._cctvState;
  }
  connect() {
    this._cctvUnsubscribe?.();
    this._cctvUnsubscribe = null;
    if (this.destroyed) return;
    this._cctvUnsubscribe = this.cctv.subscribe?.((state) =>
      this._renderCctvState(state),
    );
    if (this.cctv.getUIState) this._renderCctvState(this.cctv.getUIState());
  }
  _clearCctvFrame(...args) {
    return _clearCctvFrame.call(this, ...args);
  }
  _setCctvFrame(...args) {
    return _setCctvFrame.call(this, ...args);
  }
  _queueCctvFrame(...args) {
    return _queueCctvFrame.call(this, ...args);
  }
  _settleCctvFrame(...args) {
    return _settleCctvFrame.call(this, ...args);
  }
  _syncCctvSourceBadge(...args) {
    return _syncCctvSourceBadge.call(this, ...args);
  }
  _activeCctvCameraId(...args) {
    return _activeCctvCameraId.call(this, ...args);
  }
  _resetCctvCalibration(...args) {
    return _resetCctvCalibration.call(this, ...args);
  }
  _beginCctvCalValueEdit(...args) {
    return _beginCctvCalValueEdit.call(this, ...args);
  }
  _calBadgeLabel(...args) {
    return _calBadgeLabel.call(this, ...args);
  }
  _renderCctvState(...args) {
    return _renderCctvState.call(this, ...args);
  }
  _typeCctvSummary(...args) {
    return _typeCctvSummary.call(this, ...args);
  }
  _publishCctvChip(...args) {
    return _publishCctvChip.call(this, ...args);
  }
  _updateCctvSyncChip(...args) {
    return _updateCctvSyncChip.call(this, ...args);
  }
  _initCctvPanel(...args) {
    return _initCctvPanel.call(this, ...args);
  }
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this._offLocale();
    this._quebecCctvOverlay?.dispose();
    this._cctvVideoSurface?.stop();
    this._videoVisibilityObserver?.disconnect();
    this._actionGeneration++;
    this.listeners.abort();
    this._cctvUnsubscribe?.();
    this._cctvUnsubscribe = null;
    this._calibrationEdit?.(false);
    this._clearCctvFrame();
    clearInterval(this._cctvSummaryTypingTimer);
    clearTimeout(this._cctvChipHideTimer);
    this._cctvSummaryTypingTimer = null;
    this._cctvChipHideTimer = null;
    this._publishCctvChip({ visible: false, stopped: true });
  }
}
