/**
 * Procedural Tactical Audio Engine for God's Eye View.
 *
 * Uses the Web Audio API to synthesize sci-fi tactical sound effects
 * entirely in real-time — zero external audio files, zero network downloads.
 */

class TacticalAudioEngine {
  constructor({ audioContextRef = null } = {}) {
    this._audioContextRef = audioContextRef;
    this._ctx = null;
    this._masterGain = null;
    this._sfxGain = null;
    this._alertGain = null;
    this._ambianceGain = null;
    this._isMuted = false;
    this._categoryVolumes = {
      sfx: 0.8,
      alerts: 1.0,
      ambiance: 0.6,
    };
    this._masterVolume = 0.85;
    this._unlocked = false;
    this._noiseBuffer = null;
  }

  /**
   * Lazily initialize audio context on first user interaction or explicit call.
   */
  getContext() {
    if (this._ctx && this._ctx.state !== 'closed') {
      if (this._ctx.state === 'suspended') {
        this._ctx.resume().catch(() => {});
      }
      return this._ctx;
    }

    const AudioCtxClass =
      this._audioContextRef ||
      globalThis.AudioContext ||
      globalThis.webkitAudioContext;

    if (!AudioCtxClass) {
      return null;
    }

    try {
      if (typeof AudioCtxClass === 'function') {
        try {
          this._ctx = new AudioCtxClass();
        } catch {
          this._ctx = AudioCtxClass();
        }
      } else {
        this._ctx = AudioCtxClass;
      }

      if (!this._ctx || typeof this._ctx.createGain !== 'function') {
        return null;
      }

      // Root master gain
      this._masterGain = this._ctx.createGain();
      this._masterGain.gain.setValueAtTime(
        this._isMuted ? 0 : this._masterVolume,
        this._ctx.currentTime || 0,
      );
      this._masterGain.connect(this._ctx.destination);

      // Sub-buses
      this._sfxGain = this._ctx.createGain();
      this._sfxGain.gain.setValueAtTime(
        this._categoryVolumes.sfx,
        this._ctx.currentTime || 0,
      );
      this._sfxGain.connect(this._masterGain);

      this._alertGain = this._ctx.createGain();
      this._alertGain.gain.setValueAtTime(
        this._categoryVolumes.alerts,
        this._ctx.currentTime || 0,
      );
      this._alertGain.connect(this._masterGain);

      this._ambianceGain = this._ctx.createGain();
      this._ambianceGain.gain.setValueAtTime(
        this._categoryVolumes.ambiance,
        this._ctx.currentTime || 0,
      );
      this._ambianceGain.connect(this._masterGain);

      this._setupUnlockListener();
      return this._ctx;
    } catch {
      return null;
    }
  }

  _setupUnlockListener() {
    if (this._unlocked || typeof window === 'undefined') return;
    const unlock = () => {
      if (this._ctx && this._ctx.state === 'suspended') {
        this._ctx
          .resume()
          .then(() => {
            this._unlocked = true;
          })
          .catch(() => {});
      } else {
        this._unlocked = true;
      }
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    };
    window.addEventListener('pointerdown', unlock, {
      passive: true,
      once: true,
    });
    window.addEventListener('keydown', unlock, { passive: true, once: true });
  }

  get sfxBus() {
    this.getContext();
    return this._sfxGain;
  }

  get alertBus() {
    this.getContext();
    return this._alertGain;
  }

  get ambianceBus() {
    this.getContext();
    return this._ambianceGain;
  }

  /**
   * Generates or retrieves a 2-second white/pink noise buffer for sweeps and clacks.
   */
  _getNoiseBuffer(ctx) {
    if (this._noiseBuffer) return this._noiseBuffer;
    try {
      const bufferSize = Math.floor(ctx.sampleRate * 2);
      const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
      const output = buffer.getChannelData(0);
      let b0 = 0,
        b1 = 0,
        b2 = 0;
      for (let i = 0; i < bufferSize; i++) {
        const white = Math.random() * 2 - 1;
        // Pink noise approximation
        b0 = 0.99886 * b0 + white * 0.0555179;
        b1 = 0.99332 * b1 + white * 0.0750759;
        b2 = 0.969 * b2 + white * 0.153852;
        output[i] = (b0 + b1 + b2 + white * 0.5362) * 0.11;
      }
      this._noiseBuffer = buffer;
      return buffer;
    } catch {
      return null;
    }
  }

  /**
   * Set master volume in range [0, 1].
   */
  setMasterVolume(value) {
    this._masterVolume = Math.max(0, Math.min(1, Number(value) || 0));
    if (this._masterGain && this._ctx && !this._isMuted) {
      this._masterGain.gain.setTargetAtTime(
        this._masterVolume,
        this._ctx.currentTime || 0,
        0.05,
      );
    }
  }

  getMasterVolume() {
    return this._masterVolume;
  }

  setCategoryVolume(category, value) {
    const val = Math.max(0, Math.min(1, Number(value) || 0));
    this._categoryVolumes[category] = val;
    const bus =
      category === 'alerts'
        ? this._alertGain
        : category === 'ambiance'
          ? this._ambianceGain
          : this._sfxGain;
    if (bus && this._ctx) {
      bus.gain.setTargetAtTime(val, this._ctx.currentTime || 0, 0.05);
    }
  }

  getCategoryVolume(category) {
    return this._categoryVolumes[category] ?? 1.0;
  }

  setMuted(muted) {
    this._isMuted = Boolean(muted);
    if (this._masterGain && this._ctx) {
      this._masterGain.gain.setTargetAtTime(
        this._isMuted ? 0 : this._masterVolume,
        this._ctx.currentTime || 0,
        0.03,
      );
    }
  }

  isMuted() {
    return this._isMuted;
  }

  /**
   * Target acquire/lock: Dual-tone ascending chirp (C5: ~523Hz -> G5: ~784Hz, 200ms)
   */
  playLock() {
    const ctx = this.getContext();
    if (!ctx || !this._sfxGain) return;
    try {
      const now = ctx.currentTime || 0;
      const osc1 = ctx.createOscillator();
      const osc2 = ctx.createOscillator();
      const gain = ctx.createGain();

      osc1.type = 'sine';
      osc2.type = 'triangle';

      osc1.frequency.setValueAtTime(523.25, now);
      osc1.frequency.exponentialRampToValueAtTime(783.99, now + 0.18);

      osc2.frequency.setValueAtTime(1046.5, now + 0.05);
      osc2.frequency.exponentialRampToValueAtTime(1567.98, now + 0.2);

      gain.gain.setValueAtTime(0.001, now);
      gain.gain.linearRampToValueAtTime(0.2, now + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.22);

      osc1.connect(gain);
      osc2.connect(gain);
      gain.connect(this._sfxGain);

      osc1.start(now);
      osc2.start(now + 0.05);
      osc1.stop(now + 0.22);
      osc2.stop(now + 0.22);
    } catch {}
  }

  /**
   * Target release: Descending minor third (G5: ~784Hz -> E5: ~659Hz, 150ms)
   */
  playRelease() {
    const ctx = this.getContext();
    if (!ctx || !this._sfxGain) return;
    try {
      const now = ctx.currentTime || 0;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.type = 'sine';
      osc.frequency.setValueAtTime(783.99, now);
      osc.frequency.exponentialRampToValueAtTime(659.25, now + 0.14);

      gain.gain.setValueAtTime(0.15, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.16);

      osc.connect(gain);
      gain.connect(this._sfxGain);

      osc.start(now);
      osc.stop(now + 0.16);
    } catch {}
  }

  /**
   * Contact step (next/prev): Soft click + frequency tick (15ms)
   */
  playClick() {
    const ctx = this.getContext();
    if (!ctx || !this._sfxGain) return;
    try {
      const now = ctx.currentTime || 0;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.type = 'triangle';
      osc.frequency.setValueAtTime(1600, now);
      osc.frequency.exponentialRampToValueAtTime(400, now + 0.02);

      gain.gain.setValueAtTime(0.12, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.025);

      osc.connect(gain);
      gain.connect(this._sfxGain);

      osc.start(now);
      osc.stop(now + 0.025);
    } catch {}
  }

  /**
   * Mechanical split-flap clack (noise burst + filter snap, 40ms)
   */
  playClack() {
    const ctx = this.getContext();
    if (!ctx || !this._sfxGain) return;
    try {
      const now = ctx.currentTime || 0;
      const noise = this._getNoiseBuffer(ctx);
      if (!noise) {
        this.playClick();
        return;
      }
      const source = ctx.createBufferSource();
      source.buffer = noise;

      const filter = ctx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.setValueAtTime(1400 + Math.random() * 400, now);
      filter.Q.setValueAtTime(3.5, now);

      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.18, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.045);

      source.connect(filter);
      filter.connect(gain);
      gain.connect(this._sfxGain);

      source.start(now);
      source.stop(now + 0.05);
    } catch {}
  }

  /**
   * Cockpit enter: Jet engine spool-up sweep (80Hz -> 400Hz, 1.2s, filtered noise)
   */
  playSpoolUp() {
    const ctx = this.getContext();
    if (!ctx || !this._sfxGain) return;
    try {
      const now = ctx.currentTime || 0;
      const duration = 1.2;

      // Sub harmonic sine
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(75, now);
      osc.frequency.exponentialRampToValueAtTime(360, now + duration);

      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(200, now);
      filter.frequency.exponentialRampToValueAtTime(1200, now + duration);

      const oscGain = ctx.createGain();
      oscGain.gain.setValueAtTime(0.001, now);
      oscGain.gain.linearRampToValueAtTime(0.15, now + 0.3);
      oscGain.gain.exponentialRampToValueAtTime(0.001, now + duration + 0.1);

      osc.connect(filter);
      filter.connect(oscGain);
      oscGain.connect(this._sfxGain);

      osc.start(now);
      osc.stop(now + duration + 0.1);

      // Filtered noise sweep
      const noise = this._getNoiseBuffer(ctx);
      if (noise) {
        const noiseSource = ctx.createBufferSource();
        noiseSource.buffer = noise;
        const noiseFilter = ctx.createBiquadFilter();
        noiseFilter.type = 'bandpass';
        noiseFilter.frequency.setValueAtTime(150, now);
        noiseFilter.frequency.exponentialRampToValueAtTime(900, now + duration);
        noiseFilter.Q.setValueAtTime(1.5, now);

        const noiseGain = ctx.createGain();
        noiseGain.gain.setValueAtTime(0.01, now);
        noiseGain.gain.linearRampToValueAtTime(0.12, now + 0.4);
        noiseGain.gain.exponentialRampToValueAtTime(0.001, now + duration);

        noiseSource.connect(noiseFilter);
        noiseFilter.connect(noiseGain);
        noiseGain.connect(this._sfxGain);

        noiseSource.start(now);
        noiseSource.stop(now + duration);
      }
    } catch {}
  }

  /**
   * Cockpit exit: Engine wind-down (reverse sweep)
   */
  playSpoolDown() {
    const ctx = this.getContext();
    if (!ctx || !this._sfxGain) return;
    try {
      const now = ctx.currentTime || 0;
      const duration = 0.9;

      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(360, now);
      osc.frequency.exponentialRampToValueAtTime(60, now + duration);

      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(1000, now);
      filter.frequency.exponentialRampToValueAtTime(150, now + duration);

      const oscGain = ctx.createGain();
      oscGain.gain.setValueAtTime(0.14, now);
      oscGain.gain.exponentialRampToValueAtTime(0.001, now + duration);

      osc.connect(filter);
      filter.connect(oscGain);
      oscGain.connect(this._sfxGain);

      osc.start(now);
      osc.stop(now + duration);
    } catch {}
  }

  /**
   * Visual style change: Glass resonance ping (sine + harmonics, 300ms)
   */
  playStyleChange() {
    const ctx = this.getContext();
    if (!ctx || !this._sfxGain) return;
    try {
      const now = ctx.currentTime || 0;
      const osc1 = ctx.createOscillator();
      const osc2 = ctx.createOscillator();
      const gain = ctx.createGain();

      osc1.type = 'sine';
      osc2.type = 'sine';
      osc1.frequency.setValueAtTime(1174.66, now); // D6
      osc2.frequency.setValueAtTime(2349.32, now); // D7

      gain.gain.setValueAtTime(0.14, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.32);

      osc1.connect(gain);
      osc2.connect(gain);
      gain.connect(this._sfxGain);

      osc1.start(now);
      osc2.start(now);
      osc1.stop(now + 0.32);
      osc2.stop(now + 0.32);
    } catch {}
  }

  /**
   * Threat/alert: Pulsing klaxon (triangle wave, 880Hz, 3 pulses)
   */
  playAlert() {
    const ctx = this.getContext();
    if (!ctx || !this._alertGain) return;
    try {
      const now = ctx.currentTime || 0;
      for (let i = 0; i < 3; i++) {
        const pulseStart = now + i * 0.16;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();

        osc.type = 'triangle';
        osc.frequency.setValueAtTime(880, pulseStart);
        osc.frequency.exponentialRampToValueAtTime(740, pulseStart + 0.11);

        gain.gain.setValueAtTime(0.18, pulseStart);
        gain.gain.exponentialRampToValueAtTime(0.001, pulseStart + 0.12);

        osc.connect(gain);
        gain.connect(this._alertGain);

        osc.start(pulseStart);
        osc.stop(pulseStart + 0.12);
      }
    } catch {}
  }

  /**
   * Geofence breach: Dual-tone warble (alternating 920 / 1040 Hz)
   */
  playGeofenceBreach() {
    const ctx = this.getContext();
    if (!ctx || !this._alertGain) return;
    try {
      const now = ctx.currentTime || 0;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.type = 'sawtooth';
      const steps = [920, 1040, 920, 1040, 920];
      for (let i = 0; i < steps.length; i++) {
        osc.frequency.setValueAtTime(steps[i], now + i * 0.08);
      }

      gain.gain.setValueAtTime(0.16, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.44);

      osc.connect(gain);
      gain.connect(this._alertGain);

      osc.start(now);
      osc.stop(now + 0.44);
    } catch {}
  }

  /**
   * Globe reset: Orbital decay whoosh (filtered noise sweep down)
   */
  playGlobeReset() {
    const ctx = this.getContext();
    if (!ctx || !this._sfxGain) return;
    try {
      const now = ctx.currentTime || 0;
      const duration = 0.8;
      const noise = this._getNoiseBuffer(ctx);
      if (!noise) {
        this.playRelease();
        return;
      }
      const source = ctx.createBufferSource();
      source.buffer = noise;

      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(1400, now);
      filter.frequency.exponentialRampToValueAtTime(100, now + duration);

      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.15, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + duration);

      source.connect(filter);
      filter.connect(gain);
      gain.connect(this._sfxGain);

      source.start(now);
      source.stop(now + duration);
    } catch {}
  }

  /**
   * Radio tuning: Static crackle into clean tone
   */
  playRadioTuning() {
    const ctx = this.getContext();
    if (!ctx || !this._sfxGain) return;
    try {
      const now = ctx.currentTime || 0;
      const noise = this._getNoiseBuffer(ctx);
      if (noise) {
        const source = ctx.createBufferSource();
        source.buffer = noise;
        const filter = ctx.createBiquadFilter();
        filter.type = 'bandpass';
        filter.frequency.setValueAtTime(2200, now);
        filter.Q.setValueAtTime(5, now);

        const noiseGain = ctx.createGain();
        noiseGain.gain.setValueAtTime(0.15, now);
        noiseGain.gain.exponentialRampToValueAtTime(0.001, now + 0.25);

        source.connect(filter);
        filter.connect(noiseGain);
        noiseGain.connect(this._sfxGain);
        source.start(now);
        source.stop(now + 0.25);
      }

      const tone = ctx.createOscillator();
      const toneGain = ctx.createGain();
      tone.type = 'sine';
      tone.frequency.setValueAtTime(1000, now + 0.15);

      toneGain.gain.setValueAtTime(0.001, now + 0.15);
      toneGain.gain.linearRampToValueAtTime(0.08, now + 0.2);
      toneGain.gain.exponentialRampToValueAtTime(0.001, now + 0.4);

      tone.connect(toneGain);
      toneGain.connect(this._sfxGain);
      tone.start(now + 0.15);
      tone.stop(now + 0.4);
    } catch {}
  }
}

// Global singleton instance
let tacticalAudioInstance = null;

export function getTacticalAudio(options) {
  if (!tacticalAudioInstance) {
    tacticalAudioInstance = new TacticalAudioEngine(options);
  }
  return tacticalAudioInstance;
}

export { TacticalAudioEngine };
