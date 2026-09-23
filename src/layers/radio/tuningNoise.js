import {
  RADIO_TUNER_STATIC_MAX_GAIN,
  EMPTY_ACCEPTED_CATALOG_SNAPSHOT,
} from './policy.js';

export function createTuningNoise({
  state: layerState,
  services,
  parts,
  source,
}) {
  /** Decide whether tuner static should be audible for the current handoff state. */

  function radioTuningStaticShouldPlay({
    tuningActive = false,
    tuningStatic = false,
    awaitingStationId = null,
    voiceDucked = false,
  } = {}) {
    return Boolean(
      tuningStatic && !voiceDucked && (tuningActive || awaitingStationId),
    );
  }

  function stopTuningNoiseSource() {
    if (layerState._tuningNoiseSource) {
      try {
        layerState._tuningNoiseSource.stop();
      } catch {
        /* already stopped */
      }
      try {
        layerState._tuningNoiseSource.disconnect();
      } catch {
        /* already disconnected */
      }
    }
    try {
      layerState._tuningNoiseFilter?.disconnect();
    } catch {
      /* already disconnected */
    }
    try {
      layerState._tuningNoiseGain?.disconnect();
    } catch {
      /* already disconnected */
    }
    layerState._tuningNoiseSource = null;
    layerState._tuningNoiseFilter = null;
    layerState._tuningNoiseGain = null;
  }

  function syncTuningNoiseGain() {
    if (!layerState._tuningNoiseContext || !layerState._tuningNoiseGain) return;
    const audible = radioTuningStaticShouldPlay({
      tuningActive: layerState._tuningActive,
      tuningStatic: layerState._tuningStatic,
      awaitingStationId: layerState._tuningAwaitingStationId,
      voiceDucked: layerState._voiceDucked,
    });
    const target = audible
      ? Math.min(RADIO_TUNER_STATIC_MAX_GAIN, layerState._userVolume * 0.03)
      : 0;
    const now = layerState._tuningNoiseContext.currentTime;
    layerState._tuningNoiseGain.gain.cancelScheduledValues(now);
    layerState._tuningNoiseGain.gain.setValueAtTime(
      layerState._tuningNoiseGain.gain.value,
      now,
    );
    layerState._tuningNoiseGain.gain.linearRampToValueAtTime(
      target,
      now + 0.025,
    );
  }

  function installTuningNoise() {
    const AudioContextClass =
      globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!AudioContextClass) return false;
    if (!layerState._tuningNoiseContext)
      layerState._tuningNoiseContext = new AudioContextClass();
    const resumed = layerState._tuningNoiseContext.resume?.();
    if (resumed?.catch) void resumed.catch(() => {});
    if (layerState._tuningNoiseSource) return true;

    const frameCount = Math.max(
      1,
      Math.floor(layerState._tuningNoiseContext.sampleRate * 0.75),
    );
    const buffer = layerState._tuningNoiseContext.createBuffer(
      1,
      frameCount,
      layerState._tuningNoiseContext.sampleRate,
    );
    const channel = buffer.getChannelData(0);
    for (let index = 0; index < channel.length; index += 1)
      channel[index] = Math.random() * 2 - 1;

    layerState._tuningNoiseSource =
      layerState._tuningNoiseContext.createBufferSource();
    layerState._tuningNoiseFilter =
      layerState._tuningNoiseContext.createBiquadFilter();
    layerState._tuningNoiseGain = layerState._tuningNoiseContext.createGain();
    layerState._tuningNoiseSource.buffer = buffer;
    layerState._tuningNoiseSource.loop = true;
    layerState._tuningNoiseFilter.type = 'bandpass';
    layerState._tuningNoiseFilter.frequency.value = 1_650;
    layerState._tuningNoiseFilter.Q.value = 0.55;
    layerState._tuningNoiseGain.gain.value = 0;
    layerState._tuningNoiseSource.connect(layerState._tuningNoiseFilter);
    layerState._tuningNoiseFilter.connect(layerState._tuningNoiseGain);
    layerState._tuningNoiseGain.connect(
      layerState._tuningNoiseContext.destination,
    );
    layerState._tuningNoiseSource.start();
    return true;
  }

  function clearRadioTuningNoise({ emit = true, restoredStation = null } = {}) {
    if (layerState._tuningCameraNavigation)
      parts.navigation.invalidateRadioCameraNavigation();
    layerState._tuningActive = false;
    layerState._tuningStatic = false;
    layerState._tuningAwaitingStationId = null;
    layerState._tuningPreviewId = null;
    layerState._tuningStartStationId = null;
    layerState._tuningResolutionSnapshot = EMPTY_ACCEPTED_CATALOG_SNAPSHOT;
    layerState._tuningStationById = new Map();
    layerState._tuningCameraNavigation = null;
    layerState._cancelledTuningPresentationStation = restoredStation;
    parts.rendering.updateSelectionEntity();
    syncTuningNoiseGain();
    stopTuningNoiseSource();
    const suspended = layerState._tuningNoiseContext?.suspend?.();
    if (suspended?.catch) void suspended.catch(() => {});
    if (emit) parts.presentation.emitState();
  }
  return {
    radioTuningStaticShouldPlay,
    stopTuningNoiseSource,
    syncTuningNoiseGain,
    installTuningNoise,
    clearRadioTuningNoise,
  };
}
