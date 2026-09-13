import {
  settleUserFacingContextAction,
  contextModeWord,
} from '../contextModePolicy.js';

export async function _runUserFacingContextAction(
  operation,
  message = 'Context could not restore every layer; try again',
  { falseIsFailure = true } = {},
) {
  if (this.destroyed) return false;
  const notificationToken = Symbol('user-facing-context-action');
  this._userFacingContextNotificationTokens.add(notificationToken);
  try {
    return await settleUserFacingContextAction({
      operation: () => operation(notificationToken),
      falseIsFailure,
      onFailure: (error) => {
        if (this.destroyed) return;
        console.warn('[Context] user-facing transition failed', error);
        this.showToast(message);
      },
    });
  } finally {
    this._userFacingContextNotificationTokens.delete(notificationToken);
  }
}

/**
 * Claim the visual restore lane for an explicit Context transition.
 *
 * Contacts OWNS detection while active (forced Dense @ 75%), so entering or
 * leaving it is a visual-lane gesture exactly like the HUD or detection
 * controls. Without this claim, the shared-view restore that lands 1.5 s into
 * startup re-applied the link's `dm`/`dd` over the forced preset and Contacts
 * lost its own overlay mid-session.
 *
 * Deliberately does NOT set `_detectionUserOverridden`: that flag means the
 * OPERATOR hand-edited detection and suppresses the military-style
 * auto-enable for the rest of the session. Context entry is not that, and
 * conflating them would silently disable a separate landed behavior.
 *
 * Call only for VALIDATED explicit transitions — never for programmatic or
 * restore-driven ones, which must stay eligible for the shared visual state.
 */
export function _claimContextVisualAuthority() {
  this.actions.claimVisualAuthority();
}

export function getContextModeState() {
  return {
    mode: this._contextMode || null,
    active: Boolean(this._contextMode),
    changing: Boolean(this._contextModeChanging),
    entering: this._contextModeEntering || null,
    canContact: !this._contextMode || this._contextMode === 'flights',
    canMission: !this._contextMode || this._contextMode === 'space-missions',
    snapshotCaptured: Boolean(this._contextSessionSnapshot),
  };
}

export async function setContextMode(
  mode,
  {
    notificationToken = null,
    signal = null,
    isCurrent = null,
    claimVisualAuthority = true,
  } = {},
) {
  const requestIsCurrent = () =>
    !this.destroyed &&
    !signal?.aborted &&
    (typeof isCurrent !== 'function' || isCurrent());
  const cancellationResult = () => ({
    ok: false,
    action: 'set_context_mode',
    cancelled: true,
    error: 'Context request was superseded by a newer voice turn',
    ...this.getContextModeState(),
    ...(this._contextTransitionFailedLayerIds?.length
      ? { failedLayerIds: [...this._contextTransitionFailedLayerIds] }
      : {}),
  });
  if (!requestIsCurrent()) return cancellationResult();
  try {
    if (!mode || mode === 'off') {
      // Validated explicit transition — Context owns detection, so take the
      // visual lane before a delayed shared restore can reclaim it. Internal
      // Cockpit choreography opts out: it is not an operator Context request.
      if (claimVisualAuthority) this._claimContextVisualAuthority();
      const result = await this._selectContextMode(null, {
        notificationToken,
        signal,
      });
      if (result === null || (!requestIsCurrent() && result !== true))
        return cancellationResult();
      const state = this.getContextModeState();
      return {
        ok: result === true,
        action: 'set_context_mode',
        mode: state.mode,
        ...state,
        ...(result === true
          ? {}
          : { error: 'Context mode transition did not complete' }),
        ...(this._contextTransitionFailedLayerIds?.length
          ? { failedLayerIds: [...this._contextTransitionFailedLayerIds] }
          : {}),
      };
    }
    const canonical = mode === 'contacts' ? 'flights' : mode;
    if (!['flights', 'space-missions'].includes(canonical)) {
      return {
        ok: false,
        action: 'set_context_mode',
        error: `Unknown context mode: ${mode}`,
        mode: this._contextMode,
        ...this.getContextModeState(),
      };
    }
    const priorMode = this._contextMode;
    // Claimed only after the mode enum validates above, so a rejected request
    // takes no authority and leaves the shared visual state eligible. Internal
    // Cockpit choreography opts out: it is not an operator Context request.
    if (claimVisualAuthority) this._claimContextVisualAuthority();
    const transitioned = await this._selectContextMode(canonical, {
      notificationToken,
      signal,
    });
    if (transitioned === null || (!requestIsCurrent() && transitioned !== true))
      return cancellationResult();
    const state = this.getContextModeState();
    // A cross-mode switch tears the prior mode down before it commits, so a
    // cancelled or failed switch rests on Context OFF. Say that plainly:
    // reporting a bare "did not complete" while the operator's Context is
    // gone is the dishonesty this whole path was fixed for. The state fields
    // below carry the same verdict, so text and state cannot disagree.
    const crossModeSwitchLost =
      transitioned !== true &&
      Boolean(priorMode) &&
      priorMode !== canonical &&
      !state.mode;
    return {
      ok: transitioned === true,
      action: 'set_context_mode',
      mode: state.mode,
      ...state,
      ...(transitioned === true
        ? {}
        : {
            // Named in the operator's vocabulary, not the internal id: this
            // string is read by the voice model, which takes 'contacts'.
            error: crossModeSwitchLost
              ? `Switch to ${contextModeWord(canonical)} did not complete — Context is now off`
              : 'Context mode transition did not complete',
            ...(crossModeSwitchLost ? { contextOff: true, priorMode } : {}),
          }),
      ...(this._contextTransitionFailedLayerIds?.length
        ? { failedLayerIds: [...this._contextTransitionFailedLayerIds] }
        : {}),
    };
  } catch (error) {
    if (!requestIsCurrent()) {
      return {
        ...cancellationResult(),
        ...(Array.isArray(error?.failedLayerIds)
          ? { failedLayerIds: [...error.failedLayerIds] }
          : {}),
      };
    }
    return {
      ok: false,
      action: 'set_context_mode',
      error: error?.message || 'Context mode transition failed',
      ...(Array.isArray(error?.failedLayerIds)
        ? { failedLayerIds: [...error.failedLayerIds] }
        : {}),
      ...this.getContextModeState(),
    };
  }
}

export function clearSelectedLayers() {
  if (this.destroyed)
    return Promise.resolve({
      targetIds: [],
      items: [],
      clearedIds: [],
      notClearedIds: [],
      cancelled: true,
    });
  if (this._clearSelectedLayersPromise) return this._clearSelectedLayersPromise;
  if (!this._dataManager?.clearSelectedLayers) {
    return Promise.resolve({
      targetIds: [],
      items: [],
      clearedIds: [],
      notClearedIds: [],
    });
  }
  const generation = ++this._contextModeGeneration;
  const notificationToken = Symbol('clear-selected-layers');
  if (this._contextRestoreState) this._contextRestoreState.cancelled = true;
  this._contextModeChanging = true;
  this._contextMode = null;
  this._contextModeEntering = null;
  this._contextModeEntryIntent = null;
  this._contextModeReplacementIntent = null;
  this._contextSessionSnapshot = null;
  this._contextRestoreState = null;
  this._preservePanelStateDuringLayerClear = true;
  this._syncContextModeButtons();
  this._userFacingContextNotificationTokens.add(notificationToken);
  this.setClearBusy(true);

  const managerOperation = this._dataManager.clearSelectedLayers({
    origin: 'user',
    notificationToken,
  });
  this._clearSelectedLayersManagerPromise = managerOperation;
  const operation = managerOperation
    .then((result) => {
      if (result.targetIds.length === 0) {
        this.showToast('No selected data layers');
      } else if (result.notClearedIds.length > 0) {
        this.showToast(
          `${result.notClearedIds.length} data layer${result.notClearedIds.length === 1 ? '' : 's'} could not be cleared`,
        );
      } else {
        this.showToast(
          `Cleared ${result.clearedIds.length} data layer${result.clearedIds.length === 1 ? '' : 's'}`,
        );
      }
      return result;
    })
    .catch((error) => {
      console.warn('[Data] clear selected layers failed', error);
      this.showToast('Selected data layers could not be cleared');
      return {
        targetIds: [],
        items: [],
        clearedIds: [],
        notClearedIds: [],
        error,
      };
    })
    .finally(() => {
      this._userFacingContextNotificationTokens.delete(notificationToken);
      if (generation === this._contextModeGeneration) {
        this._contextModeChanging = false;
        this._syncContextModeButtons();
      }
      this.setClearBusy(false);
      this._preservePanelStateDuringLayerClear = false;
      this._clearSelectedLayersManagerPromise = null;
      this._clearSelectedLayersPromise = null;
    });
  this._clearSelectedLayersPromise = operation;
  return operation;
}
