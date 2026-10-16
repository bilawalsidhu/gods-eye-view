import { LayerStateCoordinator } from '../data/layerStateCoordinator.js';
import { stampInitialShareGesture } from '../navigationPolicy.js';
import { canPresentDeferredStatusNotice } from '../loadingFeedback.js';
import { t, msg } from '../i18n/index.js';
import { UiLifetime } from './uiLifetime.js';

// One ready-made sentence per restore policy (SHARE_TRACKING_RESTORE_POLICIES
// label) and outcome: a label dropped into a template cannot take the case or
// article the sentence needs in every language. The generic template stays
// for a label this table does not know.
const SHARE_RESTORE_NOTICES = Object.freeze({
  expired: Object.freeze({
    flight: msg('Shared flight follow expired'),
    'military flight': msg('Shared military flight follow expired'),
    satellite: msg('Shared satellite follow expired'),
  }),
  'source-unavailable': Object.freeze({
    flight: msg('Shared flight could not be restored — feed unavailable'),
    'military flight': msg(
      'Shared military flight could not be restored — feed unavailable',
    ),
    satellite: msg('Shared satellite could not be restored — feed unavailable'),
  }),
  unavailable: Object.freeze({
    flight: msg('Shared flight is unavailable'),
    'military flight': msg('Shared military flight is unavailable'),
    satellite: msg('Shared satellite is unavailable'),
  }),
});

/**
 * The status notice for a terminal share-tracking restore result.
 * @param {{classification?: string, label?: string}} result
 * @returns {string}
 */
export function shareTrackingRestoreNotice(result) {
  const outcome =
    result?.classification === 'expired' ||
    result?.classification === 'source-unavailable'
      ? result.classification
      : 'unavailable';
  const ready = SHARE_RESTORE_NOTICES[outcome][result?.label];
  if (ready) return t(ready);
  const subject = result?.label ? t(result.label) : t('entity');
  return outcome === 'expired'
    ? t('Shared {subject} follow expired', { subject })
    : outcome === 'source-unavailable'
      ? t('Shared {subject} could not be restored — feed unavailable', {
          subject,
        })
      : t('Shared {subject} is unavailable', { subject });
}

/** Own initial share restoration, durable layer state and restoration notices. */
export class ShareRestoration {
  constructor({
    viewer,
    navigation,
    syncShareState,
    syncModels3d,
    showStatus,
    feedback,
    updateFeedback,
  }) {
    Object.assign(this, {
      viewer,
      navigation,
      syncShareState,
      syncModels3d,
      showStatus,
      feedback,
      updateFeedback,
    });
    this._lifetime = new UiLifetime();
    this._disposed = false;
    this._shareTrackingAcquiringKey = null;
    this._shareTrackingNoticeGeneration = 0;
    this._initialShareState = null;
    this._initialShareNavigationGeneration = null;
    this._initialShareRestoreTimeout = null;
    this._layerStateCoordinator = null;
    this._layerStateRestorePromise = null;
  }
  attachLinks(shareLinkManager) {
    this.shareLinkManager = shareLinkManager;
    this._initialShareState = shareLinkManager.parseInitialHash();
  }
  start() {
    // Restore from URL hash if present
    const savedState = this._initialShareState;
    this._initialShareRestorePromise = savedState
      ? new Promise((resolve) => {
          this._resolveInitialShareRestore = resolve;
        })
      : Promise.resolve({ status: 'not-requested', share: null, layers: [] });
    if (savedState) {
      this._hasShareState = true;
      // Reserve camera authority now; the delayed mesh-friendly flight may
      // run only if no newer user, voice, or tracking navigation has won.
      this._initialShareNavigationGeneration =
        this.navigation._beginDeferredNavigation('shared view', {
          cancelPendingSelection: false,
        });
      this._initialShareRestoreTimeout = setTimeout(() => {
        this._initialShareRestoreTimeout = null;
        if (this._disposed) return;
        const generation = this._initialShareNavigationGeneration;
        const applyCamera =
          Number.isInteger(generation) &&
          this.navigation._reassertNavigationHandoff(generation);
        void (async () => {
          try {
            const share = await this.shareLinkManager.applyState(savedState, {
              applyCamera,
              navigationToken: generation,
            });
            const layers = await (this._layerStateRestorePromise ||
              Promise.resolve([]));
            const tracking =
              share.camera === 'applied'
                ? await this._layerStateCoordinator?.restoreShareTrackingSelection?.()
                : {
                    status: 'superseded',
                    cleared:
                      this._layerStateCoordinator?.cancelPendingShareTracking?.(
                        'shared-camera-superseded',
                        { clearSelection: true },
                      ) === true,
                  };
            this.shareLinkManager.completeInitialRestore();
            this._settleInitialShareRestore({
              status: 'settled',
              share,
              layers,
              tracking,
            });
          } catch (error) {
            this.shareLinkManager.completeInitialRestore();
            this._settleInitialShareRestore({
              status: 'failed',
              error: String(error?.message || error),
              share: null,
              layers: [],
            });
          }
        })();
      }, 1500);
    } else {
      this.syncShareState();
    }
    // A recipient can orbit before or during the delayed share flight. That
    // gesture keeps ordinary layer state but revokes the passive base camera
    // and selected-subject Follow so delayed work cannot seize navigation.
    this._initialShareGestureHandler = () => {
      if (
        this._disposed ||
        !this._hasShareState ||
        !this._resolveInitialShareRestore
      )
        return;
      stampInitialShareGesture((options) =>
        this.navigation._stampNavigation(options),
      );
    };
    this.viewer?.canvas?.addEventListener(
      'pointerdown',
      this._initialShareGestureHandler,
      {
        passive: true,
      },
    );
    this.viewer?.canvas?.addEventListener(
      'wheel',
      this._initialShareGestureHandler,
      {
        passive: true,
      },
    );
  }
  connect(dataManager) {
    this._dataManager = dataManager;
    this._layerStateCoordinator?.destroy();
    this._layerStateCoordinator = null;
    this._layerStateRestorePromise = null;
    if (this._dataManager) {
      this._layerStateCoordinator = new LayerStateCoordinator(
        this._dataManager,
        this.shareLinkManager,
        {
          onDurableStateChange: (state) => this.syncModels3d(state),
          onTrackingRestoreStatus: (result) =>
            this._handleShareTrackingRestoreStatus(result),
        },
      );
      this._layerStateRestorePromise = this._layerStateCoordinator.start({
        shareLayerState: this._initialShareState?.layerState || null,
        shareCreatedAtMs: this._initialShareState?.sharedAtMs ?? null,
        // Any valid camera/style share isolates recipient-local preferences,
        // including legacy and malformed-v2 layer payloads.
        allowLocalState: !this._initialShareState,
      });
      if (this._initialShareSelectionSuperseded) {
        this._layerStateCoordinator.cancelPendingShareTracking(
          'superseded-before-layer-coordinator-start',
          { clearSelection: true },
        );
      }
      void this._layerStateRestorePromise.then(() => {
        this.syncModels3d(this._layerStateCoordinator?.getDurableState());
      });
    }
  }
  cancelSelection() {
    if (
      this._hasShareState &&
      this._resolveInitialShareRestore &&
      !this._layerStateCoordinator
    )
      this._initialShareSelectionSuperseded = true;
    return (
      this._layerStateCoordinator?.cancelPendingShareTracking?.(
        'superseded-by-explicit-navigation',
        { clearSelection: true },
      ) === true
    );
  }
  get initialRestorePromise() {
    return (
      this._initialShareRestorePromise ||
      Promise.resolve({ status: 'not-requested' })
    );
  }
  _handleShareTrackingRestoreStatus(result) {
    if (!result || this._disposed) return;
    const trackingKey = `${result.layerId || ''}:${result.targetId ?? ''}`;
    if (result.classification === 'pending') {
      this._shareTrackingNoticeGeneration += 1;
      this._shareTrackingAcquiringKey = trackingKey;
      this.showStatus(t('ACQUIRING'), {
        state: 'acquiring',
        detail: t('SHARED {subject}', {
          subject: String(
            result.label ? t(result.label) : t('subject'),
          ).toUpperCase(),
        }),
        persistent: true,
      });
      return;
    }
    const ownsAcquiringNotice = this._shareTrackingAcquiringKey === trackingKey;
    if (ownsAcquiringNotice) {
      this._shareTrackingNoticeGeneration += 1;
      this._shareTrackingAcquiringKey = null;
      if (this.feedback._globalStatusNotice?.state === 'acquiring') {
        this.feedback._globalStatusNotice = null;
        this.updateFeedback();
      }
    }
    if (
      result.classification === 'followed' ||
      result.classification === 'cancelled'
    )
      return;
    // A stale terminal result must never replace a newer target's acquisition.
    if (this._shareTrackingAcquiringKey) return;
    const noticeGeneration = ownsAcquiringNotice
      ? this._shareTrackingNoticeGeneration
      : ++this._shareTrackingNoticeGeneration;
    const message = shareTrackingRestoreNotice(result);
    const showAfterStartupCover = () => {
      this._lifetime.frame(() => {
        if (
          !canPresentDeferredStatusNotice(
            noticeGeneration,
            this._shareTrackingNoticeGeneration,
            this._disposed,
          )
        )
          return;
        const startupCover = document.getElementById('loading-screen');
        if (
          !startupCover ||
          getComputedStyle(startupCover).visibility === 'hidden'
        ) {
          this.showStatus(message);
          return;
        }
        let fallbackTimer = null;
        let removeStartupListener = () => {};
        const showOnce = () => {
          removeStartupListener();
          if (fallbackTimer) this._lifetime.cancelTimeout(fallbackTimer);
          if (
            canPresentDeferredStatusNotice(
              noticeGeneration,
              this._shareTrackingNoticeGeneration,
              this._disposed,
            )
          )
            this.showStatus(message);
        };
        removeStartupListener = this._lifetime.listen(
          startupCover,
          'transitionend',
          showOnce,
          { once: true },
        );
        fallbackTimer = this._lifetime.timeout(showOnce, 1000);
      });
    };
    if (this._resolveInitialShareRestore) {
      void this.initialRestorePromise.then(showAfterStartupCover);
      return;
    }
    showAfterStartupCover();
  }
  _settleInitialShareRestore(result) {
    if (!this._resolveInitialShareRestore) return;
    const resolve = this._resolveInitialShareRestore;
    this._resolveInitialShareRestore = null;
    resolve(result);
    window.dispatchEvent(
      new CustomEvent('gev:initial-share-restore-settled', { detail: result }),
    );
  }
  destroy() {
    if (this._disposed) return;
    this._disposed = true;
    this._shareTrackingNoticeGeneration += 1;
    this._shareTrackingAcquiringKey = null;
    this._layerStateCoordinator?.destroy();
    this._layerStateCoordinator = null;
    this._layerStateRestorePromise = null;
    clearTimeout(this._initialShareRestoreTimeout);
    this._initialShareRestoreTimeout = null;
    this._settleInitialShareRestore({
      status: 'destroyed',
      share: null,
      layers: [],
    });
    this.viewer?.canvas?.removeEventListener(
      'pointerdown',
      this._initialShareGestureHandler,
    );
    this.viewer?.canvas?.removeEventListener(
      'wheel',
      this._initialShareGestureHandler,
    );
    this._initialShareGestureHandler = null;
    this._lifetime.destroy();
  }
}
