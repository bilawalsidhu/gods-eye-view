/**
 * Applies layer state to the running application: restores shared and stored
 * layer choices and persists changes to browser storage.
 */

import {
  LAYER_RESTORE_ORIGINS,
  LAYER_STATE_REGISTRY,
  LAYER_STATE_STORAGE_KEY,
  REGISTRY_BY_ID,
  SHARE_TRACKING_RESTORE_POLICIES,
  cloneLayerState,
  createDefaultLayerState,
  isExplicitLayerStateOrigin,
  layerOptionsForRestore,
  normalizeLayerState,
  optionSpecs,
  parseStoredLayerState,
  serializeStoredLayerState,
} from './layerState.js';

/** Re-check cadence while a shared subject waits for its feed row to arrive. */
const PENDING_TRACKING_POLL_MS = 1_000;

const TRACKING_OPTION_KEY_BY_LAYER = Object.freeze({
  flights: 'selectedFlightsTrackingId',
  military: 'selectedMilitaryTrackingId',
  satellites: 'selectedSatTrackingId',
});

function safeStorage() {
  try {
    return globalThis.localStorage || null;
  } catch {
    return null;
  }
}

function currentLayerOutcome(dataManager, layerId) {
  const state = dataManager.getLayerLifecycleState?.(layerId);
  return {
    settledEnabled: Boolean(state?.enabled),
    lifecycleState: state?.lifecycleState || 'missing',
    lifecycleUncertain: Boolean(state?.uncertain),
  };
}

/**
 * Owns durable user layer preferences independently from transient runtime
 * choreography, and coordinates passive post-registration restoration.
 */
export class LayerStateCoordinator {
  constructor(
    dataManager,
    shareLinkManager,
    {
      storage = safeStorage(),
      restoreGate = null,
      onDurableStateChange = null,
      onTrackingRestoreStatus = null,
      now = () => Date.now(),
      // Injectable so the pending-window behavior is deterministically testable
      // without sleeping out a 90 s expiry.
      setTimer = (fn, ms) => setTimeout(fn, ms),
      clearTimer = (handle) => clearTimeout(handle),
    } = {},
  ) {
    if (!dataManager?.registrationsFinalized) {
      throw new Error(
        'Layer state requires finalized data-layer registrations',
      );
    }
    this.dataManager = dataManager;
    this.shareLinkManager = shareLinkManager || null;
    this.storage = storage;
    this.restoreGate = restoreGate;
    this.onDurableStateChange = onDurableStateChange;
    this.onTrackingRestoreStatus = onTrackingRestoreStatus;
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this._durableState = createDefaultLayerState();
    this._source = 'defaults';
    this._destroyed = false;
    this._restoreControllers = new Map();
    this._shareCreatedAtMs = null;
    this._trackingRestoreController = null;
    this._trackingRestoreGeneration = 0;
    this._pendingTrackingTimer = null;
    this._pendingTrackingContext = null;
    this._unsubscribe = this.dataManager.subscribe((change) =>
      this._handleManagerChange(change),
    );
    this._unsubscribeVisibilityRequests =
      this.dataManager.subscribeVisibilityRequests((change) =>
        this._handleVisibilityRequest(change),
      );
    this.restorePromise = Promise.resolve([]);
    this.lastRestoreResults = [];
  }

  start({
    shareLayerState = null,
    allowLocalState = true,
    shareCreatedAtMs = null,
  } = {}) {
    if (this._destroyed)
      throw new Error('Layer-state coordinator is destroyed');
    let selected = shareLayerState
      ? normalizeLayerState(shareLayerState)
      : null;
    if (selected) {
      this._source = 'share';
      this._shareCreatedAtMs = Number.isFinite(shareCreatedAtMs)
        ? shareCreatedAtMs
        : null;
    } else if (allowLocalState) {
      let stored = null;
      try {
        stored = parseStoredLayerState(
          this.storage?.getItem?.(LAYER_STATE_STORAGE_KEY),
        );
      } catch {
        /* best effort */
      }
      if (stored) {
        selected = stored;
        this._source = 'local';
      }
    } else {
      // A valid historical camera/style share with no v2 layer payload keeps
      // the exact legacy default-layer behavior. It must not inherit an
      // unrelated recipient's saved local layer preferences.
      this._source = 'legacy-share';
    }
    this._durableState = selected || createDefaultLayerState();
    this.shareLinkManager?.setLayerStateProvider?.(() =>
      this.getDurableState(),
    );
    this.shareLinkManager?.onLayerStateChange?.();
    this._notifyDurableState();
    if (!selected) return this.restorePromise;
    this.restorePromise = this._restoreSelectedState(
      this._source === 'share'
        ? LAYER_RESTORE_ORIGINS.share
        : LAYER_RESTORE_ORIGINS.local,
    );
    return this.restorePromise;
  }

  get source() {
    return this._source;
  }

  getDurableState() {
    return cloneLayerState(this._durableState);
  }

  _notifyDurableState() {
    try {
      this.onDurableStateChange?.(this.getDurableState());
    } catch {
      /* UI sync is best effort */
    }
  }

  _handleVisibilityRequest(change) {
    if (!isExplicitLayerStateOrigin(change?.origin)) return;
    this._restoreControllers
      .get(change.layerId)
      ?.abort('superseded-by-explicit-visibility');
    if (SHARE_TRACKING_RESTORE_POLICIES[change.layerId]) {
      this._revokePendingTrackingWatch('superseded-by-explicit-visibility');
    }
  }

  /** Revoke every passive restore before explicit navigation can be reclaimed. */
  cancelPendingRestores(reason = 'superseded-by-explicit-navigation') {
    for (const controller of this._restoreControllers.values())
      controller.abort(reason);
    this._revokePendingTrackingWatch(reason);
  }

  /**
   * Revoke a pending shared Follow. Physical navigation may also clear only
   * the exact passive selection, without writing recipient preferences.
   */
  cancelPendingShareTracking(
    reason = 'superseded-by-explicit-navigation',
    { clearSelection = false } = {},
  ) {
    this._revokePendingTrackingWatch(reason);
    if (!clearSelection) return false;
    const selected = this._selectedShareTrackingTarget();
    return selected ? this._passivelyClearTrackingSelection(selected) : false;
  }

  _handleManagerChange(change) {
    if (!change || this._destroyed) return;
    // Parameter and visibility ownership are independent. A newer explicit
    // option request may replace passive share options, but it must not abort
    // the same layer's visibility lifecycle.
    if (change.type === 'params-requested') {
      if (
        isExplicitLayerStateOrigin(change.origin) &&
        SHARE_TRACKING_RESTORE_POLICIES[change.layerId]
      ) {
        this._revokePendingTrackingWatch('superseded-by-explicit-params');
      }
      return;
    }
    // A layer that goes away takes its latch with it, at ANY origin — a
    // programmatic disable or teardown never reaches the explicit-intent path
    // below, so revoke here before that early return.
    if (
      change.type === 'visibility' &&
      change.enabled === false &&
      SHARE_TRACKING_RESTORE_POLICIES[change.layerId]
    ) {
      this._revokePendingTrackingWatch('owner-layer-disabled');
    }
    if (!isExplicitLayerStateOrigin(change.origin)) return;
    if (change.type === 'visibility') {
      this._restoreControllers
        .get(change.layerId)
        ?.abort('superseded-by-explicit-visibility');
      if (SHARE_TRACKING_RESTORE_POLICIES[change.layerId]) {
        this._revokePendingTrackingWatch('superseded-by-explicit-visibility');
      }
      const enabled = new Set(this._durableState.enabledLayerIds);
      if (change.enabled) enabled.add(change.layerId);
      else enabled.delete(change.layerId);
      this._commitExplicit({
        ...this._durableState,
        enabledLayerIds: [...enabled],
      });
      return;
    }
    if (change.type !== 'params') return;
    const entry = REGISTRY_BY_ID.get(change.layerId);
    if (!entry?.optionOwner) return;
    const ownerId = entry.optionOwner;
    const nextOwnerOptions = { ...this._durableState.options[ownerId] };
    const requestedParams = change.requestedParams || {};
    const trackingOptionKey =
      TRACKING_OPTION_KEY_BY_LAYER[change.layerId] || null;
    let changed = false;
    for (const spec of optionSpecs(ownerId)) {
      // Only persist keys present in this explicit request. getLayerParams()
      // can return a wider live snapshot containing transient or passively
      // changed values that this user action did not own. Tracking is the one
      // exception: an unrelated explicit option cancels a pending restoration
      // in that family, so its wider live value (active ID or null) must replace
      // the formerly durable pending ID instead of allowing reload resurrection.
      const explicitlyRequested = Object.hasOwn(requestedParams, spec.key);
      const implicitTrackingSync =
        !explicitlyRequested && spec.key === trackingOptionKey;
      // Packed options can persist only the subkeys owned by this request.
      const requestedValue =
        explicitlyRequested || implicitTrackingSync
          ? change.params[spec.key]
          : spec.patchRequested?.(
              nextOwnerOptions[spec.key],
              change.params[spec.key],
              requestedParams,
            );
      if (
        !explicitlyRequested &&
        !implicitTrackingSync &&
        requestedValue === undefined
      )
        continue;
      const value = spec.normalize(requestedValue);
      if (value === null) {
        if (implicitTrackingSync) {
          nextOwnerOptions[spec.key] = null;
          changed = true;
          continue;
        }
        if (spec.defaultValue !== null || change.params[spec.key] !== null)
          continue;
      }
      nextOwnerOptions[spec.key] = value;
      changed = true;
    }
    if (!changed) return;
    this._commitExplicit({
      ...this._durableState,
      options: { ...this._durableState.options, [ownerId]: nextOwnerOptions },
    });
  }

  _commitExplicit(candidate) {
    this._durableState = normalizeLayerState(candidate);
    const serialized = serializeStoredLayerState(this._durableState);
    try {
      if (this.storage?.getItem?.(LAYER_STATE_STORAGE_KEY) !== serialized) {
        this.storage?.setItem?.(LAYER_STATE_STORAGE_KEY, serialized);
      }
    } catch {
      /* storage can be unavailable or quota-limited */
    }
    this.shareLinkManager?.onLayerStateChange?.();
    this._notifyDurableState();
  }

  async _waitForRestoreGate() {
    if (!this.restoreGate) return;
    await (typeof this.restoreGate === 'function'
      ? this.restoreGate()
      : this.restoreGate);
  }

  async _restoreSelectedState(origin) {
    for (const entry of LAYER_STATE_REGISTRY) {
      this._restoreControllers.set(entry.id, new AbortController());
    }
    try {
      await this._waitForRestoreGate();
      const enabled = new Set(this._durableState.enabledLayerIds);
      const settled = await Promise.allSettled(
        LAYER_STATE_REGISTRY.map(async (entry) => {
          const controller = this._restoreControllers.get(entry.id);
          const targetEnabled = enabled.has(entry.id);
          const options = layerOptionsForRestore(this._durableState, entry.id);
          if (origin === LAYER_RESTORE_ORIGINS.share && options) {
            for (const trackingKey of Object.values(
              TRACKING_OPTION_KEY_BY_LAYER,
            )) {
              delete options[trackingKey];
            }
          }
          if (this._destroyed || controller?.signal.aborted) {
            return {
              layerId: entry.id,
              targetEnabled,
              origin,
              phase: 'reserved',
              ...currentLayerOutcome(this.dataManager, entry.id),
              appliedOptions: {},
              cancellationReason: this._destroyed ? 'destroyed' : 'superseded',
              errorClass: 'cancelled',
              persistenceWrite: false,
              succeeded: false,
            };
          }
          // Reserve passive option state before any asynchronous lifecycle work.
          // A later explicit params intent then wins on its own lane without
          // cancelling or being overwritten by the visibility restore.
          const paramsSucceeded =
            !options ||
            Object.keys(options).length === 0 ||
            this.dataManager.setLayerParams(entry.id, options, { origin });
          return this.dataManager
            .restoreLayerState(
              entry.id,
              {
                enabled: targetEnabled,
                params: null,
              },
              { origin, signal: controller.signal },
            )
            .then((result) => ({
              ...result,
              appliedOptions: paramsSucceeded && options ? options : {},
              errorClass: paramsSucceeded
                ? result.errorClass
                : 'ParamsRejected',
              succeeded: paramsSucceeded && result.succeeded,
            }));
        }),
      );
      this.lastRestoreResults = settled.map((result, index) => {
        if (result.status === 'fulfilled') return result.value;
        const entry = LAYER_STATE_REGISTRY[index];
        return {
          layerId: entry.id,
          targetEnabled: enabled.has(entry.id),
          origin,
          phase: 'coordinator',
          ...currentLayerOutcome(this.dataManager, entry.id),
          appliedOptions: {},
          cancellationReason: null,
          errorClass: result.reason?.name || 'Error',
          error: String(result.reason?.message || result.reason),
          persistenceWrite: false,
          succeeded: false,
        };
      });
      return this.lastRestoreResults.map((result) => ({ ...result }));
    } finally {
      this._restoreControllers.clear();
      this._notifyDurableState();
    }
  }

  _selectedShareTrackingTarget() {
    if (this._source !== 'share') return null;
    for (const [layerId, policy] of Object.entries(
      SHARE_TRACKING_RESTORE_POLICIES,
    )) {
      const targetId =
        this._durableState.options?.[policy.optionOwner]?.[policy.optionKey];
      if (targetId !== null && targetId !== undefined && targetId !== '') {
        return { layerId, targetId, ...policy };
      }
    }
    return null;
  }

  _passivelyClearTrackingSelection(selected) {
    const current =
      this._durableState.options?.[selected.optionOwner]?.[selected.optionKey];
    if (String(current) !== String(selected.targetId)) return false;
    const ownerOptions = {
      ...this._durableState.options[selected.optionOwner],
      [selected.optionKey]: null,
    };
    this._durableState = normalizeLayerState({
      ...this._durableState,
      options: {
        ...this._durableState.options,
        [selected.optionOwner]: ownerOptions,
      },
    });
    this.dataManager.setLayerParams?.(
      selected.layerId,
      { [selected.optionKey]: null },
      { origin: LAYER_RESTORE_ORIGINS.share },
    );
    this.shareLinkManager?.onLayerStateChange?.();
    this._notifyDurableState();
    return true;
  }

  /**
   * `atMs` is the moment the subject was first found ABSENT, not the moment the
   * verdict is delivered. Waiting out the pending window must not by itself
   * push a fresh link into the "expired" wording — that word describes the
   * SHARE's age, not how long this client watched for the subject.
   */
  _classifyMissingTrackingTarget(selected, atMs = this.now()) {
    const copiedAt = this._shareCreatedAtMs;
    if (!Number.isFinite(copiedAt)) return 'unavailable';
    const ageMs = atMs - copiedAt;
    return ageMs > selected.expiryWindowMs ? 'expired' : 'unavailable';
  }

  /** Whether the owning layer currently follows the shared subject. */
  _trackingTargetLatched(selected) {
    const params = this.dataManager.getLayerParams?.(selected.layerId);
    const active = params?.[selected.optionKey];
    return (
      active !== null &&
      active !== undefined &&
      String(active) === String(selected.targetId)
    );
  }

  /** Stop watching a pending shared subject without deciding its fate. */
  _cancelPendingTrackingWatch() {
    if (this._pendingTrackingTimer !== null)
      this.clearTimer(this._pendingTrackingTimer);
    this._pendingTrackingTimer = null;
    const pending = this._pendingTrackingContext;
    if (pending?.signal && pending.abortHandler) {
      pending.signal.removeEventListener('abort', pending.abortHandler);
      pending.abortHandler = null;
    }
  }

  /** Publish a share-follow lifecycle update without allowing UI errors to own state. */
  _publishTrackingRestoreStatus(status) {
    try {
      this.onTrackingRestoreStatus?.(status);
    } catch {
      /* status UI is best effort */
    }
  }

  /**
   * Revoke a pending shared Follow wholesale.
   *
   * The watch and the LAYER's own deferred-restore latch are two halves of one
   * mechanism, so they must die together. Aborting only the restore controller
   * left the timer alive: the controller has already settled by the time the
   * watch exists, so the abort was a no-op and the orphaned timer went on to
   * announce "Shared … unavailable" for a subject whose latch had been
   * cancelled — a notice about work no longer being attempted.
   */
  _revokePendingTrackingWatch(reason) {
    this._trackingRestoreController?.abort(reason);
    this._trackingRestoreGeneration += 1;
    this._cancelPendingTrackingWatch();
    const pending = this._pendingTrackingContext;
    this._pendingTrackingContext = null;
    if (pending) {
      this.dataManager.cancelPendingLayerRestore?.(pending.selected.layerId, {
        origin: LAYER_RESTORE_ORIGINS.share,
        reason: String(reason || 'cancelled'),
      });
      this._publishTrackingRestoreStatus({
        ...pending.probe,
        ...pending.selected,
        status: 'cancelled',
        classification: 'cancelled',
        reason: String(reason || 'cancelled'),
        cleared: false,
      });
    }
  }

  /**
   * Hold a not-yet-arrived shared subject PENDING instead of declaring it gone.
   *
   * A recipient's first authoritative refresh routinely lands without a given
   * contact — the feed is polled, coverage is partial, and rendering trails the
   * snapshot by a poll. Reload-from-local already survives this: its restore
   * arms the layer's own deferred-restore latch, which re-attempts on every
   * later poll. The shared path used to decide on that single refresh, clear
   * the subject from durable state AND from the URL, then post a failure notice
   * seconds into startup — so the same link healed on reload but never on the
   * share.
   *
   * Arm the SAME latch, then watch it in the background: the caller is never
   * blocked (startup must not wait out a 90 s window before it may write the
   * URL again), and the terminal verdict is deferred until the source-specific
   * window has genuinely expired. The existing wordings are unchanged.
   */
  async _beginPendingTrackingRestore(selected, probe, signal = null) {
    const generation = this._trackingRestoreGeneration;
    const absentAtMs = this.now();
    // Arm the layer's deferred-restore latch under the passive share origin, so
    // it re-attempts each poll and never rewrites recipient preferences.
    let armed = false;
    let armError = null;
    try {
      armed =
        (await this.dataManager.setLayerParams?.(
          selected.layerId,
          { [selected.optionKey]: selected.targetId },
          { origin: LAYER_RESTORE_ORIGINS.share },
        )) === true;
    } catch (error) {
      armError = error;
    }
    if (
      this._destroyed ||
      generation !== this._trackingRestoreGeneration ||
      signal?.aborted
    ) {
      if (armed) {
        this.dataManager.cancelPendingLayerRestore?.(selected.layerId, {
          origin: LAYER_RESTORE_ORIGINS.share,
          reason: String(signal?.reason || 'superseded'),
        });
      }
      return {
        ...probe,
        ...selected,
        status: 'cancelled',
        classification: 'cancelled',
        reason: String(signal?.reason || 'superseded'),
        cleared: false,
      };
    }
    if (!armed) {
      const terminal = {
        ...probe,
        ...selected,
        status: 'source-unavailable',
        classification: 'source-unavailable',
        reason: String(
          armError?.message || armError || 'tracking restore latch rejected',
        ),
        cleared: this._passivelyClearTrackingSelection(selected),
      };
      this._publishTrackingRestoreStatus(terminal);
      return terminal;
    }
    const deadline = this.now() + selected.expiryWindowMs;
    const settle = (terminal) => {
      if (this._pendingTrackingContext?.generation !== generation) return;
      this._cancelPendingTrackingWatch();
      this._pendingTrackingContext = null;
      this._publishTrackingRestoreStatus(terminal);
    };
    const poll = () => {
      this._pendingTrackingTimer = null;
      if (this._destroyed || generation !== this._trackingRestoreGeneration)
        return;
      // The layer that owns the latch may have gone away since the last tick
      // (disable, teardown, replacement). There is nothing left attempting this
      // restore, so abandon it silently rather than announcing a verdict.
      if (this.dataManager.isEffectivelyEnabled?.(selected.layerId) === false) {
        this._revokePendingTrackingWatch('owner-layer-disabled');
        return;
      }
      if (this._trackingTargetLatched(selected)) {
        settle({
          ...probe,
          ...selected,
          status: 'found',
          classification: 'followed',
          cleared: false,
        });
        return;
      }
      if (this.now() >= deadline) {
        // The window really has elapsed — only now does the verdict apply.
        const classification =
          probe.status === 'missing'
            ? this._classifyMissingTrackingTarget(selected, absentAtMs)
            : 'source-unavailable';
        const cleared = this._passivelyClearTrackingSelection(selected);
        settle({ ...probe, ...selected, classification, cleared });
        return;
      }
      this._pendingTrackingTimer = this.setTimer(
        poll,
        PENDING_TRACKING_POLL_MS,
      );
      this._pendingTrackingTimer?.unref?.();
    };
    this._cancelPendingTrackingWatch();
    const pending = {
      ...probe,
      ...selected,
      status: 'pending',
      classification: 'pending',
      cleared: false,
    };
    const pendingContext = {
      generation,
      selected,
      probe,
      signal,
      abortHandler: null,
    };
    if (signal) {
      pendingContext.abortHandler = () => {
        if (this._pendingTrackingContext?.generation !== generation) return;
        this._revokePendingTrackingWatch(signal.reason || 'aborted');
      };
      signal.addEventListener('abort', pendingContext.abortHandler, {
        once: true,
      });
    }
    this._pendingTrackingContext = pendingContext;
    this._publishTrackingRestoreStatus(pending);
    this._pendingTrackingTimer = this.setTimer(poll, PENDING_TRACKING_POLL_MS);
    this._pendingTrackingTimer?.unref?.();
    return pending;
  }

  /**
   * Refresh and restore the one shareable tracked target after destination
   * camera and ordinary layer restoration have settled.
   */
  async restoreShareTrackingSelection({ signal = null } = {}) {
    const selected = this._selectedShareTrackingTarget();
    if (!selected || this._destroyed)
      return { status: 'skipped', reason: 'no-shared-target' };
    this._revokePendingTrackingWatch('superseded-by-newer-restore');
    const controller = new AbortController();
    const combinedSignal = signal
      ? AbortSignal.any([signal, controller.signal])
      : controller.signal;
    this._trackingRestoreController = controller;
    const generation = ++this._trackingRestoreGeneration;
    let result;
    try {
      result = await this.dataManager.resolveLayerTrackingTarget(
        selected.layerId,
        selected.targetId,
        { signal: combinedSignal, origin: LAYER_RESTORE_ORIGINS.share },
      );
    } catch (error) {
      result = combinedSignal.aborted
        ? {
            status: 'cancelled',
            reason: String(combinedSignal.reason || 'aborted'),
          }
        : {
            status: 'source-unavailable',
            reason: String(error?.message || error),
          };
    }
    if (
      generation !== this._trackingRestoreGeneration ||
      this._destroyed ||
      combinedSignal.aborted
    ) {
      if (this._trackingRestoreController === controller)
        this._trackingRestoreController = null;
      return {
        ...result,
        status: 'cancelled',
        reason: String(combinedSignal.reason || 'superseded'),
      };
    }
    if (this._trackingRestoreController === controller)
      this._trackingRestoreController = null;

    if (result.status === 'found') {
      const terminal = {
        ...result,
        ...selected,
        classification: 'followed',
        cleared: false,
      };
      this._publishTrackingRestoreStatus(terminal);
      return terminal;
    }
    if (['cancelled', 'superseded', 'destroyed'].includes(result.status))
      return result;

    // A subject that is simply not here YET is not a subject that is gone. Hold
    // it on the layer's own deferred-restore latch for its source-specific
    // window before any verdict is reached or shown. `unsupported` layers have
    // no latch to arm, so they still decide immediately.
    if (result.status === 'missing' || result.status === 'source-unavailable') {
      return this._beginPendingTrackingRestore(
        selected,
        result,
        combinedSignal,
      );
    }

    const classification =
      result.status === 'missing'
        ? this._classifyMissingTrackingTarget(selected)
        : 'source-unavailable';
    const cleared = this._passivelyClearTrackingSelection(selected);
    const terminal = { ...result, ...selected, classification, cleared };
    this._publishTrackingRestoreStatus(terminal);
    return terminal;
  }

  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;
    for (const controller of this._restoreControllers.values())
      controller.abort('coordinator-destroyed');
    this._restoreControllers.clear();
    this._revokePendingTrackingWatch('coordinator-destroyed');
    this._trackingRestoreController = null;
    this._unsubscribe?.();
    this._unsubscribe = null;
    this._unsubscribeVisibilityRequests?.();
    this._unsubscribeVisibilityRequests = null;
    this.shareLinkManager?.setLayerStateProvider?.(null);
    this.onDurableStateChange = null;
    this.onTrackingRestoreStatus = null;
  }
}
