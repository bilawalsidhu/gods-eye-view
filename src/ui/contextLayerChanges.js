import { t, translateKnown } from '../i18n/index.js';
import {
  recordContextRestoreExplicitChange,
  recordContextSessionUserChange,
  shouldExitContextForLayerChange,
} from '../contextModePolicy.js';

/**
 * A blocked-visibility reason in the UI language. Reasons stay English (voice
 * and tools read them): a known sentence is looked up, anything else passes.
 */
export function localizeVisibilityBlockReason(reason) {
  if (typeof reason !== 'string' || !reason) return reason;
  return translateKnown(reason);
}

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
  // A mode still being entered counts for the session bookkeeping below.
  const effectiveContextMode = this._contextModeEntering || this._contextMode;
  if (change?.type === 'visibility-cancelled') {
    this._syncContextModeButtons();
    return;
  }
  if (change?.type === 'visibility-blocked') {
    if (
      !this._userFacingContextNotificationTokens.has(change.notificationToken)
    ) {
      this.showToast(
        localizeVisibilityBlockReason(change.reason) ||
          t('That layer is unavailable in the current Context mode'),
      );
    }
    this._syncContextModeButtons();
    return;
  }
  if (change?.type === 'visibility-failed') {
    // A layer may name why its own start failed (Space Missions: the
    // mission index never loaded).
    const failureMessage =
      (change.enabled &&
        this._dataManager?.layers
          ?.get(change.layerId)
          ?.module?.enableFailureMessage?.()) ||
      t('{layerId} could not {action} cleanly', {
        layerId: change.layerId,
        action: change.enabled ? t('start') : t('stop'),
      });
    // A failed direct Context-shell START has already had its siblings
    // cleared by the visibility guard. Wait outside the synchronous manager
    // notification for this queue to settle, then reconcile the complete
    // snapshot, including an uncertain failed shell.
    const needsDeferredShellRestore =
      change.layerId === 'military-awareness' &&
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
    change.type === 'visibility' &&
    change.enabled &&
    change.origin === 'user' &&
    !this.cockpitView?.active &&
    change.layerId === 'radio'
  ) {
    globalThis.dispatchEvent?.(new Event('gev:context-show-view'));
    this.actions.setPanelCollapsed('global-context-panel', false, {
      explicit: true,
    });
    this.actions.setPanelCollapsed('radio-panel', false, { explicit: true });
  }
  finishContextLayerChange(this);
}

/** The checks every settled layer change ends with. */
function finishContextLayerChange(controls) {
  // Turning off the layer the view rides ends it; every other layer may be
  // turned on or off freely during a session.
  const riddenLayerId = controls.cockpitView?.active
    ? controls.cockpitView.readSubjectLayerId?.()
    : null;
  if (riddenLayerId && !controls._dataManager?.isEnabled(riddenLayerId)) {
    controls.cockpitView.exit({ restoreTracking: false });
  }
  controls._syncContextModeButtons();
}
