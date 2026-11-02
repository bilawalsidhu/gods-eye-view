import { VOICE_RESTORE_DELAY_MS, VOICE_RESTORE_DURATION_MS } from './policy.js';

export function createVolume({ state: layerState, services, parts, source }) {
  function clampRadioVolume(value) {
    return Math.min(1, Math.max(0, Number(value) || 0));
  }

  function cancelRadioVolumeTransition() {
    layerState._volumeTransitionGeneration += 1;
    if (layerState._voiceRestoreTimer)
      clearTimeout(layerState._voiceRestoreTimer);
    layerState._voiceRestoreTimer = null;
    if (layerState._volumeFadeFrame) {
      if (typeof cancelAnimationFrame === 'function')
        cancelAnimationFrame(layerState._volumeFadeFrame);
      else clearTimeout(layerState._volumeFadeFrame);
    }
    layerState._volumeFadeFrame = null;
  }

  function scheduleVolumeFrame(callback) {
    if (typeof requestAnimationFrame === 'function')
      return requestAnimationFrame(callback);
    return setTimeout(() => callback(Date.now()), 16);
  }

  function volumeClock() {
    return typeof performance !== 'undefined' &&
      typeof performance.now === 'function'
      ? performance.now()
      : Date.now();
  }

  /** Set shared audio volume, clamped to [0, 1]. */

  function setRadioVolume(value) {
    if (!parts.interaction.radioPresentationAllowed()) return false;
    const volume = clampRadioVolume(value);
    layerState._userVolume = volume;
    parts.playback.installAudio();
    if (!layerState._voiceDucked) {
      cancelRadioVolumeTransition();
      layerState._voiceRestoring = false;
      if (layerState._audio) layerState._audio.volume = volume;
    }
    parts.tuningNoise.syncTuningNoiseGain();
    parts.presentation.emitState();
    return true;
  }

  /**
   * Mute Radio during a live voice turn, then gently restore the user-owned
   * volume after voice returns to standby. Repeated state sync is idempotent.
   */

  function setRadioVoiceDucking(
    ducked,
    {
      restoreDelayMs = VOICE_RESTORE_DELAY_MS,
      restoreDurationMs = VOICE_RESTORE_DURATION_MS,
    } = {},
  ) {
    const shouldDuck = Boolean(ducked);
    if (
      shouldDuck === layerState._voiceDucked &&
      (shouldDuck || layerState._voiceRestoring)
    )
      return;
    if (
      !shouldDuck &&
      !layerState._voiceDucked &&
      !layerState._voiceRestoring &&
      (!layerState._audio ||
        Math.abs(layerState._audio.volume - layerState._userVolume) < 0.001)
    )
      return;

    cancelRadioVolumeTransition();
    layerState._voiceDucked = shouldDuck;
    layerState._voiceRestoring = false;

    if (shouldDuck) {
      if (layerState._audio) layerState._audio.volume = 0;
      parts.tuningNoise.syncTuningNoiseGain();
      parts.presentation.emitState();
      return;
    }
    if (!layerState._audio) {
      parts.tuningNoise.syncTuningNoiseGain();
      layerState._voiceRestoring = false;
      parts.presentation.emitState();
      return;
    }

    const generation = layerState._volumeTransitionGeneration;
    parts.tuningNoise.syncTuningNoiseGain();
    layerState._voiceRestoring = true;
    parts.presentation.emitState();
    const beginRestore = () => {
      layerState._voiceRestoreTimer = null;
      if (
        generation !== layerState._volumeTransitionGeneration ||
        layerState._voiceDucked ||
        !layerState._audio
      )
        return;
      const startedAt = volumeClock();
      const initialVolume = layerState._audio.volume;
      const duration = Math.max(0, Number(restoreDurationMs) || 0);
      const step = (now) => {
        if (
          generation !== layerState._volumeTransitionGeneration ||
          layerState._voiceDucked ||
          !layerState._audio
        )
          return;
        const progress =
          duration === 0
            ? 1
            : Math.min(1, Math.max(0, (now - startedAt) / duration));
        const eased = progress * progress * (3 - 2 * progress);
        layerState._audio.volume = clampRadioVolume(
          initialVolume + (layerState._userVolume - initialVolume) * eased,
        );
        if (progress < 1) {
          layerState._volumeFadeFrame = scheduleVolumeFrame(step);
          return;
        }
        layerState._volumeFadeFrame = null;
        layerState._voiceRestoring = false;
        parts.presentation.emitState();
      };
      layerState._volumeFadeFrame = scheduleVolumeFrame(step);
    };
    const delay = Math.max(0, Number(restoreDelayMs) || 0);
    if (delay > 0)
      layerState._voiceRestoreTimer = setTimeout(beginRestore, delay);
    else beginRestore();
  }
  return {
    clampRadioVolume,
    cancelRadioVolumeTransition,
    scheduleVolumeFrame,
    volumeClock,
    setRadioVolume,
    setRadioVoiceDucking,
  };
}
