import { t } from '../i18n/index.js';
import {
  silenceRadioForVoice,
  startPreparedRadioAfterPlaybackReady,
} from './realtimeProtocol.js';

/** Own Radio speaker handoff, reservations and playback observers. */
export class RealtimeRadio {
  constructor({
    readRadioLayer,
    readDataManager,
    readChannel,
    readUserTurnPending,
    readSessionId,
    operations,
  }) {
    Object.assign(
      this,
      {
        readRadioLayer,
        readDataManager,
        readChannel,
        readUserTurnPending,
        readSessionId,
      },
      operations,
    );
    this.radioVoiceDucked = false;
    this.pendingRadioPlaybackResult = null;
    this.radioHandoffEpoch = 0;
    this.radioHandoffCancellation = null;
    this.activeRadioToolControllers = new Map();
    this.radioHandoffInFlight = false;
    this.radioHandoffAttemptId = null;
    this.radioHandoffInFlightResult = null;
    this.radioVisibilityOffReservation = 0;
    this.radioVisibilityOffPending = false;
    this.radioToolHandoffReservations = new Map();
    this.radioHandoffDeferredByReservation = false;
    this.radioControlUnsubscribe = null;
    this.radioVisibilityRequestUnsubscribe = null;
    this.radioVisibilityUnsubscribe = null;
  }
  get radioLayer() {
    return this.readRadioLayer();
  }
  get dataManager() {
    return this.readDataManager();
  }
  get dc() {
    return this.readChannel();
  }
  get userTurnPending() {
    return this.readUserTurnPending();
  }
  get sessionId() {
    return this.readSessionId();
  }
  observe() {
    this.radioControlUnsubscribe =
      this.radioLayer?.subscribePlaybackControls?.((control) => {
        const event =
          typeof control === 'string'
            ? { action: control, origin: 'user' }
            : control || {};
        if (
          event.origin === 'user' &&
          (event.action === 'pause' || event.action === 'stop')
        ) {
          this.cancelRadioHandoff();
        } else if (
          event.origin === 'user' &&
          event.action === 'play' &&
          this.isActive()
        ) {
          // Explicit user playback has already reached `playing` under the voice
          // hard mute. Hand the speaker to Radio without tearing its stream down.
          this.stop({ preserveRadioPlayback: true });
        }
      }) || null;
    this.radioVisibilityRequestUnsubscribe =
      this.dataManager?.subscribeVisibilityRequests?.((change) => {
        if (
          change?.layerId === 'radio' &&
          change.enabled === false &&
          change.origin === 'user'
        ) {
          this.reserveRadioVisibilityOff();
        }
      }) || null;
  }

  /** Pause Radio for explicit voice ownership; never resumes it automatically. */
  pauseRadioForVoice() {
    return silenceRadioForVoice({
      duckRadio: () => this.setRadioVoiceDucking(true),
      pauseRadio: () => this.radioLayer?.pause?.({ origin: 'voice-duck' }),
    });
  }

  setRadioVoiceDucking(ducked) {
    const next = Boolean(ducked);
    if (next === this.radioVoiceDucked) return;
    this.radioVoiceDucked = next;
    this.radioLayer?.setVoiceDucked?.(next);
  }

  /**
   * Freeze a prepared Radio handoff while a direct user OFF request settles.
   * The reservation stops unsafe underlying work immediately, but the handoff
   * epoch is committed only if the manager's authoritative final state is OFF.
   */
  reserveRadioVisibilityOff() {
    const reservation = ++this.radioVisibilityOffReservation;
    this.radioVisibilityOffPending = true;
    this.freezeRadioHandoffForReservation({ abortActiveTools: true });
    // The manager publishes the request synchronously before appending it to
    // the per-layer queue. Defer one microtask so waitForLayerSettled observes
    // this request as well as any earlier lifecycle work.
    void Promise.resolve()
      .then(() => this.dataManager?.waitForLayerSettled?.('radio'))
      .then(() => {
        if (reservation !== this.radioVisibilityOffReservation) return;
        this.radioVisibilityOffPending = false;
        if (this.dataManager?.isEnabled?.('radio') === false) {
          this.radioHandoffDeferredByReservation = false;
          this.cancelRadioHandoff({ abortRadioSiblings: true });
          return;
        }
        this.resumeDeferredRadioHandoffIfUnreserved();
      });
  }

  /** Whether any stronger Radio action is still awaiting semantic authority. */
  isRadioHandoffReserved() {
    return (
      this.radioVisibilityOffPending ||
      this.radioToolHandoffReservations.size > 0
    );
  }

  /** Freeze active, prepared, and preflight Radio work without committing. */
  freezeRadioHandoffForReservation({
    abortScope = 'all',
    abortActiveTools = false,
  } = {}) {
    if (abortActiveTools) this.abortRadioSiblingTools({ scope: abortScope });
    if (this.radioHandoffInFlight) {
      if (this.radioHandoffInFlightResult && !this.pendingRadioPlaybackResult) {
        this.pendingRadioPlaybackResult = this.radioHandoffInFlightResult;
      }
      this.radioHandoffDeferredByReservation = Boolean(
        this.pendingRadioPlaybackResult,
      );
      const attemptId = this.radioHandoffAttemptId;
      this.radioHandoffInFlight = false;
      this.radioHandoffAttemptId = null;
      this.radioLayer?.stopPlayback?.({ origin: 'voice-cleanup', attemptId });
    }
  }

  /** Reserve a dedicated/generic stronger Radio tool until its result settles. */
  reserveRadioToolHandoff({ abortScope = 'all' } = {}) {
    const token = Symbol('radio-tool-handoff-reservation');
    this.radioToolHandoffReservations.set(token, { abortScope });
    this.freezeRadioHandoffForReservation({ abortScope });
    return token;
  }

  /** Commit or release one stronger Radio tool's provisional reservation. */
  settleRadioToolHandoffReservation(
    token,
    { commit = false, responseId = null } = {},
  ) {
    const reservation = this.radioToolHandoffReservations.get(token);
    if (!reservation) return;
    this.radioToolHandoffReservations.delete(token);
    if (commit) {
      this.radioHandoffDeferredByReservation = false;
      this.abortRadioSiblingTools({ scope: reservation.abortScope });
      this.cancelRadioHandoff({ responseId });
      return;
    }
    this.resumeDeferredRadioHandoffIfUnreserved();
  }

  /** Resume a prepared handoff only after every provisional owner releases it. */
  resumeDeferredRadioHandoffIfUnreserved() {
    if (
      this.isRadioHandoffReserved() ||
      !this.radioHandoffDeferredByReservation
    )
      return;
    this.radioHandoffDeferredByReservation = false;
    void this.startPendingRadioHandoff();
  }

  /** Start one prepared handoff unless a direct user OFF currently owns it. */
  async startPendingRadioHandoff() {
    if (
      !this.pendingRadioPlaybackResult ||
      this.isRadioHandoffReserved() ||
      this.radioHandoffInFlight
    )
      return;
    const pendingResult = this.pendingRadioPlaybackResult;
    this.pendingRadioPlaybackResult = null;
    const handoffEpoch = ++this.radioHandoffEpoch;
    const handoffAttemptId = `voice-radio-${this.sessionId}-${handoffEpoch}`;
    const handoffChannel = this.dc;
    this.radioHandoffInFlight = true;
    this.radioHandoffAttemptId = handoffAttemptId;
    this.radioHandoffInFlightResult = pendingResult;
    // Reassert the hard mute before asking the browser to start the stream.
    // Radio remains inaudible through buffering and confirmed `playing`.
    this.radioLayer?.setVoiceDucked?.(true);
    const radioHandoff = await startPreparedRadioAfterPlaybackReady(
      pendingResult,
      {
        prepareRadio: () =>
          this.radioLayer?.playForVoice?.({ attemptId: handoffAttemptId }),
        stopVoice: () => this.stop({ preserveRadioPlayback: true }),
        cancelRadio: () =>
          this.radioLayer?.stopPlayback?.({
            origin: 'voice-cleanup',
            attemptId: handoffAttemptId,
          }),
        isCurrent: () =>
          this.radioHandoffInFlight &&
          !this.isRadioHandoffReserved() &&
          handoffEpoch === this.radioHandoffEpoch &&
          !this.userTurnPending &&
          this.dc === handoffChannel &&
          handoffChannel?.readyState === 'open',
      },
    );
    const stillCurrent = handoffEpoch === this.radioHandoffEpoch;
    if (this.radioHandoffAttemptId === handoffAttemptId) {
      this.radioHandoffInFlight = false;
      this.radioHandoffAttemptId = null;
      if (this.radioHandoffInFlightResult === pendingResult) {
        this.radioHandoffInFlightResult = null;
      }
    }
    this.debugLog('tool.radio_handoff', { result: radioHandoff.result });
    if (radioHandoff.result?.ok || radioHandoff.cancelled || !stillCurrent)
      return;
    if (this.dc?.readyState === 'open' && !this.userTurnPending) {
      this.setStatus('listening', t('setup.voice.detail.radioDidNotStart'));
      this.queueResponseCreate(
        'Say exactly one short correction: “The Radio station could not start. Voice is still on.”',
      );
    }
  }

  /** Invalidate delayed Radio work inside the requested authority scope. */
  abortRadioSiblingTools({ responseId = null, scope = 'all' } = {}) {
    for (const [controller, metadata] of this.activeRadioToolControllers) {
      if (responseId && metadata.responseId !== responseId) continue;
      if (scope === 'playback' && metadata.authorityDomain !== 'playback')
        continue;
      controller.abort();
      this.activeRadioToolControllers.delete(controller);
    }
  }

  /** Invalidate delayed Radio work and stop only a preflight owned by voice. */
  cancelRadioHandoff({
    abortTools = false,
    responseId = null,
    abortRadioSiblings = false,
  } = {}) {
    this.radioHandoffEpoch++;
    this.radioHandoffCancellation = {
      epoch: this.radioHandoffEpoch,
      responseId: responseId || null,
    };
    if (abortTools) {
      this.abortTools();
    } else if (abortRadioSiblings) {
      this.abortRadioSiblingTools();
    }
    this.pendingRadioPlaybackResult = null;
    this.radioHandoffInFlightResult = null;
    this.radioToolHandoffReservations.clear();
    this.radioHandoffDeferredByReservation = false;
    const shouldStopPlayback = this.radioHandoffInFlight;
    const attemptId = this.radioHandoffAttemptId;
    // Release ownership before Stop synchronously notifies playback observers;
    // the resulting callback is then idempotent instead of re-entering Stop.
    this.radioHandoffInFlight = false;
    this.radioHandoffAttemptId = null;
    if (shouldStopPlayback) {
      this.radioLayer?.stopPlayback?.({ origin: 'voice-cleanup', attemptId });
    }
  }

  invalidateHandoff() {
    this.radioHandoffEpoch++;
  }
  stopHandoff({ preserveRadioPlayback = false } = {}) {
    const radioHandoffAttemptId = this.radioHandoffAttemptId;
    if (this.radioHandoffInFlight && !preserveRadioPlayback) {
      this.radioLayer?.stopPlayback?.({
        origin: 'voice-cleanup',
        attemptId: radioHandoffAttemptId,
      });
    }
    this.radioHandoffInFlight = false;
    this.radioHandoffAttemptId = null;
    this.radioHandoffInFlightResult = null;
    this.radioVisibilityOffReservation++;
    this.radioVisibilityOffPending = false;
    this.radioToolHandoffReservations.clear();
    this.radioHandoffDeferredByReservation = false;
  }

  clearPendingPlayback() {
    this.pendingRadioPlaybackResult = null;
  }

  detachObservers() {
    if (this.radioControlUnsubscribe) {
      this.radioControlUnsubscribe();
      this.radioControlUnsubscribe = null;
    }
    if (this.radioVisibilityRequestUnsubscribe) {
      this.radioVisibilityRequestUnsubscribe();
      this.radioVisibilityRequestUnsubscribe = null;
    }
    if (this.radioVisibilityUnsubscribe) {
      this.radioVisibilityUnsubscribe();
      this.radioVisibilityUnsubscribe = null;
    }
  }

  registerTool(controller, metadata) {
    this.activeRadioToolControllers.set(controller, metadata);
  }
  releaseTool(controller) {
    this.activeRadioToolControllers.delete(controller);
  }
  clearTools() {
    this.activeRadioToolControllers.clear();
  }
  setPendingPlayback(result) {
    this.pendingRadioPlaybackResult = result;
  }
  deferHandoff() {
    this.radioHandoffDeferredByReservation = true;
  }
}
