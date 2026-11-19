import { t } from '../i18n/index.js';
import {
  runWithContextModeChanging,
  settleContextModeChange,
  shouldCaptureContextSession,
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
        }
      });
  }
  if (typeof this._dataManager?.addVisibilityGuard === 'function') {
    this._dataManagerVisibilityGuardUnsubscribe =
      this._dataManager.addVisibilityGuard(async (change) => {
        if (this.destroyed) return null;
        // A direct Contacts start (the coordinator layer itself, not the
        // Context chooser) isolates its dependencies like the chooser does.
        if (
          !change.enabled ||
          change.layerId !== 'military-awareness' ||
          !shouldCaptureContextSession(change) ||
          this._contextModeChanging
        )
          return null;
        const notificationToken =
          change.notificationToken || Symbol('direct-context-shell-entry');
        const ownsNotificationToken = !change.notificationToken;
        if (ownsNotificationToken) {
          this._userFacingContextNotificationTokens.add(notificationToken);
        }
        this._contextModeEntering = null;
        this._contextModeChanging = true;
        try {
          await this._clearLayersOutsideContextMode(null, {
            notificationToken,
          });
          if (this.destroyed) return false;
        } catch (error) {
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
          return t(
            '{mode} could not start because another layer did not stop cleanly',
            { mode: t('Context') },
          );
        } finally {
          if (ownsNotificationToken) {
            this._userFacingContextNotificationTokens.delete(notificationToken);
          }
          if (!this.destroyed) settleContextModeChange(this, false);
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
