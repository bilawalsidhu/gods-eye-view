import {
  PUSH_TO_TALK_HOLD_DELAY_MS,
  MICROPHONE_VISUALIZER_GATE,
  ASSISTANT_VISUALIZER_GATE,
  isPushToTalkKey,
  SPACE_INTERACTIVE_SELECTOR,
  isInteractiveSpaceTarget,
  shouldHandlePushToTalkKeyDown,
  selectVoiceVisualizerSignal,
  resolveVoiceVisualizerSpeaker,
  resolveVoiceControlHint,
  gateVoiceVisualizerLevel,
  resetVoiceVisualizerBars,
} from './realtimeInputPolicy.js';
import { shouldPauseRadioForVoice } from './realtimeProtocol.js';

/** Own physical push-to-talk gestures, microphone controls and audio meters. */
export class RealtimeInput {
  constructor({ readUi, readStream, readStatus, operations }) {
    Object.assign(this, { readUi, readStream, readStatus }, operations);
    this.visualizerAudioContext = null;
    this.visualizerAnalyser = null;
    this.visualizerSource = null;
    this.visualizerFrame = null;
    this.visualizerData = null;
    this.visualizerOutputSource = null;
    this.visualizerOutputAnalyser = null;
    this.visualizerOutputData = null;
    this.visualizerGeneration = 0;
    this.visualizerSpeaker = 'idle';
    this.pushToTalkMode = false;
    this.pushToTalkKeyHeld = false;
    this.spaceKeyHeld = false;
    this.pushToTalkHoldTimer = null;
    this.pushToTalkHoldGeneration = 0;
    this.pushToTalkHoldFocusOwner = null;
    this.pushToTalkHoldControl = null;
    this.pushToTalkHoldPreservesNative = false;
    this.shortcutKeyDownHandler = null;
    this.shortcutKeyUpHandler = null;
    this.shortcutBlurHandler = null;
    this.shortcutVisibilityHandler = null;
  }
  get ui() {
    return this.readUi();
  }
  get stream() {
    return this.readStream();
  }
  get status() {
    return this.readStatus();
  }
  /** Registers delayed hold-Space push-to-talk while preserving short control taps. */
  bindPushToTalkShortcut() {
    if (this.shortcutKeyDownHandler) return;
    this.shortcutKeyDownHandler = (event) => {
      if (!shouldHandlePushToTalkKeyDown(event)) return;
      if (event.repeat) {
        if (this.spaceKeyHeld && !this.pushToTalkHoldPreservesNative)
          event.preventDefault();
        if (this.pushToTalkKeyHeld) event.preventDefault();
        return;
      }
      this.spaceKeyHeld = true;
      this.pushToTalkHoldFocusOwner = document.activeElement;
      this.pushToTalkHoldControl = isInteractiveSpaceTarget(
        document.activeElement,
      )
        ? document.activeElement
        : isInteractiveSpaceTarget(event.target)
          ? event.target.closest?.(SPACE_INTERACTIVE_SELECTOR) || event.target
          : null;
      this.pushToTalkHoldPreservesNative = Boolean(this.pushToTalkHoldControl);
      // Background Space is reserved immediately to avoid scrolling. A focused
      // control keeps its native keydown and release unless the hold is claimed.
      if (!this.pushToTalkHoldPreservesNative) event.preventDefault();
      // A click-started session is intentionally open-mic. Space only claims an
      // idle session (or a session it already started) so releasing the key can
      // never surprise the user by muting a click-started conversation.
      if (this.isActive() && !this.pushToTalkMode) return;
      this.cancelPushToTalkHold();
      const holdGeneration = ++this.pushToTalkHoldGeneration;
      this.pushToTalkHoldTimer = setTimeout(() => {
        this.pushToTalkHoldTimer = null;
        if (holdGeneration !== this.pushToTalkHoldGeneration) return;
        if (!this.spaceKeyHeld || this.pushToTalkKeyHeld) return;
        // A pointer or Tab focus change during the delay cancels the original
        // gesture rather than letting voice claim a key held for another owner.
        if (document.activeElement !== this.pushToTalkHoldFocusOwner) return;
        if (
          document.visibilityState === 'hidden' ||
          (typeof document.hasFocus === 'function' && !document.hasFocus())
        )
          return;
        if (this.isActive() && !this.pushToTalkMode) return;
        // Blur before voice starts. This removes the focused state and ensures
        // the eventual Space release cannot activate the old control.
        if (
          this.pushToTalkHoldControl &&
          document.activeElement === this.pushToTalkHoldControl &&
          typeof this.pushToTalkHoldControl.blur === 'function'
        ) {
          this.pushToTalkHoldControl.blur();
        }
        this.pauseRadioForVoice();
        this.pushToTalkKeyHeld = true;
        if (this.isActive()) {
          this.ui.root.dataset.pushToTalk = 'held';
          this.setMicrophoneEnabled(true);
          if (this.status === 'listening')
            this.setStatus('listening', 'Release Space to send');
        } else {
          this.start({ pushToTalk: true });
          // start() performs a controlled stop() before connecting. Restore the
          // marker it clears so the UI reflects this still-held gesture.
          if (this.pushToTalkKeyHeld) this.ui.root.dataset.pushToTalk = 'held';
        }
      }, PUSH_TO_TALK_HOLD_DELAY_MS);
    };
    this.shortcutKeyUpHandler = (event) => {
      if (!isPushToTalkKey(event)) return;
      const wasHoldingSpace = this.spaceKeyHeld;
      const preservedNativeActivation = this.pushToTalkHoldPreservesNative;
      this.spaceKeyHeld = false;
      this.cancelPushToTalkHold();
      if (!this.pushToTalkKeyHeld) {
        if (wasHoldingSpace && !preservedNativeActivation)
          event.preventDefault();
        this.resetPushToTalkGesture();
        return;
      }
      event.preventDefault();
      this.releasePushToTalkKey();
      this.resetPushToTalkGesture();
    };
    this.shortcutBlurHandler = () => {
      this.spaceKeyHeld = false;
      this.cancelPushToTalkHold();
      this.releasePushToTalkKey();
      this.resetPushToTalkGesture();
    };
    this.shortcutVisibilityHandler = () => {
      if (document.visibilityState === 'hidden') this.shortcutBlurHandler();
    };
    // Observe before custom controls call preventDefault for their own Space
    // behavior. This lets the same physical hold cross the 500ms voice
    // threshold while short taps still reach the control unchanged.
    document.addEventListener('keydown', this.shortcutKeyDownHandler, true);
    document.addEventListener('keyup', this.shortcutKeyUpHandler, true);
    window.addEventListener('blur', this.shortcutBlurHandler);
    document.addEventListener(
      'visibilitychange',
      this.shortcutVisibilityHandler,
    );
  }

  /** Cancels an unclaimed Space hold before it starts voice. */
  cancelPushToTalkHold() {
    this.pushToTalkHoldGeneration++;
    if (this.pushToTalkHoldTimer === null) return;
    clearTimeout(this.pushToTalkHoldTimer);
    this.pushToTalkHoldTimer = null;
  }

  /** Clears the owner metadata for the current physical Space gesture. */
  resetPushToTalkGesture() {
    this.pushToTalkHoldFocusOwner = null;
    this.pushToTalkHoldControl = null;
    this.pushToTalkHoldPreservesNative = false;
  }

  /**
   * Mutes a keyboard-started microphone while leaving WebRTC alive for the reply.
   * @returns {void}
   */
  releasePushToTalkKey() {
    this.cancelPushToTalkHold();
    if (!this.pushToTalkKeyHeld) return;
    this.pushToTalkKeyHeld = false;
    delete this.ui.root.dataset.pushToTalk;
    if (!this.pushToTalkMode) return;
    this.setMicrophoneEnabled(false);
    if (this.status === 'listening')
      this.setStatus('listening', 'Hold Space to talk');
    else this.updateVoiceButtonLabel();
  }

  /**
   * Enables or mutes only the outbound microphone tracks.
   * @param {boolean} enabled
   * @returns {void}
   */
  setMicrophoneEnabled(enabled) {
    if (this.ui?.root)
      this.ui.root.dataset.microphone = enabled ? 'active' : 'muted';
    this.stream?.getAudioTracks?.().forEach((track) => {
      track.enabled = Boolean(enabled);
    });
  }

  /**
   * Drives the dock waveform from live microphone energy while voice is active.
   * @param {MediaStream} stream
   * @returns {void}
   */
  startVoiceVisualizer(stream) {
    this.stopVoiceVisualizer();
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    const bars = Array.from(
      this.ui.root.querySelectorAll('.gev-voice-visualizer span'),
    );
    if (!AudioContextClass || !stream || !bars.length) return;
    try {
      const context = new AudioContextClass();
      this.visualizerAudioContext = context;
      context.resume().catch(() => {});
      const analyser = context.createAnalyser();
      analyser.fftSize = 64;
      analyser.smoothingTimeConstant = 0.72;
      const source = context.createMediaStreamSource(stream);
      source.connect(analyser);
      this.visualizerAnalyser = analyser;
      this.visualizerSource = source;
      this.visualizerData = new Uint8Array(analyser.frequencyBinCount);

      const generation = this.visualizerGeneration;
      const render = () => {
        if (generation !== this.visualizerGeneration) return;
        const signal = selectVoiceVisualizerSignal(
          this.visualizerSpeaker,
          {
            analyser: this.visualizerAnalyser,
            data: this.visualizerData,
          },
          {
            analyser: this.visualizerOutputAnalyser,
            data: this.visualizerOutputData,
          },
        );
        if (!signal) {
          resetVoiceVisualizerBars(bars);
          this.visualizerFrame = requestAnimationFrame(render);
          return;
        }
        signal.analyser.getByteFrequencyData(signal.data);
        const binCount = signal.data.length;
        bars.forEach((bar, index) => {
          const start = Math.floor((index / bars.length) * binCount);
          const end = Math.max(
            start + 1,
            Math.floor(((index + 1) / bars.length) * binCount),
          );
          let energy = 0;
          for (let bin = start; bin < end; bin++) energy += signal.data[bin];
          const normalized = Math.min(1, energy / (end - start) / 190);
          const gate =
            this.visualizerSpeaker === 'ai'
              ? ASSISTANT_VISUALIZER_GATE
              : MICROPHONE_VISUALIZER_GATE;
          const shaped = Math.pow(
            gateVoiceVisualizerLevel(normalized, gate),
            0.72,
          );
          bar.style.setProperty(
            '--audio-level',
            `${Math.round(5 + shaped * 29)}px`,
          );
          bar.style.setProperty(
            '--audio-opacity',
            `${(0.5 + shaped * 0.5).toFixed(2)}`,
          );
        });
        this.visualizerFrame = requestAnimationFrame(render);
      };
      render();
    } catch {
      this.stopVoiceVisualizer();
    }
  }

  /**
   * Adds the incoming assistant audio stream to the existing Web Audio meter.
   * The audio element remains responsible for playback; this branch only reads
   * its frequency energy for the visualizer.
   * @param {MediaStream} stream
   * @returns {void}
   */
  startAssistantVoiceVisualizer(stream) {
    const context = this.visualizerAudioContext;
    if (!context || !stream) return;
    try {
      try {
        this.visualizerOutputSource?.disconnect();
      } catch {
        /* no-op */
      }
      const analyser = context.createAnalyser();
      analyser.fftSize = 64;
      analyser.smoothingTimeConstant = 0.72;
      const source = context.createMediaStreamSource(stream);
      source.connect(analyser);
      this.visualizerOutputSource = source;
      this.visualizerOutputAnalyser = analyser;
      this.visualizerOutputData = new Uint8Array(analyser.frequencyBinCount);
    } catch {
      // Playback continues through audioEl even if a browser declines analysis.
      this.visualizerOutputSource = null;
      this.visualizerOutputAnalyser = null;
      this.visualizerOutputData = null;
    }
  }

  /**
   * Releases the microphone meter and restores its five-pixel baseline.
   * @returns {void}
   */
  stopVoiceVisualizer() {
    this.visualizerGeneration++;
    if (this.visualizerFrame) cancelAnimationFrame(this.visualizerFrame);
    this.visualizerFrame = null;
    try {
      this.visualizerSource?.disconnect();
    } catch {
      /* no-op */
    }
    try {
      this.visualizerOutputSource?.disconnect();
    } catch {
      /* no-op */
    }
    this.visualizerSource = null;
    this.visualizerAnalyser = null;
    this.visualizerData = null;
    this.visualizerOutputSource = null;
    this.visualizerOutputAnalyser = null;
    this.visualizerOutputData = null;
    this.visualizerSpeaker = 'idle';
    if (this.visualizerAudioContext) {
      this.visualizerAudioContext.close().catch(() => {});
      this.visualizerAudioContext = null;
    }
    resetVoiceVisualizerBars(
      this.ui?.root?.querySelectorAll('.gev-voice-visualizer span'),
    );
  }

  /**
   * Keeps the microphone caption in sync with click and hold-to-talk modes.
   * @returns {void}
   */
  updateVoiceButtonLabel() {
    if (!this.ui.buttonLabel) return;
    this.ui.buttonLabel.textContent = 'MIC';
    if (this.ui.helpDetail) {
      this.ui.helpDetail.textContent = resolveVoiceControlHint(
        this.pushToTalkMode,
        this.pushToTalkKeyHeld,
      );
    }
  }

  setVoiceSpeaker(speaker, { keepVisualizerSpeaker = false } = {}) {
    const nextSpeaker =
      speaker === 'user' || speaker === 'ai' ? speaker : 'idle';
    this.visualizerSpeaker = resolveVoiceVisualizerSpeaker(
      this.visualizerSpeaker,
      nextSpeaker,
      keepVisualizerSpeaker,
    );
    this.ui.root.dataset.speaker = nextSpeaker;
    if (shouldPauseRadioForVoice({ speaker: nextSpeaker }))
      this.pauseRadioForVoice();
  }

  resetSession() {
    this.pushToTalkMode = false;
    this.pushToTalkKeyHeld = false;
    this.spaceKeyHeld = false;
    this.resetPushToTalkGesture();
    if (this.ui?.root) {
      delete this.ui.root.dataset.pushToTalk;
      delete this.ui.root.dataset.microphone;
    }
  }

  detachBindings() {
    if (this.shortcutKeyDownHandler)
      document.removeEventListener(
        'keydown',
        this.shortcutKeyDownHandler,
        true,
      );
    if (this.shortcutKeyUpHandler)
      document.removeEventListener('keyup', this.shortcutKeyUpHandler, true);
    if (this.shortcutBlurHandler)
      window.removeEventListener('blur', this.shortcutBlurHandler);
    if (this.shortcutVisibilityHandler) {
      document.removeEventListener(
        'visibilitychange',
        this.shortcutVisibilityHandler,
      );
    }
    this.shortcutKeyDownHandler = null;
    this.shortcutKeyUpHandler = null;
    this.shortcutBlurHandler = null;
    this.shortcutVisibilityHandler = null;
  }
}
