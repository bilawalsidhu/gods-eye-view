import {
  contextAllowedLayerIds,
  mergeContextTransitionErrors,
} from '../contextModePolicy.js';

export async function _selectContextMode(
  mode,
  { notificationToken = null, signal = null } = {},
) {
  if (this.destroyed || !this._dataManager) return false;
  if (this._clearSelectedLayersPromise) return false;
  this._contextTransitionFailedLayerIds = [];
  const generation = ++this._contextModeGeneration;
  const isCurrent = () =>
    !this.destroyed && generation === this._contextModeGeneration;
  this._contextModeEntryIntent = null;
  this._contextModeReplacementIntent = null;
  this._contextModeChanging = true;
  this._syncContextModeButtons();
  try {
    if (mode !== 'flights' && this.cockpitView?.active) {
      this.cockpitView.exit({ restoreTracking: false });
    }
    if (!mode) {
      this._contextMode = null;
      this._syncContextModeButtons();
      await this._restoreContextSession({ notificationToken, signal });
      return isCurrent();
    }
    // A cross-mode switch dismantles the prior mode BEFORE the new one is
    // committed. If the caller aborts in that window the switch never lands,
    // and the resting state is Context OFF — reported as such by
    // setContextMode rather than dressed up as a clean cancellation. See the
    // note above _restoreContextSessionAfterLayerSettles.
    const crossModeSwitch = Boolean(
      this._contextMode && this._contextMode !== mode,
    );
    if (crossModeSwitch) {
      this._contextMode = null;
      await this._restoreContextSession({ notificationToken, signal });
      if (!isCurrent()) return false;
      if (signal?.aborted) return false;
    }
    this._captureContextSessionSnapshot();
    this._contextMode = mode;
    this._syncContextModeButtons();
    // Replay isolation must settle before Space Missions starts. Contacts
    // keeps its non-dependency teardown in the background so slow source
    // shutdown does not delay cockpit entry.
    try {
      await this._clearLayersOutsideContextMode(mode, {
        notificationToken,
        signal,
      });
    } catch (error) {
      if (!isCurrent()) return false;
      let transitionError = error;
      console.warn(`[Context] ${mode} isolation failed`, error);
      this._contextMode = null;
      this._syncContextModeButtons();
      try {
        await this._restoreContextSession({ notificationToken });
      } catch (restoreError) {
        transitionError = mergeContextTransitionErrors(
          transitionError,
          restoreError,
        );
        this._contextTransitionFailedLayerIds = [
          ...(transitionError.failedLayerIds || []),
        ];
        throw transitionError;
      }
      this._contextTransitionFailedLayerIds = [
        ...(transitionError?.failedLayerIds || []),
      ];
      return false;
    }
    if (!isCurrent()) return false;
    // Entry is one transaction: isolation succeeded above, so a failed mode
    // activation must roll the cleared layers back instead of stranding the
    // user in a half-entered mode with an orphaned snapshot.
    const entryLayerId =
      mode === 'flights' ? 'military-awareness' : 'rocket-launches';
    if (mode === 'flights') {
      this._dataManager.setLayerParams('military-awareness', {
        passive: false,
      });
    }
    let activated = false;
    let activationError = null;
    let activationIntent = null;
    let terminalIntentOutcome = null;
    try {
      activationIntent = this._dataManager._setEnabledWithIntent(
        entryLayerId,
        true,
        { notificationToken, ...(signal ? { signal } : {}) },
      );
      this._contextModeEntryIntent = {
        generation,
        layerId: entryLayerId,
        intentEpoch: activationIntent.intentEpoch,
      };
      activated = await activationIntent.promise;
      terminalIntentOutcome =
        await this._dataManager._waitForVisibilityIntent?.(
          entryLayerId,
          activationIntent.intentEpoch,
        );
    } catch (error) {
      activationError = error;
    }
    if (!isCurrent()) return false;
    let replacementIntent =
      mode === 'space-missions' &&
      this._contextModeReplacementIntent?.generation === generation &&
      this._contextModeReplacementIntent.layerId === entryLayerId
        ? this._contextModeReplacementIntent
        : null;
    while (replacementIntent) {
      const outcome = await this._dataManager._waitForVisibilityIntent?.(
        entryLayerId,
        replacementIntent.intentEpoch,
      );
      terminalIntentOutcome = outcome;
      if (!isCurrent()) return false;
      const replacementOwnsMode =
        outcome?.intentEpoch === replacementIntent.intentEpoch &&
        outcome.enabled === true &&
        outcome.succeeded === true;
      if (replacementOwnsMode) {
        this._contextModeEntering = null;
        this._contextModeEntryIntent = null;
        this._contextModeReplacementIntent = null;
        this._syncContextModeButtons();
        return true;
      }
      const successorEpoch =
        outcome?.cancellationReason === 'superseded' &&
        outcome.successorEnabled === true &&
        Number.isInteger(outcome.successorIntentEpoch) &&
        outcome.successorIntentEpoch > replacementIntent.intentEpoch
          ? outcome.successorIntentEpoch
          : null;
      replacementIntent =
        successorEpoch === null
          ? null
          : {
              generation,
              layerId: entryLayerId,
              intentEpoch: successorEpoch,
            };
    }
    if (
      activationError ||
      activated === false ||
      !this._dataManager.isEnabled(entryLayerId)
    ) {
      const cancelledAndSettled =
        terminalIntentOutcome?.succeeded === false &&
        ['caller-abort', 'resource-abort', 'superseded'].includes(
          terminalIntentOutcome.cancellationReason,
        );
      let transitionError = null;
      if (!cancelledAndSettled) {
        transitionError =
          activationError instanceof Error
            ? activationError
            : new Error(`Context activation failed for: ${entryLayerId}`);
        transitionError.failedLayerIds = [
          ...new Set([...(transitionError.failedLayerIds || []), entryLayerId]),
        ];
        this._contextTransitionFailedLayerIds = [
          ...transitionError.failedLayerIds,
        ];
        console.warn(
          `[Context] ${mode} activation failed; restoring previous layers`,
          activationError || 'not enabled',
        );
      }
      this._contextMode = null;
      this._contextModeEntryIntent = null;
      this._contextModeReplacementIntent = null;
      this._syncContextModeButtons();
      try {
        await this._restoreContextSession({
          excludeLayerIds: [entryLayerId],
          notificationToken,
        });
      } catch (restoreError) {
        transitionError = mergeContextTransitionErrors(
          transitionError,
          restoreError,
        );
        this._contextTransitionFailedLayerIds = [
          ...(transitionError?.failedLayerIds || []),
        ];
        throw transitionError;
      }
      // `null` means the requested entry was cancelled and its exact rollback
      // completed. The action wrapper treats that as a silent non-commit,
      // while callers still require literal `true` before expanding Context.
      return cancelledAndSettled ? null : false;
    }
    this._contextModeEntryIntent = null;
    return true;
  } finally {
    if (isCurrent()) {
      this._contextModeChanging = false;
      this._syncContextModeButtons();
    }
  }
}

export async function _deactivateContextForLayerChange({
  notificationToken = null,
} = {}) {
  this._contextModeGeneration += 1;
  this._contextModeChanging = true;
  this._contextMode = null;
  this._contextModeEntryIntent = null;
  this._contextModeReplacementIntent = null;
  if (this.cockpitView?.active)
    this.cockpitView.exit({ restoreTracking: false });
  this._syncContextModeButtons();
  try {
    await this._restoreContextSession({ notificationToken });
  } finally {
    this._contextModeChanging = false;
    this._syncContextModeButtons();
  }
}

export async function _clearLayersOutsideContextMode(
  mode = null,
  { notificationToken = null, signal = null } = {},
) {
  const allowed = contextAllowedLayerIds(mode);
  const pending = [];
  for (const [layerId] of this._dataManager.layers || []) {
    // Effective visibility: a disallowed layer still mid-ENABLING must be
    // isolated too, or it settles ON inside the exclusive mode.
    if (
      !allowed.has(layerId) &&
      this._dataManager.isEffectivelyEnabled(layerId)
    ) {
      pending.push({
        layerId,
        transition: this._dataManager.setEnabled(layerId, false, {
          notificationToken,
          ...(signal ? { signal } : {}),
        }),
      });
    }
  }
  const results = await Promise.all(
    pending.map(({ transition }) => transition),
  );
  const failed = pending
    .filter(
      ({ layerId }, index) =>
        results[index] === false || this._dataManager.isEnabled(layerId),
    )
    .map(({ layerId }) => layerId);
  if (failed.length > 0) {
    const error = new Error(
      `Context isolation failed for: ${failed.join(', ')}`,
    );
    error.failedLayerIds = failed;
    throw error;
  }
}
