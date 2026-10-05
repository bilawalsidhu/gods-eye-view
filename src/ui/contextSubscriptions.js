import {
  contextLayerEnableBlockReason,
  isExplicitUserIntentOrigin,
  runWithContextModeChanging,
  settleContextModeChange,
  shouldCaptureContextSession,
  shouldDeferContextEntryDuringClear,
} from '../contextModePolicy.js';

export function connectContextManager(manager) {
  this.disconnect();
  if (this.destroyed) return;
  this._dataManager = manager || null;
  this._contextManagerUnsubscribe = this._dataManager?.subscribe?.((change) => {
    if (String(change?.type || '').startsWith('visibility'))
      this._handleContextLayerChange(change);
  });
  if (typeof this._dataManager?.subscribeVisibilityRequests === 'function') {
    this._dataManagerVisibilityRequestUnsubscribe =
      this._dataManager.subscribeVisibilityRequests((change) => {
        if (this.destroyed) return;
        if (shouldCaptureContextSession(change)) {
          // This event is synchronous with intent publication, before an
          // awaited guard or Clear All can alter the rest of the layer set.
          // Manager effective visibility already includes both the new entry
          // intent and Clear's reserved OFF baseline.
          this._captureContextSessionSnapshot({
            excludeLayerIds: [change.layerId],
          });
          if (
            shouldDeferContextEntryDuringClear({
              change,
              clearInFlight: Boolean(this._clearSelectedLayersPromise),
            })
          ) {
            this._contextModeDeferredEntryIntent = {
              layerId: change.layerId,
              intentEpoch: change.intentEpoch,
              origin: change.origin,
            };
            this._contextModeEntering = 'space-missions';
            this._syncContextModeButtons();
          }
        } else if (
          change?.layerId === 'rocket-launches' &&
          change.enabled === false &&
          isExplicitUserIntentOrigin(change.origin, change.layerId)
        ) {
          this._contextModeDeferredEntryIntent = null;
          if (this._clearSelectedLayersPromise) {
            this._contextSessionSnapshot = null;
            this._contextModeEntering = null;
            this._syncContextModeButtons();
          }
        }
      });
  }
  if (typeof this._dataManager?.addVisibilityGuard === 'function') {
    this._dataManagerVisibilityGuardUnsubscribe =
      this._dataManager.addVisibilityGuard(async (change) => {
        if (this.destroyed) return null;
        const layerName =
          this._dataManager?.layers?.get(change.layerId)?.module?.name ||
          change.layerId;
        const reason = contextLayerEnableBlockReason({
          contextMode: this._contextModeEntering || this._contextMode,
          change,
          layerName,
        });
        if (reason) return reason;
        if (
          change.enabled &&
          ['military-awareness', 'rocket-launches'].includes(change.layerId) &&
          shouldCaptureContextSession(change) &&
          (!this._contextModeChanging ||
            (change.layerId === 'rocket-launches' &&
              this._contextModeDeferredEntryIntent?.intentEpoch ===
                change.intentEpoch))
        ) {
          const entryMode =
            change.layerId === 'rocket-launches' ? 'space-missions' : null;
          const deferredClearEntry =
            this._contextModeDeferredEntryIntent?.intentEpoch ===
            change.intentEpoch;
          // A deferred entry owns the state after Clear settles. Restoring
          // Clear's transient busy flag here would leave Context stuck.
          const priorChanging = deferredClearEntry
            ? false
            : this._contextModeChanging;
          const notificationToken =
            change.notificationToken || Symbol('direct-context-shell-entry');
          const ownsNotificationToken = !change.notificationToken;
          if (ownsNotificationToken) {
            this._userFacingContextNotificationTokens.add(notificationToken);
          }
          this._contextModeEntering = entryMode;
          this._contextModeChanging = true;
          try {
            if (deferredClearEntry) {
              await this._clearSelectedLayersManagerPromise;
              if (this.destroyed) return false;
              if (
                this._contextModeDeferredEntryIntent?.intentEpoch !==
                change.intentEpoch
              )
                return false;
              this._contextModeDeferredEntryIntent = null;
            }
            await this._clearLayersOutsideContextMode(entryMode, {
              notificationToken,
            });
            if (this.destroyed) return false;
          } catch (error) {
            this._contextModeEntering = null;
            console.warn(`[Context] ${change.layerId} isolation failed`, error);
            try {
              await this._restoreContextSession({
                excludeLayerIds: [change.layerId],
                notificationToken,
              });
            } catch (restoreError) {
              console.warn(
                `[Context] ${change.layerId} rollback failed`,
                restoreError,
              );
            }
            return `${entryMode === 'space-missions' ? 'Space Missions' : 'Context'} could not start because another layer did not stop cleanly`;
          } finally {
            if (ownsNotificationToken) {
              this._userFacingContextNotificationTokens.delete(
                notificationToken,
              );
            }
            if (!this.destroyed) settleContextModeChange(this, priorChanging);
          }
        }
        return null;
      });
  }
  if (typeof this._dataManager?.subscribeBeforeDestroy === 'function') {
    this._dataManagerBeforeDestroyUnsubscribe =
      this._dataManager.subscribeBeforeDestroy(async ({ layerId } = {}) => {
        if (this.destroyed || !this._contextSessionSnapshot) return;
        await runWithContextModeChanging(this, async () => {
          this._contextMode = null;
          this.cockpitView?.exit({ restoreTracking: false });
          this._syncContextModeButtons();
          await this._restoreContextSession({
            excludeLayerIds: layerId ? [layerId] : [],
          });
        });
      });
  }
  this._syncContextModeButtons();
}
