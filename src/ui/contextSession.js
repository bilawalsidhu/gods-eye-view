import {
  contextRestoreLayerIds,
  contextSnapshotLayerIds,
  mergeContextTransitionErrors,
  settleContextIntentReplay,
} from '../contextModePolicy.js';

export function _trackContextLayerReaction(promise) {
  const tracked = Promise.resolve(promise);
  this._contextLayerReactionPromises.add(tracked);
  void tracked.then(
    () => this._contextLayerReactionPromises.delete(tracked),
    () => this._contextLayerReactionPromises.delete(tracked),
  );
  return tracked;
}

export async function _waitForContextLayerSettlement() {
  while (this._contextLayerReactionPromises.size > 0) {
    await Promise.allSettled([...this._contextLayerReactionPromises]);
  }
}

export function _captureContextSessionSnapshot({ excludeLayerIds = [] } = {}) {
  if (!this._dataManager || this._contextSessionSnapshot) return;
  const params = {};
  for (const layerId of ['military-awareness', 'satellites']) {
    const value = this._dataManager.getLayerParams(layerId);
    if (value) params[layerId] = value;
  }
  this._contextSessionSnapshot = {
    enabledLayerIds: contextSnapshotLayerIds(
      this._dataManager.getEnabledLayerIds(),
      this._contextRestoreState?.enabledLayerIds,
      excludeLayerIds,
    ),
    userAdded: new Set(),
    userRemoved: new Set(),
    params,
  };
}

export async function _restoreContextSession({
  excludeLayerIds = [],
  notificationToken = null,
  signal = null,
} = {}) {
  const snapshot = this._contextSessionSnapshot;
  if (!snapshot || !this._dataManager) return;
  // Clear the stored session before emitting restore notifications so none
  // of those transitions can be mistaken for a fresh Context entry.
  this._contextSessionSnapshot = null;
  const restoreState = {
    enabledLayerIds: contextRestoreLayerIds(snapshot),
    explicitLayerStates: new Map(),
  };
  this._contextRestoreState = restoreState;
  for (const [layerId, params] of Object.entries(snapshot.params)) {
    this._dataManager.setLayerParams(layerId, params);
  }
  let restoreError = null;
  const restoreSnapshot = async (restoreSignal = null) => {
    // Contacts owns the dependency intents it starts. Settle that
    // coordinator before restoring the remaining snapshot, otherwise its
    // dependency releases can supersede the restore's same-target requests
    // and make a valid Contacts-to-Missions handoff look like a failure.
    const contactsCoordinatorId = 'military-awareness';
    const settleContactsCoordinator =
      !restoreState.enabledLayerIds.has(contactsCoordinatorId) &&
      this._dataManager.isEffectivelyEnabled(contactsCoordinatorId);
    if (settleContactsCoordinator) {
      const coordinatorSettled = await this._dataManager.setEnabled(
        contactsCoordinatorId,
        false,
        {
          origin: 'context-restore',
          ...(notificationToken ? { notificationToken } : {}),
          ...(restoreSignal ? { signal: restoreSignal } : {}),
        },
      );
      if (coordinatorSettled === false) {
        const error = new Error(
          'Failed to settle Contacts before restoring Context',
        );
        error.failedLayerIds = [contactsCoordinatorId];
        throw error;
      }
    }
    await this._dataManager.restoreEnabledLayerIds(
      restoreState.enabledLayerIds,
      {
        origin: 'context-restore',
        excludeLayerIds: settleContactsCoordinator
          ? [...excludeLayerIds, contactsCoordinatorId]
          : excludeLayerIds,
        notificationToken,
        ...(restoreSignal ? { signal: restoreSignal } : {}),
      },
    );
  };
  try {
    await restoreSnapshot(signal);
  } catch (error) {
    restoreError = error;
    // A caller abort can arrive after only part of the exact restore has
    // settled. Finish that same target without the stale caller signal while
    // this restoreState still records newer explicit intents; replay below
    // then gives those newer intents final authority.
    if (signal?.aborted && !restoreState.cancelled) {
      try {
        await restoreSnapshot(null);
        restoreError = null;
      } catch (compensationError) {
        restoreError = mergeContextTransitionErrors(
          restoreError,
          compensationError,
        );
      }
    }
  } finally {
    if (this._contextRestoreState === restoreState)
      this._contextRestoreState = null;
  }
  // Clear Selected Layers owns a newer global OFF intent. A restore that was
  // already awaiting lifecycle work must not replay its captured companion
  // intent or recreate the discarded session after Clear invalidates it.
  if (restoreState.cancelled) return;
  // A direct Radio command may finish after restore has already copied its
  // target and queued the opposite state. Replay that newer intent only
  // after the stale queue drains; the replay origin cannot recurse here.
  const replaySignal = signal?.aborted ? null : signal;
  const replayError = await settleContextIntentReplay({
    restoreState,
    setEnabled: (layerId, enabled, options = {}) =>
      this._dataManager.setEnabled(layerId, enabled, {
        ...options,
        ...(replaySignal ? { signal: replaySignal } : {}),
      }),
    notificationToken,
  });
  restoreError = mergeContextTransitionErrors(restoreError, replayError);
  if (restoreError && !this._contextSessionSnapshot) {
    // Keep the exact still-pending target so a later exit/teardown can retry
    // instead of silently losing the user's pre-Context layer state.
    this._contextSessionSnapshot = {
      enabledLayerIds: new Set(restoreState.enabledLayerIds),
      userAdded: new Set(),
      userRemoved: new Set(),
      params: snapshot.params,
    };
  }
  if (restoreError) throw restoreError;
}

/*
 * Cross-mode cancellation and failure deliberately settle on Context OFF.
 *
 * A reinstatement transaction lived here for three review rounds and was
 * removed on purpose. Restoring the prior mode is genuinely racy: the prior
 * mode has to be read before the teardown, but a second request arriving
 * while the first reinstatement is mid-activation reads `_contextMode` as
 * null and inherits nothing, so two overlapping cancellations still land on
 * OFF — and the only fix is a cross-transaction "logical prior mode" chain,
 * which is new shared mutable state read while an earlier transaction is
 * still awaiting. That trades a rare wrong resting state for a permanent
 * interleaving hazard.
 *
 * The defect that started this was the LIE, not the OFF: the transition
 * claimed to have cancelled cleanly while silently leaving Context off. So
 * the resting state stays OFF and is REPORTED as such, with the failed layer
 * ids preserved. A restore feature can be rebuilt post-launch on the
 * generation discipline the surrounding transaction already follows.
 */
export async function _restoreContextSessionAfterLayerSettles(
  layerId,
  { notificationToken = null } = {},
) {
  await this._dataManager?.waitForLayerSettled?.(layerId);
  return this._restoreContextSession({ notificationToken });
}
