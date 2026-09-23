/**
 * @module atcRadio
 * @description Central Air Traffic Control (ATC) radio system coordinator.
 * Integrates global airport frequency directory, proximity auto-tuning,
 * LiveATC directory links, custom stream URLs, and leased audio arbitration.
 */

import { DEFAULT_ATC_RANGE_M, resolveAtcTune } from './atcTuner.js';
import { AtcAudioController } from './atcAudio.js';
import {
  setCustomStreamUrl as setCustomStream,
  removeCustomStreamUrl as removeCustomStream,
  safeWindowLocalStorage,
} from './atcCustomStreams.js';

export class AtcRadioSystem {
  /**
   * @param {object} [options]
   * @param {object|null} [options.viewer=null] Cesium viewer instance
   * @param {AtcAudioController|null} [options.audioController=null] Audio controller instance
   * @param {Function|null} [options.AudioConstructor=null] Audio constructor injection
   * @param {Function|null} [options.AudioContextConstructor=null] AudioContext constructor injection
   * @param {Function|null} [options.audioFactory=null] Fallback audio factory
   * @param {Function|null} [options.audioContextFactory=null] Fallback AudioContext factory
   * @param {boolean} [options.autoTuneEnabled=true] Whether auto-tuning is active
   * @param {boolean} [options.autoPlayEnabled=false] Whether stream autoplays on approach
   * @param {number} [options.maxRangeM=DEFAULT_ATC_RANGE_M] Maximum reception range
   * @param {Storage|null} [options.storage=null] Custom storage interface
   * @param {object|null} [options.radioLayer=null] Centralized Radio layer instance
   */
  constructor({
    viewer = null,
    audioController = null,
    AudioConstructor = null,
    AudioContextConstructor = null,
    audioFactory = null,
    audioContextFactory = null,
    autoTuneEnabled = true,
    autoPlayEnabled = false,
    maxRangeM = DEFAULT_ATC_RANGE_M,
    storage = null,
    radioLayer = null,
  } = {}) {
    this.viewer = viewer;
    this._storage = storage;
    this._radioLayer = radioLayer;
    const AudioCtor = AudioConstructor || audioFactory;
    const AudioCtxCtor = AudioContextConstructor || audioContextFactory;
    this.audio =
      audioController ||
      new AtcAudioController({
        AudioConstructor: AudioCtor,
        AudioContextConstructor: AudioCtxCtor,
      });
    this._autoTuneEnabled = autoTuneEnabled;
    this._autoPlayEnabled = autoPlayEnabled;
    this._maxRangeM = maxRangeM;
    this._manualAirportIcao = null;
    this._manualFreqType = null;
    this._currentAircraft = null;
    this._currentTune = resolveAtcTune({
      aircraft: null,
      storage: this._storage,
    });
    this._listeners = new Set();
    this._unsubscribeAudio = null;

    this._unsubscribeAudio = this.audio.subscribe(() => {
      this._emitChange();
    });

    // Sync with centralized radio layer voice ducking if available
    this._unsubscribeRadioLayer = null;
    if (this._radioLayer?.subscribeToRadio) {
      this._unsubscribeRadioLayer = this._radioLayer.subscribeToRadio(
        (state) => {
          if (state && typeof state.voiceDucked === 'boolean') {
            this.audio.setDucked(state.voiceDucked);
          }
        },
      );
    }
  }

  get autoTuneEnabled() {
    return this._autoTuneEnabled;
  }

  get autoPlayEnabled() {
    return this._autoPlayEnabled;
  }

  get currentTune() {
    return this._currentTune;
  }

  get airport() {
    return this._currentTune?.airport || null;
  }

  get frequency() {
    return this._currentTune?.frequencyMHz || null;
  }

  get liveAtcUrl() {
    return this._currentTune?.liveAtcUrl || null;
  }

  get streamUrl() {
    return this._currentTune?.streamUrl || null;
  }

  get hasCustomStream() {
    return Boolean(this._currentTune?.hasCustomStream);
  }

  get playing() {
    return this.audio?.state === 'playing';
  }

  get state() {
    return {
      autoTune: this._autoTuneEnabled,
      autoPlay: this._autoPlayEnabled,
      audioState: this.audio.state,
      playing: this.audio.state === 'playing',
      volume: this.audio.volume,
      muted: this.audio.muted,
      ducked: this.audio._ducked,
      tune: this._currentTune,
      airport: this._currentTune?.airport || null,
      frequency: this._currentTune?.frequencyMHz || null,
      activeFreqType: this._currentTune?.freqType || null,
      flightPhase: this._currentTune?.phase || 'enroute',
      manualIcao: this._manualAirportIcao,
      manualFreq: this._manualFreqType,
      liveAtcUrl: this._currentTune?.liveAtcUrl || null,
      streamUrl: this._currentTune?.streamUrl || null,
      hasCustomStream: Boolean(this._currentTune?.hasCustomStream),
    };
  }

  /**
   * Subscribe to ATC radio state updates.
   * @param {function(object):void} listener
   * @returns {function():void}
   */
  subscribe(listener) {
    if (typeof listener !== 'function') return () => {};
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  _emitChange() {
    const snapshot = this.state;
    for (const listener of this._listeners) {
      try {
        listener(snapshot);
      } catch (err) {
        console.warn('[ATC Radio] Listener error:', err);
      }
    }
    if (
      typeof window !== 'undefined' &&
      typeof window.dispatchEvent === 'function'
    ) {
      try {
        window.dispatchEvent(
          new CustomEvent('gev:atc-radio-changed', { detail: snapshot }),
        );
      } catch (err) {
        console.warn('[ATC Radio] CustomEvent dispatch error:', err);
      }
    }
  }

  /**
   * Set a custom stream URL for the current or specified airport.
   * @param {string} url Must be HTTPS
   * @param {string} [icao]
   * @returns {{ ok: boolean, error?: string }}
   */
  setCustomStreamUrl(url, icao = this.airport?.icao) {
    if (!icao) {
      return { ok: false, error: 'No airport tuned' };
    }
    const store = this._storage || safeWindowLocalStorage();
    const result = setCustomStream(icao, url, store);
    if (result.ok) {
      this.updateAircraftTelemetry(this._currentAircraft);
    }
    return result;
  }

  /**
   * Remove a saved custom stream URL.
   * @param {string} [icao]
   * @returns {boolean}
   */
  removeCustomStreamUrl(icao = this.airport?.icao) {
    if (!icao) return false;
    const store = this._storage || safeWindowLocalStorage();
    const removed = removeCustomStream(icao, store);
    if (removed) {
      this.updateAircraftTelemetry(this._currentAircraft);
    }
    return removed;
  }

  /**
   * Set whether automatic proximity tuning is enabled.
   * @param {boolean} enabled
   */
  setAutoTune(enabled) {
    this._autoTuneEnabled = Boolean(enabled);
    if (this._autoTuneEnabled) {
      this._manualAirportIcao = null;
      this._manualFreqType = null;
    } else {
      this._manualAirportIcao = this._currentTune?.airport?.icao || null;
      this._manualFreqType = this._currentTune?.freqType || null;
    }
    this.updateAircraftTelemetry(this._currentAircraft);
  }

  /**
   * Set whether audio should automatically start playing on approach.
   * @param {boolean} enabled
   */
  setAutoPlay(enabled) {
    this._autoPlayEnabled = Boolean(enabled);
    this._emitChange();
  }

  /**
   * Manually tune to an airport by ICAO and optional frequency type.
   * @param {string} icao
   * @param {'tower'|'approach'|'atis'|'ground'} [freqType='tower']
   */
  tuneAirport(icao, freqType = 'tower') {
    this._autoTuneEnabled = false;
    this._manualAirportIcao = icao?.toUpperCase() || null;
    this._manualFreqType = freqType;
    this.updateAircraftTelemetry(this._currentAircraft);
  }

  /**
   * Switch the active frequency type on the currently tuned airport.
   * @param {'tower'|'approach'|'atis'|'ground'} freqType
   */
  selectFrequency(freqType) {
    if (!this._currentTune?.airport) return;
    this._manualAirportIcao = this._currentTune.airport.icao;
    this._manualFreqType = freqType;
    this._autoTuneEnabled = false;
    this.updateAircraftTelemetry(this._currentAircraft);
  }

  /**
   * Update the currently followed aircraft telemetry.
   * Automatically derives the best station and manages playback.
   * @param {object|null} aircraft { lat, lon, altitudeM, verticalRateMps, groundSpeedKts, velocityMps, onGround, callsign }
   */
  updateAircraftTelemetry(aircraft) {
    // Idle optimization: avoid waking listeners if aircraft was null and remains null without manual override
    if (
      aircraft === null &&
      this._currentAircraft === null &&
      !this._manualAirportIcao
    ) {
      return;
    }

    this._currentAircraft = aircraft;
    const priorTune = this._currentTune;

    const newTune = resolveAtcTune({
      aircraft,
      autoTune: this._autoTuneEnabled,
      manualAirportIcao: this._manualAirportIcao,
      manualFreqType: this._manualFreqType,
      maxRangeM: this._maxRangeM,
      storage: this._storage,
    });

    this._currentTune = newTune;

    const stationChanged =
      priorTune?.airport?.icao !== newTune?.airport?.icao ||
      priorTune?.freqType !== newTune?.freqType;

    // Handle playback transitions on station/frequency switch or range boundary crossing
    if (stationChanged && this.audio.state === 'playing') {
      if (newTune.inRange && newTune.streamUrl && this._autoPlayEnabled) {
        this.audio.playStream(newTune.streamUrl, { squelch: true });
      } else {
        // Stop prior station audio with authentic squelch cut
        this.audio.stop({ squelch: true });
      }
    } else if (
      newTune.inRange &&
      newTune.streamUrl &&
      this._autoPlayEnabled &&
      this.audio.state !== 'playing'
    ) {
      this.audio.playStream(newTune.streamUrl, { squelch: true });
    } else if (
      priorTune?.inRange &&
      !newTune.inRange &&
      this.audio.state === 'playing'
    ) {
      // Exited coverage range: cut to squelch
      this.audio.stop({ squelch: true });
    }

    this._emitChange();
  }

  /**
   * Clear aircraft telemetry when no aircraft is followed.
   */
  clearAircraftTelemetry() {
    this.updateAircraftTelemetry(null);
  }

  /**
   * Start streaming audio for the current airport/frequency.
   * @returns {Promise<boolean>}
   */
  play() {
    if (this._currentTune?.streamUrl) {
      this._radioLayer?.pauseRadioPlayback?.({ origin: 'atc' });
      return this.audio.playStream(this._currentTune.streamUrl, {
        squelch: true,
      });
    }
    return Promise.resolve(false);
  }

  /**
   * Stop audio stream and trigger squelch.
   */
  stop() {
    this.audio.stop({ squelch: true });
  }

  /**
   * Duck audio volume for voice communication.
   */
  duck() {
    this.audio.duck();
  }

  /**
   * Restore audio volume after voice communication.
   */
  unduck() {
    this.audio.unduck();
  }

  /**
   * Toggle audio playback on or off for the currently tuned frequency.
   */
  async toggleAudio() {
    if (this.audio.state === 'playing') {
      this.audio.stop({ squelch: true });
    } else {
      const url = this._currentTune?.streamUrl;
      if (url) {
        this._radioLayer?.pauseRadioPlayback?.({ origin: 'atc' });
        await this.audio.playStream(url, { squelch: true });
      } else {
        // Play brief squelch burst to confirm frequency toggle even without active custom stream
        this.audio.stop({ squelch: true });
      }
    }
  }

  /**
   * Destroy the ATC radio system.
   */
  destroy() {
    this._unsubscribeAudio?.();
    this._unsubscribeRadioLayer?.();
    this.audio.destroy();
    this._listeners.clear();
  }
}
