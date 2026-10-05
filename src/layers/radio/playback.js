import { RADIO_VOICE_PLAYBACK_TIMEOUT_MS } from './policy.js';

export function createPlayback({ state: layerState, services, parts, source }) {
  function audioEventBelongsToActiveAttempt(audio) {
    const attempt = layerState._activePlaybackAttempt;
    return (
      layerState._audio === audio &&
      Boolean(attempt) &&
      attempt.generation === layerState._playGeneration &&
      attempt.stationId === layerState._audioStationId
    );
  }

  function installAudio({ replace = false } = {}) {
    if (layerState._audio && !replace) return;
    if (typeof Audio === 'undefined') return;
    const previousAudio = layerState._audio;
    layerState._audio = null;
    if (previousAudio) {
      try {
        previousAudio.pause();
      } catch {
        /* already stopped */
      }
      try {
        previousAudio.removeAttribute('src');
      } catch {
        /* no source */
      }
      try {
        previousAudio.load();
      } catch {
        /* detached media */
      }
    }
    const audio = new Audio();
    layerState._audio = audio;
    audio.preload = 'none';
    audio.volume = layerState._voiceDucked ? 0 : layerState._userVolume;
    audio.addEventListener('playing', () => {
      if (layerState._audio !== audio) return;
      if (!audioEventBelongsToActiveAttempt(audio)) return;
      if (!['loading', 'buffering', 'playing'].includes(layerState._audioState))
        return;
      layerState._audioState = 'playing';
      layerState._audioError = null;
      if (layerState._tuningAwaitingStationId === layerState._audioStationId)
        parts.tuningNoise.clearRadioTuningNoise({ emit: false });
      parts.presentation.emitState();
    });
    audio.addEventListener('pause', () => {
      if (layerState._audio !== audio) return;
      if (
        layerState._audioState === 'stopped' ||
        layerState._audioState === 'loading'
      )
        return;
      layerState._audioState = 'paused';
      parts.presentation.emitState();
    });
    audio.addEventListener('waiting', () => {
      if (layerState._audio !== audio) return;
      if (!audioEventBelongsToActiveAttempt(audio)) return;
      if (!['loading', 'buffering', 'playing'].includes(layerState._audioState))
        return;
      layerState._audioState = 'buffering';
      parts.presentation.emitState();
    });
    audio.addEventListener('error', () => {
      if (layerState._audio !== audio) return;
      if (!audioEventBelongsToActiveAttempt(audio)) return;
      if (!['loading', 'buffering', 'playing'].includes(layerState._audioState))
        return;
      const failedId = layerState._audioStationId;
      const attempt = layerState._activePlaybackAttempt;
      if (tryRadioFallback(failedId, attempt?.origin, attempt?.id)) return;
      layerState._audioState = 'error';
      layerState._audioError =
        'Broadcaster stream is unavailable or blocked by the browser.';
      parts.presentation.emitState();
    });
  }

  function tryRadioFallback(
    failedId,
    origin = layerState._playFallbackOrigin || 'programmatic',
    attemptId = layerState._playFallbackAttemptId,
  ) {
    const fallbackId = layerState._playFallbackId;
    const fallbackStation = fallbackId
      ? layerState._stationById.get(fallbackId)
      : null;
    const fallbackFocusPolicy = layerState._playFallbackFocus;
    layerState._playFallbackId = null;
    layerState._playFallbackFocus = null;
    layerState._playFallbackOrigin = 'programmatic';
    layerState._playFallbackAttemptId = null;
    if (
      !fallbackStation ||
      fallbackId === failedId ||
      layerState._selectedId !== failedId
    ) {
      return false;
    }
    const fallbackFocusResult =
      typeof fallbackFocusPolicy === 'function'
        ? fallbackFocusPolicy(fallbackStation)
        : fallbackFocusPolicy;
    const fallbackCameraNavigation =
      fallbackFocusResult && typeof fallbackFocusResult === 'object'
        ? fallbackFocusResult
        : null;
    const fallbackFocus = fallbackCameraNavigation
      ? false
      : Boolean(fallbackFocusResult);
    parts.selection.selectRadioStation(fallbackId, {
      autoplay: true,
      focus: fallbackFocus,
      origin: origin || 'programmatic',
      attemptId,
      cameraNavigation: fallbackCameraNavigation,
    });
    return true;
  }

  function recordDirectoryClick(id) {
    Promise.resolve()
      .then(() => source.recordClick(id))
      .catch(() => {});
  }

  /** Play the selected broadcaster stream after an explicit user action. */

  async function playSelectedRadio({
    origin = 'programmatic',
    attemptId = null,
  } = {}) {
    const station = parts.queries.selectedStation();
    if (!parts.interaction.radioPresentationAllowed() || !station?.streamUrl)
      return false;
    if (layerState._tuningActive) parts.tuning.endRadioTuning();
    // A media event carries no reliable attempt identity. Give every explicit
    // play/resume/replacement its own element so queued events from the retired
    // attempt remain bound to the discarded element and cannot mutate this one.
    installAudio({ replace: true });
    if (!layerState._audio) return false;

    const generation = ++layerState._playGeneration;
    const ownedAttemptId =
      attemptId || `radio-play-${++layerState._playAttemptSequence}`;
    layerState._activePlaybackAttempt = {
      id: ownedAttemptId,
      origin,
      stationId: station.id,
      streamUrl: station.streamUrl,
      generation,
    };
    if (layerState._playFallbackId) {
      layerState._playFallbackOrigin = origin;
      layerState._playFallbackAttemptId = ownedAttemptId;
    }
    layerState._audioError = null;
    layerState._audioState = 'loading';
    if (
      layerState._audioStationId !== station.id ||
      layerState._audio.src !== station.streamUrl
    ) {
      layerState._audio.pause();
      layerState._audio.src = station.streamUrl;
      layerState._audioStationId = station.id;
    }
    parts.presentation.emitState();

    try {
      const playback = layerState._audio.play();
      if (playback?.then) await playback;
      if (
        generation !== layerState._playGeneration ||
        layerState._audioStationId !== station.id ||
        layerState._activePlaybackAttempt?.id !== ownedAttemptId
      )
        return false;
      layerState._audioState = 'playing';
      if (layerState._tuningAwaitingStationId === station.id)
        parts.tuningNoise.clearRadioTuningNoise({ emit: false });
      layerState._playFallbackId = null;
      layerState._playFallbackFocus = null;
      layerState._playFallbackOrigin = 'programmatic';
      layerState._playFallbackAttemptId = null;
      recordDirectoryClick(station.id);
      parts.presentation.emitState();
      if (origin === 'user')
        parts.presentation.emitPlaybackControl('play', origin, ownedAttemptId);
      return true;
    } catch (error) {
      if (
        generation !== layerState._playGeneration ||
        layerState._activePlaybackAttempt?.id !== ownedAttemptId
      )
        return false;
      if (tryRadioFallback(station.id, origin, ownedAttemptId)) return false;
      layerState._audioState = 'error';
      layerState._audioError =
        error?.name === 'NotAllowedError'
          ? 'Playback requires a direct click or tap.'
          : 'Broadcaster stream could not be started.';
      parts.presentation.emitState();
      return false;
    }
  }

  /**
   * Wait for confirmed Radio playback while voice owns a hard mute.
   * A fallback station may replace the first stream during this wait, so the
   * state subscription—not the first play() promise—is authoritative.
   */

  function confirmRadioPlayback({
    startPlayback,
    subscribe,
    getState,
    timeoutMs = RADIO_VOICE_PLAYBACK_TIMEOUT_MS,
  } = {}) {
    if (
      typeof startPlayback !== 'function' ||
      typeof subscribe !== 'function' ||
      typeof getState !== 'function'
    ) {
      return Promise.resolve(false);
    }
    return new Promise((resolve) => {
      let settled = false;
      let started = false;
      let unsubscribe = () => {};
      let timer = null;
      const finish = (ok) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        unsubscribe();
        resolve(Boolean(ok));
      };
      const inspect = (state) => {
        if (!started || !state) return;
        if (
          !state.voiceDucked &&
          ['loading', 'buffering', 'playing'].includes(state.audioState)
        ) {
          finish(false);
          return;
        }
        if (
          state.audioState === 'playing' &&
          state.playingStationId &&
          state.voiceDucked
        ) {
          finish(true);
        } else if (state.audioState === 'error') {
          finish(false);
        }
      };
      unsubscribe = subscribe(inspect);
      started = true;
      timer = setTimeout(
        () => finish(false),
        Math.max(1, Number(timeoutMs) || RADIO_VOICE_PLAYBACK_TIMEOUT_MS),
      );
      Promise.resolve()
        .then(startPlayback)
        .then((playStarted) => {
          const state = getState();
          inspect(state);
          if (
            !playStarted &&
            !['loading', 'buffering', 'playing'].includes(state?.audioState)
          )
            finish(false);
        })
        .catch(() => finish(false));
    });
  }

  /** Start and verify a prepared station without ever making it audible under voice. */

  function playPreparedRadioForVoice(options = {}) {
    if (!layerState._voiceDucked) return Promise.resolve(false);
    return confirmRadioPlayback({
      startPlayback: () =>
        playSelectedRadio({ origin: 'voice', attemptId: options.attemptId }),
      subscribe: parts.presentation.subscribeToRadio,
      getState: parts.presentation.getRadioUIState,
      timeoutMs: options.timeoutMs,
    });
  }

  /** Stop the shared stream and release its network resource. */

  function stopRadioPlayback({
    origin = 'programmatic',
    attemptId = null,
  } = {}) {
    if (attemptId && layerState._activePlaybackAttempt?.id !== attemptId)
      return false;
    const stoppedAttemptId = layerState._activePlaybackAttempt?.id || null;
    parts.tuning.endRadioTuning();
    layerState._playGeneration += 1;
    layerState._playFallbackId = null;
    layerState._playFallbackFocus = null;
    layerState._playFallbackOrigin = 'programmatic';
    layerState._playFallbackAttemptId = null;
    layerState._activePlaybackAttempt = null;
    if (layerState._audio) {
      layerState._audio.pause();
      layerState._audio.removeAttribute('src');
      layerState._audio.load();
    }
    layerState._audioStationId = null;
    layerState._audioState = 'stopped';
    layerState._audioError = null;
    parts.presentation.emitState();
    if (origin === 'user' || origin === 'voice') {
      parts.presentation.emitPlaybackControl('stop', origin, stoppedAttemptId);
    }
    return true;
  }

  /** Pause or resume the selected stream. Resuming is still click initiated. */

  function toggleRadioPlayback({ origin = 'programmatic' } = {}) {
    if (['loading', 'playing', 'buffering'].includes(layerState._audioState)) {
      return Promise.resolve(pauseRadioPlayback({ origin }));
    }
    if (!parts.interaction.radioPresentationAllowed())
      return Promise.resolve(false);
    if (!layerState._selectedId) {
      const ranked = parts.queries.rankedVisibleStations();
      if (!ranked.length) return Promise.resolve(false);
      layerState._playFallbackId = ranked[1]?.id || null;
      layerState._playFallbackFocus = false;
      parts.selection.selectRadioStation(ranked[0].id, {
        autoplay: false,
        focus: false,
      });
    }
    return playSelectedRadio({ origin });
  }

  /** Pause Radio without toggling a stopped or already-paused stream back on. */

  function pauseRadioPlayback({ origin = 'programmatic' } = {}) {
    if (!['loading', 'playing', 'buffering'].includes(layerState._audioState))
      return false;
    const pausedAttemptId = layerState._activePlaybackAttempt?.id || null;
    if (layerState._tuningAwaitingStationId && !layerState._tuningActive)
      parts.tuning.endRadioTuning();
    layerState._playGeneration += 1;
    layerState._playFallbackId = null;
    layerState._playFallbackFocus = null;
    layerState._playFallbackOrigin = 'programmatic';
    layerState._playFallbackAttemptId = null;
    layerState._activePlaybackAttempt = null;
    layerState._audio?.pause();
    layerState._audioState = 'paused';
    parts.presentation.emitState();
    if (origin === 'user' || origin === 'voice') {
      parts.presentation.emitPlaybackControl('pause', origin, pausedAttemptId);
    }
    return true;
  }
  return {
    audioEventBelongsToActiveAttempt,
    installAudio,
    tryRadioFallback,
    recordDirectoryClick,
    playSelectedRadio,
    confirmRadioPlayback,
    playPreparedRadioForVoice,
    stopRadioPlayback,
    toggleRadioPlayback,
    pauseRadioPlayback,
  };
}
