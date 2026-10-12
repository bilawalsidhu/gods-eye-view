import {
  readStoredVoiceTier,
  readStoredVoiceLimits,
  writeStoredVoiceTier,
  writeStoredVoiceLimits,
} from './realtimePreferences.js';
import { readStoredCloudVoiceAuthMode } from './cloudVoiceAuth.js';
import {
  createVoiceCostTracker,
  resolveVoiceModel,
  formatCostUsd,
  estimateTranscriptionCostUsd,
} from './voiceCost.js';
import { t } from '../i18n/index.js';

/** Own next-session preferences and the immutable-model session cost meter. */
export class RealtimeCost {
  constructor({ readUi, readStatus, operations }) {
    Object.assign(this, { readUi, readStatus }, operations);
    this.voiceTier = readStoredVoiceTier();
    this.voiceLimits = readStoredVoiceLimits();
    this.cloudVoiceAuth = readStoredCloudVoiceAuthMode();
    this.sessionCloudVoiceAuth = null;
    this.oauthUsage = { responses: 0, input: 0, output: 0, captions: 0 };
    this.transcribeModel = null;
    this.costTracker = createVoiceCostTracker({
      tier: this.voiceTier,
      limits: this.voiceLimits,
    });
    this.costCapStopped = false;
  }
  get ui() {
    return this.readUi();
  }
  get status() {
    return this.readStatus();
  }
  /**
   * Paint the tier toggle + running cost readout.
   *
   * Two DIFFERENT sources on purpose: the toggle shows the PENDING preference
   * (`this.voiceTier` — what the next session will use), while the cost readout
   * shows the LIVE session meter (`this.costTracker` — bound to the model this
   * session actually connected with). During a session those two can legitimately
   * disagree, which is exactly what "applies next session" means.
   */
  syncCostUi() {
    const state = this.costTracker.state();
    const pendingTier = resolveVoiceModel(this.voiceTier).tier;
    const isMini = pendingTier === 'mini';
    if (this.ui?.tierButton) {
      this.ui.tierButton.textContent = isMini ? 'MINI' : 'STD';
      this.ui.tierButton.setAttribute(
        'aria-pressed',
        isMini ? 'true' : 'false',
      );
      const pendingId = resolveVoiceModel(pendingTier).id;
      this.ui.tierButton.title =
        this.isActive() && state.modelId !== pendingId
          ? t('voice.cost.tierLive', {
              next: pendingId,
              current: state.modelId,
            })
          : t('voice.cost.tierSwitch', {
              model: pendingId,
              other: isMini ? 'standard' : 'mini',
            });
    }
    if (this.ui?.costValue) {
      const liveAuth = this.sessionCloudVoiceAuth || this.cloudVoiceAuth;
      if (liveAuth === 'oauth') {
        const { responses, input, output, captions } = this.oauthUsage;
        this.ui.costValue.hidden = false;
        this.ui.costValue.textContent = t('voice.cost.unknown');
        this.ui.costValue.dataset.level = 'unknown';
        this.ui.costValue.title =
          `${t('voice.cost.oauthSession', { responses, input, output, captions })} ` +
          t('voice.cost.oauthUnavailable') +
          (state.incomplete ? ` ${t('voice.cost.oauthIncomplete')}` : '');
        return;
      }
      this.ui.costValue.hidden = false;
      this.ui.costValue.textContent = state.display;
      this.ui.costValue.dataset.level = state.level;
      // The tracker's `note` prose is translated here at the presentation
      // edge — voiceCost.js itself stays import-free for the server build.
      this.ui.costValue.title =
        `${t('voice.cost.sessionCost', {
          model: state.modelId,
          responses: state.responses,
        })} ` +
        t('voice.cost.thresholds', {
          warn: formatCostUsd(state.warnUsd),
          cap: formatCostUsd(state.capUsd),
        }) +
        (state.incomplete ? ` ${t('voice.cost.incompleteNote')}` : '');
    }
  }

  /**
   * Flip STANDARD <-> MINI. Takes effect on the NEXT session: the model is
   * fixed when the ephemeral token is minted, so a live session is deliberately
   * left alone rather than reconnected mid-sentence.
   */
  toggleVoiceTier() {
    // Reads the PERSISTED PREFERENCE, never the tracker. The tracker is bound
    // to the live session's model and is immutable, so deriving from it made
    // every click during a standard session select 'mini' again instead of
    // alternating.
    const current = resolveVoiceModel(this.voiceTier).tier;
    return this.setVoiceTier(current === 'mini' ? 'standard' : 'mini');
  }

  /**
   * Set the voice model tier and persist it as the NEXT-session preference.
   *
   * INVARIANT — the cost tracker's lifetime is the SESSION's lifetime, and its
   * model binding is immutable from start() to stop(). Rebuilding it here would
   * erase accrued spend, re-price later usage against a model the session is
   * not running on, and let repeated toggles reset the meter past the cap
   * indefinitely. So unless the session is FULLY SETTLED (see
   * isVoiceSessionSettled — no session AND no transport, which excludes the
   * error state that still holds a live channel) this writes the preference
   * ONLY. Once settled there is no session meter to protect, so the provisional
   * tracker is refreshed to preview the newly selected model.
   */
  setVoiceTier(tier) {
    this.voiceTier = writeStoredVoiceTier(tier);
    if (this.isVoiceSessionSettled()) {
      this.costTracker = createVoiceCostTracker({
        tier: this.voiceTier,
        limits: this.voiceLimits,
      });
    }
    this.syncCostUi();
    if (this.isActive() && this.ui?.detail) {
      this.setStatus(
        this.status,
        t('voice.cost.tierApplies', { tier: this.voiceTier.toUpperCase() }),
      );
    }
    return this.voiceTier;
  }

  /**
   * Update the spend thresholds ({warnUsd, capUsd}) and persist them.
   * Exposed for the settings surface and for tests; no new panel.
   *
   * Like the tier, this does not rebuild a LIVE session's tracker — that would
   * discard accrued spend. New limits arm at the next session start.
   */
  setVoiceCostLimits(limits) {
    this.voiceLimits = writeStoredVoiceLimits(limits);
    if (this.isVoiceSessionSettled()) {
      this.costTracker = createVoiceCostTracker({
        tier: this.voiceTier,
        limits: this.voiceLimits,
      });
    }
    this.syncCostUi();
    return this.voiceLimits;
  }

  /**
   * Fold one response's token usage into the session cost, then act on the
   * thresholds: a soft warning (visual + one console line) and a hard cap that
   * ends the session through the normal stop path.
   */
  recordUsage(usage) {
    if (!usage) return null;
    if (this.sessionCloudVoiceAuth === 'oauth') {
      const count = (value) =>
        Number.isFinite(value) && value > 0 ? value : 0;
      this.oauthUsage.responses += 1;
      this.oauthUsage.input += count(usage.input_tokens);
      this.oauthUsage.output += count(usage.output_tokens);
      this.syncCostUi();
      return { ...this.oauthUsage, costKnown: false };
    }
    return this.applyCost(this.costTracker.record(usage));
  }

  /**
   * Meter one input transcription (voice-card captions). It is billed apart
   * from responses, so it is priced with the transcription model the server
   * reported and folded into the same total, warning and cap.
   */
  recordTranscriptionUsage(usage) {
    if (!usage) return null;
    // An OAuth session has no API-dollar meter, so captions are counted
    // rather than priced into the API-key warning and cap.
    if (this.sessionCloudVoiceAuth === 'oauth') {
      this.oauthUsage.captions += 1;
      this.syncCostUi();
      return { ...this.oauthUsage, costKnown: false };
    }
    return this.applyCost(
      this.costTracker.recordUsd(
        estimateTranscriptionCostUsd(usage, this.transcribeModel),
      ),
    );
  }

  bindTranscriptionModel(model) {
    this.transcribeModel = model && model !== 'off' ? model : null;
  }

  applyCost(state) {
    this.syncCostUi();
    if (state.warnCrossed) {
      // Exactly one line — the latch in the tracker guarantees it.
      console.warn(
        `[GEV voice] session cost ${state.display} crossed the ${formatCostUsd(
          state.warnUsd,
        )} warning threshold (model ${state.modelId}); hard cap ${formatCostUsd(state.capUsd)}.`,
      );
    }
    // NOTE: field names avoid /token|secret|key/ — the debug-log sanitizer
    // redacts values under any such key, which would blank the usage numbers.
    this.debugLog('voice.cost', {
      costUsd: Number(state.totalUsd.toFixed(6)),
      tier: state.tier,
      modelId: state.modelId,
      responses: state.responses,
      level: state.level,
    });
    if (state.capCrossed) this.handleCostCap(state);
    return state;
  }

  /**
   * Hard cap reached — end the session gracefully. Uses the ordinary stop path
   * (data channel closed, peer connection closed, mic tracks stopped) so the
   * mic is genuinely released, then overrides the status line with the reason.
   * `preserveStatus` keeps stop() from writing its own "Voice off" over it.
   */
  handleCostCap(state) {
    if (this.costCapStopped) return;
    this.costCapStopped = true;
    console.warn(
      `[GEV voice] session cost ${state.display} reached the ${formatCostUsd(
        state.capUsd,
      )} cap — ending the voice session.`,
    );
    this.debugLog('voice.cost.cap', {
      costUsd: Number(state.totalUsd.toFixed(6)),
      capUsd: state.capUsd,
      tier: state.tier,
      modelId: state.modelId,
    });
    try {
      this.stop({ preserveStatus: true });
    } finally {
      this.setStatus(
        'idle',
        t('voice.cost.capEnded', { display: state.display }),
      );
      this.syncCostUi();
    }
  }

  prepareSession() {
    this.voiceTier = readStoredVoiceTier();
    this.voiceLimits = readStoredVoiceLimits();
    this.cloudVoiceAuth = readStoredCloudVoiceAuthMode();
    this.sessionCloudVoiceAuth = this.cloudVoiceAuth;
    this.oauthUsage = { responses: 0, input: 0, output: 0, captions: 0 };
    this.costCapStopped = false;
    // Provisional meter (tier-priced) so the readout shows $0.00 while
    // connecting. It is REPLACED below with one bound to the model the server
    // actually served, before any usage can arrive.
    this.costTracker = createVoiceCostTracker({
      tier: this.voiceTier,
      limits: this.voiceLimits,
    });
  }
  bindServedModel(model) {
    this.costTracker = createVoiceCostTracker({
      modelId: model || resolveVoiceModel(this.voiceTier).id,
      limits: this.voiceLimits,
    });
    return this.costTracker.state();
  }
}
