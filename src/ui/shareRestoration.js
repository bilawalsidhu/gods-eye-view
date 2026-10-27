import { LayerStateCoordinator } from '../data/layerStateCoordinator.js';
import { stampInitialShareGesture } from '../navigationPolicy.js';
import { canPresentDeferredStatusNotice } from '../loadingFeedback.js';
import { t, msg, formatDate } from '../i18n/index.js';
import { SHARE_VIEW_ENTITY_KINDS } from '../share/follow.js';
import { UiLifetime } from './uiLifetime.js';

/** How long a shared vessel may take to appear in the vessel feed. */
export const SHARED_VESSEL_WAIT_MS = 120_000;
const SHARED_VESSEL_POLL_MS = 2_000;
const DAY_MS = 86_400_000;
const ENTITY_BY_KIND = new Map(
  SHARE_VIEW_ENTITY_KINDS.map((entry) => [entry.kind, entry]),
);

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

/**
 * The notice for a shared entity that is not reporting: the view shows where
 * it was when the link was made.
 * @param {{kind: string, id: string}} entity
 * @param {number|null} observedAtMs
 * @param {number} [nowMs]
 * @returns {string}
 */
export function sharedFixNotice(entity, observedAtMs, nowMs = Date.now()) {
  // ICAO addresses read as they are written on the aircraft: upper case.
  const id =
    ENTITY_BY_KIND.get(entity.kind)?.idForm === 'hex24'
      ? String(entity.id).toUpperCase()
      : String(entity.id);
  if (!Number.isFinite(observedAtMs))
    return t("{id} isn't reporting now — showing where it was last seen", {
      id,
    });
  const time = formatDate(
    observedAtMs,
    nowMs - observedAtMs < DAY_MS
      ? { hour: '2-digit', minute: '2-digit' }
      : { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' },
  );
  return t("{id} isn't reporting now — showing where it was at {time}", {
    id,
    time,
  });
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
    applyFollowOffset = null,
  }) {
    Object.assign(this, {
      viewer,
      navigation,
      syncShareState,
      syncModels3d,
      showStatus,
      feedback,
      updateFeedback,
      // (entity, offset) => disposer: frame a followed entity from a shared
      // follow offset (shareFollow.js).
      applyFollowOffset,
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
    // Bumped by every share opened after start-up; an older restore that
    // settles later must neither apply follow-up work nor release URL writes.
    this._shareRestoreGeneration = 0;
    this._navigatedShareRestoreActive = false;
    this._stopFollowOffset = null;
    // Bumped to abandon the wait for a shared vessel.
    this._sharedVesselGeneration = 0;
    this._sharedVesselPending = false;
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
        void this._runShareRestore(savedState, {
          applyCamera,
          navigationToken: generation,
          layersPromise: this._layerStateRestorePromise,
          settle: (result) => this._settleInitialShareRestore(result),
        });
      }, 1500);
    } else {
      this.syncShareState();
      if (this.shareLinkManager?.rejectedShareCode)
        this._presentAfterStartupCover(
          t("This share link can't be opened"),
          ++this._shareTrackingNoticeGeneration,
        );
    }
    // A recipient can orbit before or during the delayed share flight. That
    // gesture keeps ordinary layer state but revokes the passive base camera
    // and selected-subject Follow so delayed work cannot seize navigation.
    this._initialShareGestureHandler = () => {
      // The recipient taking the camera also ends the wait for a vessel.
      if (this._sharedVesselPending) {
        this._sharedVesselGeneration += 1;
        this._sharedVesselPending = false;
      }
      if (
        this._disposed ||
        !this._hasShareState ||
        (!this._resolveInitialShareRestore &&
          !this._navigatedShareRestoreActive)
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
    // A different share opened in this tab later (pasted address, link,
    // Back/Forward) runs the same restore as start-up.
    this.shareLinkManager?.watchNavigation?.((state) =>
      this._restoreNavigatedShare(state),
    );
  }

  /**
   * Apply one incoming share: camera, visual, map and panels, then layers and
   * any shared Follow. Only the newest share may finish: a superseded run
   * stops before follow-up work and leaves URL writes suppressed for the
   * newer one.
   */
  async _runShareRestore(
    state,
    { applyCamera, navigationToken, layersPromise, settle },
  ) {
    const generation = this._shareRestoreGeneration;
    const current = () =>
      !this._disposed && generation === this._shareRestoreGeneration;
    try {
      const share = await this.shareLinkManager.applyState(state, {
        applyCamera,
        navigationToken,
      });
      const layers = await (layersPromise || Promise.resolve([]));
      if (!current()) return;
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
      if (!current()) return;
      this.shareLinkManager.completeInitialRestore(state.restoreToken);
      // Selecting a vessel leaves the camera alone, so it does not depend on
      // the shared flight having landed.
      const vessel = this._sharedVessel(state);
      if (vessel) void this._restoreSharedVessel(vessel, current);
      settle({ status: 'settled', share, layers, tracking });
    } catch (error) {
      if (!current()) return;
      this.shareLinkManager.completeInitialRestore(state.restoreToken);
      settle({
        status: 'failed',
        error: String(error?.message || error),
        share: null,
        layers: [],
      });
    }
  }

  /** Restore a share opened in this tab after start-up, superseding any other. */
  _restoreNavigatedShare(state) {
    if (this._disposed || !state) return;
    this._shareRestoreGeneration += 1;
    const settle = (result) => {
      this._navigatedShareRestoreActive = false;
      window.dispatchEvent(
        new CustomEvent('gev:share-navigation-restore-settled', {
          detail: result,
        }),
      );
    };
    try {
      return this._beginNavigatedShareRestore(state, settle);
    } catch (error) {
      // Never leave the address bar frozen on a restore that did not start.
      this.shareLinkManager.completeInitialRestore(state.restoreToken);
      settle({
        status: 'failed',
        error: String(error?.message || error),
        share: null,
        layers: [],
      });
    }
  }

  _beginNavigatedShareRestore(state, settle) {
    // A start-up restore still waiting for its delayed flight never runs.
    clearTimeout(this._initialShareRestoreTimeout);
    this._initialShareRestoreTimeout = null;
    this._settleInitialShareRestore({
      status: 'superseded',
      share: null,
      layers: [],
    });
    this._initialShareState = state;
    this._initialShareSelectionSuperseded = false;
    this._hasShareState = true;
    this._navigatedShareRestoreActive = true;
    // A new deferred navigation generation retires any older share flight.
    const navigationToken = this.navigation._beginDeferredNavigation(
      'shared view',
      { cancelPendingSelection: false },
    );
    // Releasing the previous Follow is part of the passive share restore and
    // must not be saved as the recipient's own layer preference.
    const applyCamera =
      Number.isInteger(navigationToken) &&
      this.navigation._reassertNavigationHandoff(navigationToken, {
        trackingOrigin: 'programmatic',
      });
    const layersPromise = this._layerStateCoordinator
      ? this._layerStateCoordinator.applyShareLayerState({
          shareLayerState: state.layerState || null,
          shareCreatedAtMs: state.sharedAtMs ?? null,
        })
      : null;
    return this._runShareRestore(state, {
      applyCamera,
      navigationToken,
      layersPromise,
      settle,
    });
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
  /** The shared vessel a share's thing view selects, if it names one. */
  _sharedVessel(state) {
    const view = state?.shareView;
    return view?.kind === 'thing' && view.entity.kind === 'vessel'
      ? view
      : null;
  }

  /**
   * Select a shared vessel once the vessel feed has it. Vessels are selected,
   * not followed: the camera is already at the shared view. If the vessel does
   * not appear in time, the view stays where it was when the link was made.
   */
  async _restoreSharedVessel(view, current) {
    const generation = ++this._sharedVesselGeneration;
    const live = () => current() && generation === this._sharedVesselGeneration;
    const deadline = Date.now() + SHARED_VESSEL_WAIT_MS;
    const { id } = view.entity;
    const { layerId } = ENTITY_BY_KIND.get(view.entity.kind);
    this._sharedVesselPending = true;
    try {
      while (live()) {
        const vessels = this._dataManager?.layers?.get?.(layerId)?.module;
        if (vessels?.hasContact?.(id) && vessels.selectById(id)) return true;
        if (Date.now() >= deadline) break;
        await new Promise((resolve) =>
          this._lifetime.timeout(resolve, SHARED_VESSEL_POLL_MS),
        );
      }
    } finally {
      if (generation === this._sharedVesselGeneration)
        this._sharedVesselPending = false;
    }
    if (!live()) return false;
    this._presentAfterStartupCover(
      view.lastKnown
        ? sharedFixNotice(view.entity, view.lastKnown.observedAtMs)
        : t('Shared vessel is unavailable'),
      ++this._shareTrackingNoticeGeneration,
    );
    return false;
  }

  /** The current share's thing view when `result` is about its entity. */
  _sharedThingFor(result) {
    const view = this._initialShareState?.shareView;
    if (view?.kind !== 'thing') return null;
    const entry = ENTITY_BY_KIND.get(view.entity.kind);
    return entry?.tracking === result?.layerId &&
      String(view.entity.id) === String(result?.targetId)
      ? view
      : null;
  }

  /** Frame a shared entity the camera now follows from the shared offset. */
  _applySharedFollowOffset(result) {
    const view = this._sharedThingFor(result);
    const entity = this.viewer?.trackedEntity;
    // Only a link made while following carries a real offset (with the fix);
    // a long link's follow keeps the app's own framing.
    if (
      !view?.lastKnown ||
      String(entity?.gevTrackedId || '') !==
        `${result.layerId}:${result.targetId}`
    )
      return;
    this._stopFollowOffset?.();
    this._stopFollowOffset = this.applyFollowOffset?.(entity, view.offset);
  }

  cancelSelection() {
    // An explicit navigation also ends the wait for a shared vessel.
    this._sharedVesselGeneration += 1;
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
    if (result.classification === 'followed') {
      this._applySharedFollowOffset(result);
      return;
    }
    if (result.classification === 'cancelled') return;
    // A stale terminal result must never replace a newer target's acquisition.
    if (this._shareTrackingAcquiringKey) return;
    const noticeGeneration = ownsAcquiringNotice
      ? this._shareTrackingNoticeGeneration
      : ++this._shareTrackingNoticeGeneration;
    // A share link that knows where the entity was says so; the view is
    // already there.
    const fix = this._sharedThingFor(result)?.lastKnown;
    const message = fix
      ? sharedFixNotice(
          this._initialShareState.shareView.entity,
          fix.observedAtMs,
        )
      : shareTrackingRestoreNotice(result);
    if (this._resolveInitialShareRestore) {
      void this.initialRestorePromise.then(() =>
        this._presentAfterStartupCover(message, noticeGeneration),
      );
      return;
    }
    this._presentAfterStartupCover(message, noticeGeneration);
  }

  /**
   * Show a status notice once the start-up cover is gone, unless a newer
   * notice (generation) has taken its place.
   */
  _presentAfterStartupCover(message, noticeGeneration) {
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
    this._sharedVesselGeneration += 1;
    this._stopFollowOffset?.();
    this._stopFollowOffset = null;
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
