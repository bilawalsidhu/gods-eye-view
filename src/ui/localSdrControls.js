import { onLocaleChange, t } from '../i18n/index.js';
import { parseAtcChannel } from '../sdr/atcChannels.js';
import {
  internetRadioAudioActive,
  localSdrCardView,
  localSdrFeedLine,
  localSdrAudioActive,
} from './localSdrPresentation.js';
import { useRadioStore } from './stores/radio.js';
import { applicationPinia } from './vueRuntime.js';

/**
 * Local SDR card in the Radio panel.
 *
 * Answers the card's controls and owns its receiver/radio subscriptions; the
 * Radio view renders the card from what this publishes (`gev-radio` store)
 * and sends its controls here through the store's act(). The
 * Starting local SDR audio stops internet radio, and vice versa.
 */
export class LocalSdrControls {
  /**
   * @param {object} options
   * @param {Document} options.document Document containing the card.
   * @param {object} options.receiver Local SDR session.
   * @param {object} [options.feeds] Decoder-feed session (getState,
   *   subscribe, probe); the card shows one read-only line when the server
   *   has feeds configured.
   * @param {object} [options.radio] Internet-radio port (subscribe, stopPlayback).
   * @param {object} [options.actions] Application actions:
   *   setLocalAdsbEnabled(enabled), isLocalAdsbEnabled(), revealAtc(),
   *   scheduleLayout().
   * @param {object} [options.store] Store the card's view is published to.
   */
  constructor({
    document: doc,
    receiver,
    feeds = null,
    radio = null,
    actions = {},
    store = useRadioStore(applicationPinia()),
  }) {
    this.store = store;
    this.receiver = receiver;
    this.feeds = feeds;
    this.radio = radio;
    this.actions = actions;
    this._state = receiver.getState();
    this._radioState = null;
    this._localAudioActive = localSdrAudioActive(this._state);
    this._invalidAtcChannel = false;
    this._radioAudioActive = false;
    this._renderFrame = null;
    this._destroyed = false;
    this._view = null;
    // A page without the card (the Radio view omitted) has no controls.
    if (!doc?.getElementById?.('sdr-radio-card')) return;
    this._storeToken = store.connect(this._actions());
    this._receiverUnsubscribe = receiver.subscribe((state) =>
      this._onReceiverState(state),
    );
    this._radioUnsubscribe =
      radio?.subscribe?.((state) => this._onRadioState(state)) || null;
    this._feedsUnsubscribe =
      feeds?.subscribe?.(() => this._scheduleRender()) || null;
    // One request, no polling: learn whether the server has decoder feeds.
    void feeds?.probe?.()?.catch?.(() => {});
    this._offLocale = onLocaleChange(() => this._scheduleRender());
    this._render();
  }

  /** Whether the receiver session is open (keeps the Radio panel expanded). */
  isActive() {
    return Boolean(this._state?.connected);
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

  /** What the card's controls ask for, by the names the view acts with. */
  _actions() {
    return {
      selectSdrReceiver: (receiverKind) =>
        this.receiver.selectReceiver(receiverKind),
      toggleSdrConnection: async () => {
        const before = this.receiver.getState();
        if (before.connected) {
          await this.receiver.stop();
          return;
        }
        if (before.mode !== 'adsb') this._stopInternetRadio();
        if (await this.receiver.connect(before.mode))
          await this._enableLayerWhenReceiving();
      },
      locateSdr: () => {
        void this.receiver.requestReceiverLocation();
      },
      changeSdrDevice: async () => {
        if (this.receiver.getState().mode !== 'adsb') this._stopInternetRadio();
        if (await this.receiver.changeDevice())
          await this._enableLayerWhenReceiving();
      },
      setSdrMode: async (mode) => {
        if (mode === 'adsb') {
          if (await this.receiver.setMode('adsb'))
            await this._enableLayerWhenReceiving();
        } else {
          this._stopInternetRadio();
          if (mode === 'fm' && this.actions.isLocalAdsbEnabled?.())
            await this.actions.setLocalAdsbEnabled?.(false);
          await this.receiver.setMode(mode);
        }
      },
      setSdrGain: (value) => {
        void this.receiver.setGain(value);
      },
      setHackrfGain: (stage, value) => {
        void this.receiver.setHackrfGain(stage, value);
      },
      tuneAirportAtc: (channel) => {
        this._invalidAtcChannel = false;
        this._scheduleRender();
        return this.receiver.tuneAtcChannel(channel);
      },
      openManualAtc: async () => {
        if (this.receiver.getState().mode !== 'atc')
          await this.receiver.setMode('atc');
        this.actions.revealAtc?.();
      },
      tuneSdr: (value) => {
        if (this.receiver.getState().mode === 'atc') {
          const channel = parseAtcChannel(value);
          this._invalidAtcChannel = !channel;
          this._scheduleRender();
          if (channel) void this.receiver.tuneAtcChannel(channel.label);
          return;
        }
        const mhz = Number(value);
        if (!Number.isFinite(mhz)) return;
        this._stopInternetRadio();
        void this.receiver.tuneFm(mhz * 1_000_000);
      },
      clearSdrTuneError: () => {
        if (!this._invalidAtcChannel) return;
        this._invalidAtcChannel = false;
        this._scheduleRender();
      },
      seekSdr: (direction) => {
        this._stopInternetRadio();
        void this.receiver.seekFm(direction);
      },
      setSdrVolume: (percent) => {
        const value = Number(percent);
        this.receiver.setVolume(value / 100);
        if (this._view)
          this._publish({ ...this._view, volumeText: `${value}%` });
      },
    };
  }

  _onReceiverState(state) {
    if (state.mode !== 'atc') this._invalidAtcChannel = false;
    this._state = state;
    const localAudioActive = localSdrAudioActive(state);
    if (localAudioActive && !this._localAudioActive) this._stopInternetRadio();
    this._localAudioActive = localAudioActive;
    this._scheduleRender();
  }

  _onRadioState(state) {
    this._radioState = state;
    const radioAudioActive = internetRadioAudioActive(state);
    if (radioAudioActive && !this._radioAudioActive && this._localAudioActive) {
      void this.receiver.stop({
        message:
          this._state.mode === 'atc'
            ? t('Local ATC stopped: internet radio started')
            : t('Local FM stopped: internet radio started'),
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

  _publish(view) {
    this._view = view;
    this.store?.publishSdr(view);
  }

  _render() {
    const view = localSdrCardView(this._state);
    const feedLine = localSdrFeedLine(this.feeds?.getState?.() || null);
    this._publish({
      ...view,
      gain: view.gainValue,
      frequency: view.frequencyValue,
      invalidAtcChannel: this._invalidAtcChannel,
      volume: view.volumePercent,
      volumeText: `${view.volumePercent}%`,
      feedLine,
    });
    // Only structural changes move the rail; per-block text updates do not.
    const layoutKey = `${view.receiverKind}|${view.statsHidden}|${view.atcActive}|${this._invalidAtcChannel}|${view.connectionActive}|${feedLine === null}`;
    if (layoutKey !== this._layoutKey) {
      this._layoutKey = layoutKey;
      this.actions.scheduleLayout?.();
    }
  }

  /** Release the controls and subscriptions; the receiver session is not closed. */
  destroy() {
    this._destroyed = true;
    if (this._storeToken) this.store.detach(this._storeToken);
    this._storeToken = null;
    this._receiverUnsubscribe?.();
    this._radioUnsubscribe?.();
    this._feedsUnsubscribe?.();
    this._offLocale?.();
    this._feedsUnsubscribe = null;
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
