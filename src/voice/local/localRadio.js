import { startPreparedRadioAfterPlaybackReady } from '../realtimeProtocol.js';

/**
 * Radio ownership for the on-device voice. The shared runner prepares a
 * station without playing it; once the spoken confirmation has finished,
 * start() plays it muted, and only when playback is confirmed stops voice,
 * which releases the mute. Any newer turn or stop cancels the handoff.
 */
export function createLocalRadioHandoff({ radioLayer = null } = {}) {
  let epoch = 0;
  let attempt = null;
  const stopAttempt = (attemptId) =>
    radioLayer?.stopPlayback?.({ origin: 'voice-cleanup', attemptId });
  return {
    get inFlight() {
      return attempt !== null;
    },
    /** Silences Radio while voice speaks, unless voice is handing off to it. */
    silenceForVoice() {
      if (attempt) return false;
      radioLayer?.setVoiceDucked?.(true);
      return radioLayer?.pause?.({ origin: 'voice-duck' }) || false;
    },
    /** Releases the voice mute; called when voice stops. */
    release() {
      radioLayer?.setVoiceDucked?.(false);
    },
    cancel() {
      epoch++;
      if (!attempt) return;
      const attemptId = attempt;
      attempt = null;
      stopAttempt(attemptId);
    },
    /**
     * @param {object} result A control_radio result with radioPlaybackRequested.
     * @param {{isCurrent: () => boolean, stopVoice: () => void}} hooks
     */
    async start(result, { isCurrent = () => true, stopVoice }) {
      const handoff = ++epoch;
      const attemptId = `voice-local-radio-${handoff}`;
      attempt = attemptId;
      radioLayer?.setVoiceDucked?.(true);
      const outcome = await startPreparedRadioAfterPlaybackReady(result, {
        prepareRadio: () => radioLayer?.playForVoice?.({ attemptId }),
        stopVoice,
        cancelRadio: () => stopAttempt(attemptId),
        isCurrent: () => handoff === epoch && Boolean(isCurrent()),
      });
      if (attempt === attemptId) attempt = null;
      return outcome;
    },
  };
}

/** The last prepared Radio playback among a turn's action results. */
export function pendingRadioPlayback(executed = []) {
  return (
    executed
      .map((entry) => entry.result)
      .filter((result) => result?.ok && result.radioPlaybackRequested)
      .at(-1) || null
  );
}
