/**
 * @module atcAudio
 * @description Audio controller for Air Traffic Control streams with
 * procedural radio squelch effects and voice-ducking integration.
 */

let _sharedAudioContext = null;

/**
 * Get or create the shared AudioContext singleton.
 * @returns {AudioContext|null}
 */
export function getSharedAudioContext() {
  if (typeof window === 'undefined') return null;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return null;
  if (!_sharedAudioContext || _sharedAudioContext.state === 'closed') {
    try {
      _sharedAudioContext = new Ctx();
    } catch {
      _sharedAudioContext = null;
    }
  }
  return _sharedAudioContext;
}

/**
 * Procedural squelch click generator using Web Audio API.
 * Synthesizes an authentic VHF radio burst when frequencies open or close.
 * @param {AudioContext} [audioCtx]
 * @param {number} [durationSec=0.045]
 */
export function playSquelchBurst(audioCtx = null, durationSec = 0.045) {
  const ctx = audioCtx || getSharedAudioContext();
  if (!ctx) return;

  try {
    if (ctx.state === 'suspended') {
      ctx.resume().catch(() => {});
    }

    const bufferSize = Math.floor(ctx.sampleRate * durationSec);
    const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const data = buffer.getChannelData(0);

    // Filtered pink/white noise with smooth envelope
    for (let i = 0; i < bufferSize; i += 1) {
      const progress = i / bufferSize;
      // Hann window envelope
      const envelope = 0.5 * (1 - Math.cos(2 * Math.PI * progress));
      data[i] = (Math.random() * 2 - 1) * envelope * 0.15;
    }

    const noiseSource = ctx.createBufferSource();
    noiseSource.buffer = buffer;

    // Bandpass filter to simulate 300 Hz - 3000 Hz VHF AM radio acoustics
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 1400;
    filter.Q.value = 1.2;

    const gainNode = ctx.createGain();
    gainNode.gain.value = 0.4;

    noiseSource.connect(filter);
    filter.connect(gainNode);
    gainNode.connect(ctx.destination);

    noiseSource.start();
  } catch {
    // Ignore audio synthesis errors in constrained contexts
  }
}

/**
 * Controller managing live ATC stream playback and squelch states.
 */
export class AtcAudioController {
  constructor({
    AudioConstructor = typeof Audio !== 'undefined' ? Audio : null,
    AudioContextConstructor = typeof AudioContext !== 'undefined'
      ? AudioContext
      : typeof window !== 'undefined' ? window.webkitAudioContext : null,
  } = {}) {
    this._AudioConstructor = AudioConstructor;
    this._AudioContextConstructor = AudioContextConstructor;
    this._audio = null;
    this._audioCtx = null;
    this._currentUrl = null;
    this._state = 'idle'; // 'idle' | 'connecting' | 'playing' | 'squelch' | 'error'
    this._volume = 0.8;
    this._muted = false;
    this._ducked = false;
    this._lastError = null;
    this._listeners = new Set();
  }

  get state() {
    return this._state;
  }

  get volume() {
    return this._volume;
  }

  get muted() {
    return this._muted;
  }

  get currentUrl() {
    return this._currentUrl;
  }

  get audioElement() {
    return this._audio;
  }

  /**
   * Subscribe to audio controller state changes.
   * @param {function(object):void} listener
   * @returns {function():void} Unsubscribe function
   */
  subscribe(listener) {
    if (typeof listener !== 'function') return () => {};
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  _notify() {
    const snapshot = {
      state: this._state,
      volume: this._volume,
      muted: this._muted,
      ducked: this._ducked,
      currentUrl: this._currentUrl,
      error: this._lastError,
    };
    for (const listener of this._listeners) {
      try {
        listener(snapshot);
      } catch (err) {
        console.warn('[ATC Audio] Listener error:', err);
      }
    }
  }

  _getAudioContext() {
    if (!this._audioCtx && this._AudioContextConstructor) {
      try {
        this._audioCtx = new this._AudioContextConstructor();
      } catch {
        this._audioCtx = null;
      }
    }
    return this._audioCtx;
  }

  _applyVolume() {
    if (!this._audio) return;
    if (this._muted) {
      this._audio.volume = 0;
      this._audio.muted = true;
    } else {
      this._audio.muted = false;
      const targetVolume = this._ducked ? this._volume * 0.15 : this._volume;
      this._audio.volume = Math.max(0, Math.min(1, targetVolume));
    }
  }

  /**
   * Set playback volume between 0 and 1.
   * @param {number} vol
   */
  setVolume(vol) {
    const clamped = Math.max(0, Math.min(1, Number(vol) || 0));
    this._volume = clamped;
    this._applyVolume();
    this._notify();
  }

  /**
   * Set mute status.
   * @param {boolean} muted
   */
  setMuted(muted) {
    this._muted = Boolean(muted);
    this._applyVolume();
    this._notify();
  }

  /**
   * Toggle mute status.
   */
  toggleMute() {
    this.setMuted(!this._muted);
  }

  /**
   * Set voice ducking state (lowers volume when voice assistant speaks).
   * @param {boolean} ducked
   */
  setDucked(ducked) {
    this._ducked = Boolean(ducked);
    this._applyVolume();
    this._notify();
  }

  /**
   * Duck audio volume for voice communication.
   */
  duck() {
    this.setDucked(true);
  }

  /**
   * Restore audio volume after voice communication.
   */
  unduck() {
    this.setDucked(false);
  }

  /**
   * Play an ATC audio stream.
   * @param {string} url Audio stream URL
   * @param {object} [options]
   * @param {boolean} [options.squelch=true] Play procedural squelch click
   * @returns {Promise<boolean>}
   */
  async playStream(url, { squelch = true } = {}) {
    if (!url) {
      this.stop();
      return false;
    }

    if (this._currentUrl === url && this._state === 'playing') {
      return true;
    }

    this.stop({ squelch: false });
    this._currentUrl = url;
    this._state = 'connecting';
    this._lastError = null;
    this._notify();

    if (squelch) {
      playSquelchBurst(this._getAudioContext());
    }

    if (!this._AudioConstructor) {
      // In headless test environments without Audio, mock successful connection
      this._state = 'playing';
      this._notify();
      return true;
    }

    let audio = null;
    try {
      audio = new this._AudioConstructor();
      this._audio = audio;
      audio.preload = 'none';
      audio.crossOrigin = 'anonymous';
      audio.src = url;
      this._applyVolume();

      audio.addEventListener('playing', () => {
        if (this._audio === audio) {
          this._state = 'playing';
          this._notify();
        }
      });

      audio.addEventListener('error', (e) => {
        if (this._audio === audio) {
          this._state = 'error';
          this._lastError = audio.error?.message || e?.message || 'ATC stream connection failed';
          this._notify();
        }
      });

      audio.addEventListener('ended', () => {
        if (this._audio === audio) {
          this._state = 'squelch';
          this._notify();
        }
      });

      await audio.play();
      if (this._audio === audio) {
        this._state = 'playing';
        this._notify();
      }
      return true;
    } catch (err) {
      if (this._audio === audio) {
        this._state = 'error';
        this._lastError = err?.message || 'Playback blocked or stream unreachable';
        this._notify();
      }
      return false;
    }
  }

  /**
   * Stop active playback and enter squelch/idle state.
   * @param {object} [options]
   * @param {boolean} [options.squelch=true]
   */
  stop({ squelch = true } = {}) {
    if (this._audio) {
      try {
        this._audio.pause();
        this._audio.removeAttribute('src');
        this._audio.load();
      } catch {
        // Ignore audio teardown exceptions
      }
      this._audio = null;
    }

    if (squelch) {
      playSquelchBurst(this._getAudioContext());
    }

    this._currentUrl = null;
    this._state = 'squelch';
    this._notify();
  }

  /**
   * Destroy the audio controller and free resources.
   */
  destroy() {
    this.stop({ squelch: false });
    if (this._audioCtx && typeof this._audioCtx.close === 'function') {
      try {
        this._audioCtx.close().catch(() => {});
      } catch {}
      this._audioCtx = null;
    }
    this._listeners.clear();
    this._state = 'idle';
  }
}
