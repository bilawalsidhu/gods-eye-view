export const LOADING_REVEAL_DELAY_MS = 160;
export const LOADING_TERMINAL_DWELL_MS = 2200;
export const LOADING_FAILURE_DWELL_MS = 5000;
export const LOADING_LONG_THRESHOLD_MS = 30000;
export const TRAFFIC_SYNC_CONFIRM_MS = 1500;

/**
 * Coerce a reported count into a non-negative finite number.
 * @param {*} value - Raw stats count; may be undefined, a string, or NaN.
 * @returns {number} Sanitized count, 0 whenever the input is not usable.
 */
function finiteCount(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

/**
 * Normalize one manager layer into a small loading-feedback record.
 * @param {object} [layer] - Manager layer record (`id`, `name`, `enabled`,
 *   `lifecycleState`, `stats`) as returned by DataLayerManager.getAll();
 *   read-only, never mutated.
 * @returns {object} Flattened row: `id`, `label` (display name),
 *   `lifecycleState` (falling back to `enabled`/`disabled` when unset),
 *   `loading`, `disabling`, `refresh` (a re-poll of an already-enabled layer
 *   with accepted data, as opposed to a first cold load), `count`,
 *   `accepted`, `error`, `unavailable`, `keyRequired`, and `degraded`.
 */
export function normalizeLayerLoading(layer = {}) {
  const stats = layer.stats || {};
  const lifecycleState = String(layer.lifecycleState || (layer.enabled ? 'enabled' : 'disabled'));
  const status = String(stats.status || '').toLowerCase();
  const disabling = lifecycleState === 'disabling';
  const loading = lifecycleState === 'enabling' || disabling || stats.loading === true || stats.refreshing === true;
  const count = finiteCount(stats.count);
  const error = stats.error || stats.lastError || stats.managerRefreshError || null;
  const unavailable = stats.unavailable === true
    || stats.available === false
    || ['unavailable', 'offline', 'down', 'error'].includes(status);
  const keyRequired = stats.keyRequired === true || stats.missingKey === true;
  const degraded = stats.degraded === true || Boolean(error);
  const accepted = Boolean(stats.lastUpdate) || count > 0;
  return {
    id: String(layer.id || ''),
    label: String(layer.name || layer.id || 'Layer'),
    loading,
    disabling,
    refresh: loading && layer.enabled && (stats.refreshing === true || accepted),
    lifecycleState,
    count,
    accepted,
    error,
    unavailable,
    keyRequired,
    degraded,
  };
}

/**
 * Derive a batch terminal outcome from the participant rows' own stats.
 * @param {object} summary - Aggregate summary whose `records` are
 *   normalizeLayerLoading() rows.
 * @param {string[]} participantIds - Layer ids participating in the epoch.
 * @returns {string|null} 'error' when any participant reports an error or an
 *   unavailable feed; null while none is degraded. KEY REQUIRED rows are
 *   excluded — they own their own copy and are not a failed batch.
 */
function terminalFromParticipantStats(summary, participantIds) {
  if (!participantIds?.length) return null;
  const participants = new Set(participantIds);
  return summary.records.some((record) => participants.has(record.id)
    // A deliberately unconfigured optional provider is a truthful terminal
    // state for that row, not a failed multi-layer mission. The layer keeps
    // owning its KEY REQUIRED copy; explicit lifecycle failure events still
    // merge in below and retain error priority.
    && !record.keyRequired
    && (record.error || record.unavailable))
    ? 'error'
    : null;
}

/**
 * Aggregate all manager layers without changing their lifecycle authority.
 * @param {object[]} [layers] - Manager layer records as returned by
 *   DataLayerManager.getAll().
 * @returns {object} Summary with `records` (normalized rows), `active`
 *   (loading rows only), `activeIds`, `disabling` (true only while every
 *   active row is mid-disable), and `refresh` (true while every active row
 *   is a re-poll rather than a first load).
 */
export function aggregateLayerLoading(layers = []) {
  const records = layers.map(normalizeLayerLoading);
  const active = records.filter((record) => record.loading);
  const disabling = active.length > 0 && active.every((record) => record.disabling);
  return {
    records,
    active,
    activeIds: active.map((record) => record.id),
    disabling,
    refresh: !disabling && active.length > 0 && active.every((record) => record.refresh),
  };
}

/**
 * Seed the idle global loading state the reducer folds forward from.
 * @returns {object} Idle state: phase 'idle' with the chip hidden, zeroed
 *   timestamps, an empty roster, and no batch outcome, terminal, or operation.
 */
export function createLoadingFeedbackState() {
  return {
    phase: 'idle',
    visible: false,
    startedAt: 0,
    showAt: 0,
    hideAt: 0,
    activeIds: [],
    batchOutcome: null,
    terminal: null,
    operation: null,
  };
}

/**
 * Create a top-center status notice, optionally persistent until explicitly cleared.
 * @param {string} message - Notice copy; a blank message yields null.
 * @param {number} _nowMs - Creation timestamp, deliberately unused: a finite
 *   notice starts its dwell only at first presentation.
 * @param {object} [root0] - Presentation options.
 * @param {string} [root0.state='error'] - Severity/state key driving chip
 *   styling (e.g. 'error', 'acquiring').
 * @param {string} [root0.detail=''] - Secondary line beneath the label.
 * @param {boolean} [root0.persistent=false] - When true the notice never
 *   expires and must be replaced or cleared explicitly.
 * @returns {object|null} Normalized notice, or null for a blank message.
 */
export function createGlobalStatusNotice(message, _nowMs = 0, {
  state = 'error',
  detail = '',
  persistent = false,
} = {}) {
  const label = String(message || '').trim();
  if (!label) return null;
  return {
    state,
    label,
    detail: String(detail || '').trim(),
    persistent: Boolean(persistent),
    dwellMs: persistent ? null : LOADING_FAILURE_DWELL_MS,
    // A finite notice starts its dwell only when it first wins presentation.
    // Otherwise a higher-priority manager failure could consume the whole
    // deadline while this notice remained queued and invisible.
    hideAt: null,
  };
}

/**
 * Present a top-center status notice until its deadline or explicit clearing.
 * @param {object|null} notice - Notice from createGlobalStatusNotice();
 *   mutated once to stamp a finite notice's `hideAt` on its first
 *   presentation.
 * @param {number} nowMs - Current performance.now() sample.
 * @returns {object|null} Presentation `{ state, label, detail }`, or null
 *   when the notice is blank or has outlived its dwell.
 */
export function presentGlobalStatusNotice(notice, nowMs = 0) {
  const now = Number.isFinite(nowMs) ? nowMs : 0;
  if (!notice?.label) return null;
  if (!notice.persistent && !Number.isFinite(notice.hideAt)) {
    notice.hideAt = now + (Number.isFinite(notice.dwellMs)
      ? notice.dwellMs
      : LOADING_FAILURE_DWELL_MS);
  }
  if (Number.isFinite(notice.hideAt) && now >= notice.hideAt) return null;
  return {
    state: notice.state || 'error',
    label: notice.label,
    detail: notice.detail || '',
  };
}

/**
 * Whether deferred notice work still owns the current presentation epoch.
 * @param {number} expectedGeneration - Notice generation captured when the
 *   presentation was deferred.
 * @param {number} currentGeneration - The controller's current notice
 *   generation, bumped by every newer acquisition.
 * @param {boolean} [disposed=false] - Whether the controller has been torn
 *   down.
 * @returns {boolean} True only while the controller is live and the captured
 *   generation still matches; a stale epoch never surfaces over a newer one.
 */
export function canPresentDeferredStatusNotice(expectedGeneration, currentGeneration, disposed = false) {
  return !disposed
    && Number.isSafeInteger(expectedGeneration)
    && expectedGeneration === currentGeneration;
}

/**
 * Present the shared status surface without allowing a persistent notice to
 * hide a terminal manager failure. Failure dwell starts when the manager
 * reports it, so it must remain the highest-priority presentation while live.
 * @param {object|null} notice - Universal status notice, if any.
 * @param {object} loadingState - Reduced loading state from
 *   reduceLoadingFeedback().
 * @param {object} summary - Aggregate summary supplying loading-phase copy.
 * @param {number} nowMs - Current performance.now() sample.
 * @returns {object|null} Winning presentation `{ state, label, detail }`:
 *   a manager error outranks the notice, then the notice, then loading.
 */
export function presentGlobalLoadingStatus(notice, loadingState, summary, nowMs = 0) {
  const loadingPresentation = presentLoadingFeedback(loadingState, summary, nowMs);
  if (loadingPresentation?.state === 'error') return loadingPresentation;
  return presentGlobalStatusNotice(notice, nowMs) || loadingPresentation;
}

/**
 * Create the sampled Street Traffic chip state.
 * @returns {object} Idle chip state: hidden and not busy, with no
 *   confirmation deadline and empty label/progress slots.
 */
export function createTrafficSyncFeedbackState() {
  return {
    busy: false,
    visible: false,
    confirmationUntil: 0,
    label: '',
    progressText: '',
  };
}

/**
 * Reduce one sampled Street Traffic status without extending completion on
 * every animation-loop poll. Coverage describes accepted data, not work.
 * @param {object|null} previous - Previous chip state; null seeds the idle
 *   state.
 * @param {object} [root0] - Traffic layer sample.
 * @param {boolean} [root0.enabled=false] - Whether the layer is on; a
 *   disabled sample always resets to the idle state.
 * @param {object} [root0.stats] - Layer stats (`loading`, `worldJumping`,
 *   `phaseProgressPct`, `phaseLabel`/`loadingLabel`, `prewarmQueueDepth`).
 * @param {boolean} [root0.forceShow=false] - Arm the confirmation flash on a
 *   settle even when the previous sample was not busy.
 * @param {number} [nowMs=0] - Current performance.now() sample.
 * @returns {object} Next chip state: busy work with a label and progress
 *   slot, a bounded post-settle confirmation flash, or the idle state.
 */
export function reduceTrafficSyncFeedback(previous, {
  enabled = false,
  stats = {},
  forceShow = false,
} = {}, nowMs = 0) {
  const state = previous || createTrafficSyncFeedbackState();
  const now = Number.isFinite(nowMs) ? nowMs : 0;
  if (!enabled) return createTrafficSyncFeedbackState();

  const hasProgress = Number.isFinite(stats.phaseProgressPct);
  const progressPct = hasProgress
    ? Math.max(0, Math.min(100, Math.round(stats.phaseProgressPct)))
    : (stats.loading ? 1 : 100);
  const busy = stats.loading === true
    || stats.worldJumping === true
    || (hasProgress && (progressPct < 100 || (stats.prewarmQueueDepth ?? 0) > 0));
  const label = String(stats.phaseLabel || stats.loadingLabel || '').trim();

  if (busy) {
    return {
      busy: true,
      visible: true,
      confirmationUntil: 0,
      // Neutral default: the layer always supplies its own LIVE/SIMULATED
      // label, and a fallback string must never claim a live feed on a
      // keyless build.
      label: label || 'syncing road network',
      progressText: hasProgress ? `${progressPct}%` : '...',
    };
  }

  const existingConfirmation = state.confirmationUntil > now
    ? state.confirmationUntil
    : 0;
  const confirmationUntil = existingConfirmation || (state.busy || forceShow
    ? now + TRAFFIC_SYNC_CONFIRM_MS
    : 0);
  const visible = confirmationUntil > now && progressPct >= 100 && Boolean(label);
  return {
    busy: false,
    visible,
    confirmationUntil: visible ? confirmationUntil : 0,
    label: visible ? label : '',
    // The settled flash carries NO progress number. A settled chip is 100% by
    // definition — the value never varied — and printing it beside a label
    // that already ends in a real measurement produced the self-contradicting
    // "LIVE · TomTom flow · 0% cov  100%". Coverage is the honest number, so
    // it is the only one left standing; the progress slot belongs to work in
    // flight.
    progressText: '',
  };
}

/**
 * Map one manager change event onto a batch terminal outcome.
 * @param {object|null} event - Manager change event (`type`, `layerId`, plus
 *   an optional `error` or `cancelled` flag).
 * @returns {string|null} 'error' for failures, 'cancelled' for
 *   cancellations, 'complete' for visibility/refresh events, null when the
 *   event is unclassified (e.g. a mid-load transition).
 */
function terminalFromEvent(event) {
  const type = String(event?.type || '');
  if (type === 'visibility-failed' || type === 'refresh-failed' || event?.error) return 'error';
  if (type === 'visibility-cancelled' || event?.cancelled) return 'cancelled';
  if (type === 'visibility' || type === 'refresh') return 'complete';
  return null;
}

/**
 * Keep the worst terminal outcome of a batch, worst first.
 * @param {string|null} current - Outcome accumulated so far.
 * @param {string|null} next - Incoming candidate outcome.
 * @returns {string|null} The more severe of the two (error outranks
 *   cancelled, which outranks complete), or `current` when `next` is empty.
 */
function mergeTerminalOutcome(current, next) {
  const severity = { complete: 1, cancelled: 2, error: 3 };
  if (!next) return current || null;
  if (!current || severity[next] > severity[current]) return next;
  return current;
}

/**
 * Reduce a sampled manager summary into delayed, non-flashing UI state.
 * @param {object|null} previous - Previous state; null seeds the idle state.
 * @param {object} summary - Aggregate summary from aggregateLayerLoading().
 * @param {number} nowMs - Current performance.now() sample.
 * @param {object|null} [event=null] - Manager change event, folded into the
 *   batch outcome only when its `layerId` participates in this epoch.
 * @returns {object} Next state: a loading epoch carrying its roster and
 *   batch outcome, a bounded terminal dwell, or a reset idle state when work
 *   finished before it was ever revealed.
 */
export function reduceLoadingFeedback(previous, summary, nowMs, event = null) {
  const state = previous || createLoadingFeedbackState();
  const now = Number.isFinite(nowMs) ? nowMs : 0;
  if (summary.active.length) {
    const beginning = state.phase !== 'loading';
    const startedAt = beginning ? now : state.startedAt;
    const priorParticipants = beginning ? [] : state.activeIds;
    const activeIds = [...new Set([...priorParticipants, ...summary.activeIds])];
    const eventLayerId = String(event?.layerId || '');
    const eventParticipates = eventLayerId && activeIds.includes(eventLayerId);
    const batchOutcome = mergeTerminalOutcome(
      mergeTerminalOutcome(
        beginning ? null : state.batchOutcome,
        terminalFromParticipantStats(summary, activeIds),
      ),
      eventParticipates ? terminalFromEvent(event) : null,
    );
    return {
      phase: 'loading',
      visible: !beginning && now >= state.showAt,
      startedAt,
      showAt: beginning ? now + LOADING_REVEAL_DELAY_MS : state.showAt,
      hideAt: 0,
      activeIds,
      batchOutcome,
      terminal: null,
      operation: summary.disabling ? 'disabling' : summary.refresh ? 'refresh' : 'loading',
    };
  }

  if (state.phase === 'loading') {
    const eventLayerId = String(event?.layerId || '');
    const eventParticipates = eventLayerId && state.activeIds.includes(eventLayerId);
    const terminal = mergeTerminalOutcome(
      mergeTerminalOutcome(
        state.batchOutcome,
        terminalFromParticipantStats(summary, state.activeIds),
      ),
      eventParticipates ? terminalFromEvent(event) : null,
    ) || 'complete';
    const wasVisible = state.visible || now >= state.showAt;
    if (!wasVisible && terminal === 'complete') return createLoadingFeedbackState();
    const dwell = terminal === 'error' ? LOADING_FAILURE_DWELL_MS : LOADING_TERMINAL_DWELL_MS;
    return {
      ...state,
      phase: 'terminal',
      visible: true,
      hideAt: now + dwell,
      batchOutcome: terminal,
      terminal,
    };
  }

  if (state.phase === 'terminal' && now < state.hideAt) return state;
  return createLoadingFeedbackState();
}

/**
 * Build the user-facing status copy for the current loading state.
 * @param {object} state - Reduced loading state.
 * @param {object} summary - Aggregate summary supplying the active roster
 *   for the loading-phase detail line.
 * @param {number} nowMs - Current performance.now() sample, driving the
 *   long-load threshold.
 * @returns {object|null} `{ state, label, detail }` for the top-center chip,
 *   or null while the state is not visible.
 */
export function presentLoadingFeedback(state, summary, nowMs) {
  if (!state?.visible) return null;
  if (state.phase === 'terminal') {
    const labels = { complete: 'LOAD COMPLETE', cancelled: 'LOAD CANCELLED', error: 'LOAD FAILED' };
    const label = state.operation === 'disabling' && state.terminal === 'complete'
      ? 'LIVE DATA OFF'
      : labels[state.terminal] || 'LOAD COMPLETE';
    return { state: state.terminal, label, detail: '' };
  }
  const active = summary.active;
  const elapsed = Math.max(0, nowMs - state.startedAt);
  const label = summary.disabling
    ? 'TURNING OFF LIVE DATA'
    : summary.refresh ? 'REFRESHING LIVE DATA' : 'LOADING LIVE DATA';
  const names = active.slice(0, 2).map((record) => record.label).join(' · ');
  const suffix = active.length > 2 ? ` +${active.length - 2}` : '';
  return {
    state: elapsed >= LOADING_LONG_THRESHOLD_MS
      ? 'long'
      : summary.disabling ? 'disabling' : summary.refresh ? 'refresh' : 'loading',
    label,
    detail: `${names}${suffix}`,
  };
}
