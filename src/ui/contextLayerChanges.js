import {
  cockpitEntryAllowed,
  isExplicitUserIntentOrigin,
  recordContextRestoreExplicitChange,
  recordContextSessionUserChange,
  shouldExitContextForLayerChange,
  spaceMissionEntryCancellationDisposition,
} from '../contextModePolicy.js';

export function _handleContextLayerChange(change) {
  if (this.destroyed) return;
  if (
    change?.layerId === 'radio' &&
    [
      'visibility-transition',
      'visibility',
      'visibility-cancelled',
      'visibility-failed',
    ].includes(change.type)
  ) {
    this.actions.refreshRadio();
  }
  if (change?.type === 'visibility-transition') return;
  // The effective mode must be read BEFORE the entering flag is cleared:
  // the entry layer's own enable event is the one that clears it, and the
  // session bookkeeping below needs to know a mode was being entered.
  const effectiveContextMode = this._contextModeEntering || this._contextMode;
  if (change?.type === 'visibility-cancelled') {
    const cancellationDisposition = spaceMissionEntryCancellationDisposition({
      change,
    });
    if (
      this._contextModeDeferredEntryIntent?.layerId === change.layerId &&
      this._contextModeDeferredEntryIntent.intentEpoch === change.intentEpoch
    ) {
      if (cancellationDisposition !== 'replacement') {
        this._contextModeDeferredEntryIntent = null;
      }
    }
    if (cancellationDisposition === 'replacement') {
      this._contextModeEntering = 'space-missions';
      const entryIntent = this._contextModeEntryIntent;
      if (
        entryIntent?.generation === this._contextModeGeneration &&
        entryIntent.layerId === change.layerId &&
        entryIntent.intentEpoch === change.intentEpoch
      ) {
        this._contextModeReplacementIntent = {
          generation: entryIntent.generation,
          layerId: change.layerId,
          intentEpoch: change.successorIntentEpoch,
        };
      }
    } else if (cancellationDisposition === 'restore') {
      this._contextModeEntering = null;
      this._contextModeEntryIntent = null;
      this._contextModeReplacementIntent = null;
      if (this._contextSessionSnapshot && !this._contextModeChanging) {
        this._contextMode = null;
        void this._trackContextLayerReaction(
          this._runUserFacingContextAction(async (notificationToken) => {
            await this._restoreContextSessionAfterLayerSettles(change.layerId, {
              notificationToken,
            });
            return true;
          }, 'Space Missions cancellation could not restore the previous layer state'),
        );
      }
    }
    this._syncContextModeButtons();
    return;
  }
  if (
    change?.layerId === 'rocket-launches' &&
    ['visibility', 'visibility-blocked', 'visibility-failed'].includes(
      change.type,
    )
  ) {
    this._contextModeEntering = null;
  }
  if (change?.type === 'visibility-blocked') {
    if (
      !this._userFacingContextNotificationTokens.has(change.notificationToken)
    ) {
      this.showToast(
        change.reason ||
          'That layer is unavailable in the current Context mode',
      );
    }
    this._syncContextModeButtons();
    return;
  }
  if (change?.type === 'visibility-failed') {
    const failureMessage = `${change.layerId} could not ${change.enabled ? 'start' : 'stop'} cleanly`;
    // A failed direct Context-shell START has already had its siblings
    // cleared by the visibility guard. Wait outside the synchronous manager
    // notification for this queue to settle, then reconcile the complete
    // snapshot, including an uncertain failed shell.
    const needsDeferredShellRestore =
      ['military-awareness', 'rocket-launches'].includes(change.layerId) &&
      change.enabled &&
      this._contextSessionSnapshot &&
      !this._contextModeChanging;
    if (needsDeferredShellRestore) {
      this._contextMode = null;
      void this._trackContextLayerReaction(
        this._runUserFacingContextAction(async (notificationToken) => {
          await this._restoreContextSessionAfterLayerSettles(change.layerId, {
            notificationToken,
          });
          // The wrapper owns failure announcements. On a successful rollback
          // announce the original activation failure here so the same direct
          // action still produces exactly one accessible notification.
          this.showToast(failureMessage);
          return true;
        }, failureMessage),
      );
    } else if (
      !this._userFacingContextNotificationTokens.has(change.notificationToken)
    ) {
      this.showToast(failureMessage);
    }
    this._syncContextModeButtons();
    return;
  }
  if (change?.type === 'visibility-will-change') {
    // Explicit entry capture happens on the synchronous visibility-requested
    // boundary. Keeping this later branch side-effect free prevents an
    // awaited Clear/guard from replacing that authoritative pre-entry view.
    return;
  }
  // Session bookkeeping must run BEFORE any exit path below: the exit
  // handlers restore `snapshot ∪ userAdded`, so a stale entry here becomes
  // a layer resurrected against the user's explicit disable.
  recordContextSessionUserChange({
    snapshot: this._contextSessionSnapshot,
    change,
    effectiveContextMode,
  });
  recordContextRestoreExplicitChange({
    restoreState: this._contextRestoreState,
    change,
  });
  if (
    shouldExitContextForLayerChange({
      contextMode: this._contextMode,
      globalContextEnabled:
        !!this._dataManager?.isEnabled('military-awareness'),
      change,
    })
  ) {
    void this._trackContextLayerReaction(
      this._runUserFacingContextAction((notificationToken) =>
        this._deactivateContextForLayerChange({ notificationToken }),
      ),
    );
    return;
  }
  if (!this._contextModeChanging) {
    if (change.layerId === 'military-awareness') {
      // The coordinator remains manager-addressable for restoration and
      // programmatic routes, but Contacts is selected only from the
      // dedicated right-side Global Context chooser.
      this._contextMode = change.enabled
        ? null
        : this._contextMode === 'flights'
          ? null
          : this._contextMode;
      if (change.enabled) {
        this._syncContextModeButtons();
      } else if (this._contextSessionSnapshot) {
        void this._trackContextLayerReaction(
          this._runUserFacingContextAction((notificationToken) =>
            this._deactivateContextForLayerChange({ notificationToken }),
          ),
        );
      }
    } else if (change.layerId === 'rocket-launches') {
      const ownsContextEntry =
        isExplicitUserIntentOrigin(change.origin, change.layerId) ||
        this._contextMode === 'space-missions' ||
        effectiveContextMode === 'space-missions';
      if (!ownsContextEntry) return;
      this._contextMode = change.enabled
        ? 'space-missions'
        : this._contextMode === 'space-missions'
          ? null
          : this._contextMode;
      if (change.enabled) {
        this._syncContextModeButtons();
      } else if (this._contextSessionSnapshot) {
        void this._trackContextLayerReaction(
          this._runUserFacingContextAction((notificationToken) =>
            this._deactivateContextForLayerChange({ notificationToken }),
          ),
        );
      }
    } else if (
      this._contextMode === 'flights' &&
      [
        'flights',
        'military',
        'ais-live-vessels',
        'military-installations',
      ].includes(change.layerId) &&
      !change.enabled
    ) {
      void this._trackContextLayerReaction(
        this._runUserFacingContextAction((notificationToken) =>
          this._deactivateContextForLayerChange({ notificationToken }),
        ),
      );
    }
  }
  if (
    this.cockpitView?.active &&
    !cockpitEntryAllowed({
      contextMode: this._contextMode,
      contextModeChanging: this._contextModeChanging,
      flightsEnabled: !!this._dataManager?.isEnabled('flights'),
      militaryEnabled: !!this._dataManager?.isEnabled('military'),
    })
  ) {
    this.cockpitView.exit({ restoreTracking: false });
  }
  this._syncContextModeButtons();
}
