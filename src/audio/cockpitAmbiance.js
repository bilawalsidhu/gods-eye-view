/**
 * Cockpit Audio Ambiance Engine.
 *
 * Synthesizes continuous procedural jet/turbofan engine rumble and wind noise
 * modulated dynamically by telemetry (groundspeed, bank angle, vertical rate).
 */

import { getTacticalAudio } from './tacticalAudio.js';

export class CockpitAmbiance {
  constructor({ audioEngine = null } = {}) {
    this.audioEngine = audioEngine || getTacticalAudio();
    this._active = false;
    this._subOsc = null;
    this._rumbleOsc = null;
    this._rumbleFilter = null;
    this._rumbleGain = null;
    this._noiseNode = null;
    this._noiseFilter = null;
    this._noiseGain = null;
    this._masterGain = null;
    this._panner = null;
    this._targetVolume = 0.5;
  }

  /**
   * Start procedural cockpit ambiance audio.
   */
  start() {
    if (this._active) return;
    const ctx = this.audioEngine.getContext();
    if (!ctx || !this.audioEngine.ambianceBus) return;

    try {
      const now = ctx.currentTime || 0;
      this._active = true;

      // Master gain for this ambiance instance
      this._masterGain = ctx.createGain();
      this._masterGain.gain.setValueAtTime(0.0001, now);
      this._masterGain.gain.linearRampToValueAtTime(
        this._targetVolume,
        now + 1.2,
      );

      // Stereo panner for bank angle spatial shifts
      if (typeof ctx.createStereoPanner === 'function') {
        this._panner = ctx.createStereoPanner();
        this._masterGain.connect(this._panner);
        this._panner.connect(this.audioEngine.ambianceBus);
      } else {
        this._panner = null;
        this._masterGain.connect(this.audioEngine.ambianceBus);
      }

      // Sub-bass sine oscillator (52 Hz base)
      this._subOsc = ctx.createOscillator();
      this._subOsc.type = 'sine';
      this._subOsc.frequency.setValueAtTime(52, now);
      const subGain = ctx.createGain();
      subGain.gain.setValueAtTime(0.35, now);
      this._subOsc.connect(subGain);
      subGain.connect(this._masterGain);
      this._subOsc.start(now);

      // Rumble lowpass sawtooth
      this._rumbleOsc = ctx.createOscillator();
      this._rumbleOsc.type = 'sawtooth';
      this._rumbleOsc.frequency.setValueAtTime(95, now);

      this._rumbleFilter = ctx.createBiquadFilter();
      this._rumbleFilter.type = 'lowpass';
      this._rumbleFilter.frequency.setValueAtTime(140, now);
      this._rumbleFilter.Q.setValueAtTime(1.8, now);

      this._rumbleGain = ctx.createGain();
      this._rumbleGain.gain.setValueAtTime(0.22, now);

      this._rumbleOsc.connect(this._rumbleFilter);
      this._rumbleFilter.connect(this._rumbleGain);
      this._rumbleGain.connect(this._masterGain);
      this._rumbleOsc.start(now);

      // Airflow / wind noise
      const noiseBuffer = this.audioEngine._getNoiseBuffer(ctx);
      if (noiseBuffer) {
        this._noiseNode = ctx.createBufferSource();
        this._noiseNode.buffer = noiseBuffer;
        this._noiseNode.loop = true;

        this._noiseFilter = ctx.createBiquadFilter();
        this._noiseFilter.type = 'bandpass';
        this._noiseFilter.frequency.setValueAtTime(320, now);
        this._noiseFilter.Q.setValueAtTime(1.0, now);

        this._noiseGain = ctx.createGain();
        this._noiseGain.gain.setValueAtTime(0.12, now);

        this._noiseNode.connect(this._noiseFilter);
        this._noiseFilter.connect(this._noiseGain);
        this._noiseGain.connect(this._masterGain);
        this._noiseNode.start(now);
      }
    } catch (err) {
      this._lastError = err;
      this._active = false;
    }
  }

  /**
   * Update engine pitch and airflow sound based on telemetry.
   * @param {object} params
   * @param {number} [params.speedKts=350]
   * @param {number} [params.rollDeg=0]
   * @param {number} [params.verticalRateFpm=0]
   */
  updateTelemetry({ speedKts = 350, rollDeg = 0, verticalRateFpm = 0 } = {}) {
    if (!this._active || !this._masterGain) return;
    const ctx = this.audioEngine.getContext();
    if (!ctx) return;

    try {
      const now = ctx.currentTime || 0;
      const speed = Math.max(80, Math.min(1200, Number(speedKts) || 350));
      const speedRatio = speed / 450;

      // Modulate sub frequency: 45Hz at low speed, up to 75Hz at Mach 1+
      if (this._subOsc) {
        const subFreq = 48 + speedRatio * 18;
        this._subOsc.frequency.setTargetAtTime(subFreq, now, 0.2);
      }

      // Modulate rumble filter cutoff and oscillator
      if (this._rumbleOsc && this._rumbleFilter) {
        const rumbleFreq = 80 + speedRatio * 40;
        const filterCutoff = 120 + speedRatio * 80;
        this._rumbleOsc.frequency.setTargetAtTime(rumbleFreq, now, 0.2);
        this._rumbleFilter.frequency.setTargetAtTime(filterCutoff, now, 0.2);
      }

      // Wind noise bandwidth increases with speed
      if (this._noiseFilter && this._noiseGain) {
        const noiseFreq = 260 + speedRatio * 200;
        const noiseVol = Math.min(0.3, 0.08 + speedRatio * 0.12);
        this._noiseFilter.frequency.setTargetAtTime(noiseFreq, now, 0.2);
        this._noiseGain.gain.setTargetAtTime(noiseVol, now, 0.2);
      }

      // Spatial roll pan: -1.0 (full left) to +1.0 (full right)
      if (this._panner) {
        const pan = Math.max(-0.6, Math.min(0.6, (rollDeg / 45) * 0.5));
        this._panner.pan.setTargetAtTime(pan, now, 0.1);
      }
    } catch {}
  }

  /**
   * Stop procedural cockpit ambiance audio with smooth fade-out.
   */
  stop() {
    if (!this._active) return;
    this._active = false;
    const ctx = this.audioEngine.getContext();
    if (!ctx || !this._masterGain) {
      this._cleanup();
      return;
    }

    try {
      const now = ctx.currentTime || 0;
      this._masterGain.gain.setValueAtTime(this._masterGain.gain.value, now);
      this._masterGain.gain.linearRampToValueAtTime(0.0001, now + 0.8);
      setTimeout(() => {
        this._cleanup();
      }, 850);
    } catch {
      this._cleanup();
    }
  }

  _cleanup() {
    try {
      if (this._subOsc) {
        this._subOsc.stop();
        this._subOsc.disconnect();
      }
      if (this._rumbleOsc) {
        this._rumbleOsc.stop();
        this._rumbleOsc.disconnect();
      }
      if (this._noiseNode) {
        this._noiseNode.stop();
        this._noiseNode.disconnect();
      }
      if (this._masterGain) {
        this._masterGain.disconnect();
      }
      if (this._panner) {
        this._panner.disconnect();
      }
    } catch {}
    this._subOsc = null;
    this._rumbleOsc = null;
    this._noiseNode = null;
    this._masterGain = null;
    this._panner = null;
    this._active = false;
  }

  isActive() {
    return this._active;
  }
}
