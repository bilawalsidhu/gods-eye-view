import {
  internetRadioAudioActive,
  localSdrCardView,
  localSdrFmAudioActive,
} from './localSdrPresentation.js';

const ELEMENT_IDS = Object.freeze({
  card: 'sdr-radio-card',
  connectionState: 'sdr-connection-state',
  connect: 'sdr-connect-btn',
  locate: 'sdr-locate-btn',
  changeDevice: 'sdr-change-device-btn',
  modeFm: 'sdr-mode-fm-btn',
  modeAdsb: 'sdr-mode-adsb-btn',
  gain: 'sdr-gain-select',
  stats: 'sdr-adsb-stats',
  statRate: 'sdr-stat-rate',
  statHeard: 'sdr-stat-heard',
  statPositioned: 'sdr-stat-positioned',
  statIq: 'sdr-stat-iq',
  frequency: 'sdr-frequency-input',
  tune: 'sdr-tune-btn',
  seekBack: 'sdr-seek-back-btn',
  seekForward: 'sdr-seek-forward-btn',
  volume: 'sdr-volume',
  volumeValue: 'sdr-volume-value',
  status: 'sdr-status',
});

function setText(element, text) {
  if (element && element.textContent !== text) element.textContent = text;
}

/**
 * Local RTL-SDR card in the Radio panel.
 *
 * Owns the card's listeners and its receiver/radio subscriptions. The Radio
 * panel is one listening surface: starting local FM stops internet radio, and
 * starting internet radio stops local FM.
 */
export class LocalSdrControls {
  /**
   * @param {object} options
   * @param {Document} options.document Document containing the card.
   * @param {object} options.receiver Local RTL-SDR session.
   * @param {object} [options.radio] Internet-radio port (subscribe, stopPlayback).
   * @param {object} [options.actions] Application actions:
   *   setLocalAdsbEnabled(enabled), isLocalAdsbEnabled(), scheduleLayout().
   */
  constructor({ document: doc, receiver, radio = null, actions = {} }) {
    this.receiver = receiver;
    this.radio = radio;
    this.actions = actions;
    this.elements = Object.fromEntries(
      Object.entries(ELEMENT_IDS).map(([key, id]) => [
        key,
        doc?.getElementById?.(id) || null,
      ]),
    );
    this._listeners = new AbortController();
    this._state = receiver.getState();
    this._radioState = null;
    this._fmAudioActive = localSdrFmAudioActive(this._state);
    this._radioAudioActive = false;
    this._renderFrame = null;
    this._destroyed = false;
    if (!this.elements.card) return;
    this._bind();
    this._receiverUnsubscribe = receiver.subscribe((state) =>
      this._onReceiverState(state),
    );
    this._radioUnsubscribe =
      radio?.subscribe?.((state) => this._onRadioState(state)) || null;
    this._render();
  }

  /** Whether the receiver session is open (keeps the Radio panel expanded). */
  isActive() {
    return Boolean(this._state?.connected);
  }

  _listen(element, type, handler) {
    element?.addEventListener(type, handler, {
      signal: this._listeners.signal,
    });
  }

  _stopInternetRadio() {
    if (internetRadioAudioActive(this._radioState))
      this.radio?.stopPlayback?.({ origin: 'user' });
  }

  async _enableLayerWhenReceiving() {
    const state = this.receiver.getState();
    if (state.connected && state.mode === 'adsb')
      await this.actions.setLocalAdsbEnabled?.(true);
  }

  _bind() {
    const el = this.elements;
    this._listen(el.connect, 'click', async () => {
      const before = this.receiver.getState();
      if (before.connected) {
        await this.receiver.stop();
        return;
      }
      if (before.mode === 'fm') this._stopInternetRadio();
      if (await this.receiver.connect(before.mode))
        await this._enableLayerWhenReceiving();
    });
    this._listen(el.locate, 'click', () => {
      void this.receiver.requestReceiverLocation();
    });
    this._listen(el.changeDevice, 'click', async () => {
      if (this.receiver.getState().mode === 'fm') this._stopInternetRadio();
      if (await this.receiver.changeDevice())
        await this._enableLayerWhenReceiving();
    });
    this._listen(el.modeFm, 'click', async () => {
      this._stopInternetRadio();
      if (this.actions.isLocalAdsbEnabled?.())
        await this.actions.setLocalAdsbEnabled?.(false);
      await this.receiver.setMode('fm');
    });
    this._listen(el.modeAdsb, 'click', async () => {
      if (await this.receiver.setMode('adsb'))
        await this._enableLayerWhenReceiving();
    });
    this._listen(el.gain, 'change', () => {
      void this.receiver.setGain(el.gain.value);
    });
    const tune = () => {
      const mhz = Number(el.frequency?.value);
      if (!Number.isFinite(mhz)) return;
      this._stopInternetRadio();
      void this.receiver.tuneFm(mhz * 1_000_000);
    };
    this._listen(el.tune, 'click', tune);
    this._listen(el.frequency, 'keydown', (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      tune();
    });
    for (const [button, direction] of [
      [el.seekBack, -1],
      [el.seekForward, 1],
    ]) {
      this._listen(button, 'click', () => {
        this._stopInternetRadio();
        void this.receiver.seekFm(direction);
      });
    }
    this._listen(el.volume, 'input', () => {
      const value = Number(el.volume.value);
      this.receiver.setVolume(value / 100);
      setText(el.volumeValue, `${value}%`);
    });
  }

  _onReceiverState(state) {
    this._state = state;
    const fmAudioActive = localSdrFmAudioActive(state);
    // Local FM just started: it takes over from internet radio.
    if (fmAudioActive && !this._fmAudioActive) this._stopInternetRadio();
    this._fmAudioActive = fmAudioActive;
    this._scheduleRender();
  }

  _onRadioState(state) {
    this._radioState = state;
    const radioAudioActive = internetRadioAudioActive(state);
    // Internet radio just started: it takes over from local FM.
    if (radioAudioActive && !this._radioAudioActive && this._fmAudioActive) {
      void this.receiver.stop({
        message: 'Local FM stopped: internet radio started',
      });
    }
    this._radioAudioActive = radioAudioActive;
  }

  _scheduleRender() {
    if (this._destroyed || this._renderFrame !== null) return;
    const schedule =
      typeof requestAnimationFrame === 'function'
        ? requestAnimationFrame
        : (callback) => setTimeout(callback, 16);
    this._renderFrame = schedule(() => {
      this._renderFrame = null;
      if (!this._destroyed) this._render();
    });
  }

  _render() {
    const el = this.elements;
    const view = localSdrCardView(this._state);
    const doc = el.card?.ownerDocument;
    setText(el.connectionState, view.connectionLabel);
    el.connectionState?.classList.toggle('active', view.connectionActive);
    if (el.connect) {
      setText(el.connect, view.connectLabel);
      el.connect.disabled = view.connectDisabled;
      el.connect.classList.toggle('active', view.connectPressed);
      el.connect.setAttribute('aria-pressed', String(view.connectPressed));
    }
    for (const [button, active] of [
      [el.modeFm, view.fmActive],
      [el.modeAdsb, view.adsbActive],
    ]) {
      if (!button) continue;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
      button.disabled = view.modeDisabled;
    }
    if (el.locate) {
      setText(el.locate, view.locateLabel);
      el.locate.disabled = view.locateDisabled;
      el.locate.classList.toggle('active', view.locateActive);
    }
    if (el.changeDevice) el.changeDevice.disabled = view.changeDeviceDisabled;
    if (el.gain) {
      if (doc?.activeElement !== el.gain && el.gain.value !== view.gainValue)
        el.gain.value = view.gainValue;
      el.gain.disabled = view.gainDisabled;
    }
    if (el.stats) el.stats.hidden = view.statsHidden;
    setText(el.statRate, view.stats.rate);
    setText(el.statHeard, view.stats.heard);
    setText(el.statPositioned, view.stats.positioned);
    setText(el.statIq, view.stats.iq);
    if (el.frequency) {
      el.frequency.disabled = view.frequencyDisabled;
      if (doc?.activeElement !== el.frequency && view.frequencyValue !== null)
        el.frequency.value = view.frequencyValue;
    }
    if (el.tune) el.tune.disabled = view.tuneDisabled;
    if (el.seekBack) el.seekBack.disabled = view.seekDisabled;
    if (el.seekForward) el.seekForward.disabled = view.seekDisabled;
    if (el.volume) {
      if (doc?.activeElement !== el.volume)
        el.volume.value = String(view.volumePercent);
      el.volume.disabled = view.volumeDisabled;
    }
    setText(el.volumeValue, `${view.volumePercent}%`);
    if (el.status) {
      setText(el.status, view.statusText);
      el.status.classList.toggle('error', view.statusError);
    }
    el.card
      ?.closest?.('#radio-panel')
      ?.classList.toggle('sdr-connected', view.connectionActive);
    // Only structural changes move the rail; per-block text updates do not.
    const layoutKey = `${view.statsHidden}|${view.connectionActive}`;
    if (layoutKey !== this._layoutKey) {
      this._layoutKey = layoutKey;
      this.actions.scheduleLayout?.();
    }
  }

  /** Release listeners and subscriptions; the receiver session is not closed. */
  destroy() {
    this._destroyed = true;
    this._listeners.abort();
    this._receiverUnsubscribe?.();
    this._radioUnsubscribe?.();
    this._receiverUnsubscribe = null;
    this._radioUnsubscribe = null;
    if (this._renderFrame !== null) {
      if (typeof cancelAnimationFrame === 'function')
        cancelAnimationFrame(this._renderFrame);
      else clearTimeout(this._renderFrame);
      this._renderFrame = null;
    }
  }
}
