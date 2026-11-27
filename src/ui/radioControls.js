import { bindRadioControls } from './radioBindings.js';
import {
  createRadioTunerState,
  renderRadioState,
  showRadioTuner,
} from './radioPresentation.js';
import { useRadioStore } from './stores/radio.js';
import { applicationPinia } from './vueRuntime.js';
import { onLocaleChange } from '../i18n/index.js';

/**
 * Own Radio interaction, the tuner and the subscription; receive playback and
 * application actions. The panel view renders the rest of the Radio panel
 * from what this publishes (`gev-radio` store).
 */
export class RadioControls {
  constructor({
    elements,
    radio,
    actions,
    canvas,
    store = useRadioStore(applicationPinia()),
  }) {
    Object.assign(this, elements);
    this.store = store;
    this.radio = radio;
    this.actions = actions;
    this.canvas = canvas;
    this.destroyed = false;
    this.listeners = new AbortController();
    this._radioUnsubscribe = null;
    this._radioState = null;
    this._radioView = null;
    this._radioVolumeShown = null;
    this._cockpitDisclosure = { display: false, radio: false };
    this._radioTunerView = createRadioTunerState();
    this._radioTunerStations = [];
    this._radioTunerPool = [];
    this._radioTunerDragging = false;
    this._radioTunerDragStartSlot = 0;
    this._radioTunerDragSnapshot = null;
    this._radioTunerLastSlot = 0;
    this._radioTunerDragDirection = 0;
    this._radioTunerCoordinate = 0;
    this._radioTunerPointerId = null;
    this._radioTunerKeyboardKey = null;
    this._radioTunerBandSignature = '';
    this._radioTunerSelectedId = null;
    this._radioTunerBandPinnedForNavigation = false;
    this._refreshRadioTunerBand = null;
    this._refreshRadioTunerText = null;
    bindRadioControls.call(this);
    // The panel carries translated text; present it again in a new locale,
    // from a fresh layer state when there is one (its category labels are
    // worded by the layer).
    this._offLocale = onLocaleChange(() => {
      const state = this.radio.getUIState?.() ?? this._radioState;
      if (state) this._renderRadioState(state);
      this._refreshRadioTunerText?.();
    });
  }

  listen(target, type, handler, options = {}) {
    target?.addEventListener(type, handler, {
      ...options,
      signal: this.listeners.signal,
    });
  }

  connect() {
    this._radioUnsubscribe?.();
    this._radioUnsubscribe = null;
    if (this.destroyed) return;
    this._radioUnsubscribe = this.radio.subscribe?.((state) =>
      this._renderRadioState(state),
    );
  }

  _renderRadioState(state) {
    renderRadioState.call(this, state);
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this._offLocale();
    this.listeners.abort();
    if (this._storeToken) this.store.detach(this._storeToken);
    this._radioUnsubscribe?.();
    this._radioUnsubscribe = null;
    const pointer = this._radioTunerPointerId;
    this._radioTunerPointerId = null;
    this._radioTunerDragging = false;
    this._radioTunerKeyboardKey = null;
    this._radioTunerDragSnapshot = null;
    this._radioTunerPool = [];
    this._radioTunerStations = [];
    this._radioTunerBandPinnedForNavigation = false;
    try {
      if (pointer !== null)
        this._radioTunerSlider?.releasePointerCapture(pointer);
    } catch {
      /* capture already released */
    }
    showRadioTuner.call(this, { dragging: false, static: false });
    document
      .getElementById('title-bar')
      ?.classList.remove('radio-broadcasting');
    this.radio.endTuning();
  }
}
