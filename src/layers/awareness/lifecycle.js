import { cameraPoseSignature } from '../../data/iconOrientation.js';

export function createLifecycle({
  state: layerState,
  services,
  parts,
  source,
}) {
  const { holdContinuousRender, releaseContinuousRender } = services.render;

  /**
   * Quantized camera-pose signature, or '' when the camera cannot report a full
   * pose yet. An unknown pose reads as PARKED, so a camera that is still coming
   * up can never be mistaken for continuous movement.
   * @param {Cesium.Camera|null|undefined} camera
   * @returns {string}
   */

  function cameraMotionSignature(camera) {
    if (!camera?.positionWC || !Number.isFinite(camera.heading)) return '';
    return cameraPoseSignature(camera);
  }

  /**
   * Take or drop the continuous-render hold to match the current need. Idempotent
   * (the governor is identity-keyed), and self-healing: the release decision is
   * made on a frame the hold itself guaranteed, so a hold can never strand the
   * scene in continuous mode.
   * @returns {void}
   */

  function syncAwarenessRenderHold() {
    if (layerState.enabled && parts.model.awarenessNeedsContinuousRender())
      holdContinuousRender('military-awareness');
    else releaseContinuousRender('military-awareness');
  }

  function attachRuntimeListeners() {
    if (layerState.runtimeListenersAttached || !layerState.viewer) return;
    window.addEventListener(
      'gev:awareness-subject-selected',
      layerState.subjectListener,
    );
    window.addEventListener('gev:entity-selected', layerState.contextListener);
    window.addEventListener(
      'gev:entity-selection-cleared',
      layerState.clearListener,
    );
    window.addEventListener(
      'gev:awareness-subject-cleared',
      layerState.subjectClearListener,
    );
    layerState.preRenderRemover =
      layerState.viewer.scene.preRender.addEventListener(() => {
        if (!layerState.enabled) return;
        const now = Date.now();
        // "Did the camera move" uses the SAME quantized pose signature the fleet
        // rotation pass gates on (iconOrientation.cameraPoseSignature) rather than
        // camera.changed, whose granularity is globally degraded by other layers
        // mutating camera.percentageChanged.
        const poseSig = cameraMotionSignature(layerState.viewer.camera);
        if (poseSig !== layerState.lastCameraPoseSig) {
          layerState.lastCameraPoseSig = poseSig;
          layerState.lastCameraPoseChangeMs = now;
        }
        const decision = parts.model.awarenessRefreshDecision({
          nowMs: now,
          lastRefreshMs: layerState.lastSubjectRefreshMs,
          lastPoseChangeMs: layerState.lastCameraPoseChangeMs,
          wasMoving: layerState.cameraMoving,
        });
        layerState.cameraMoving = decision.moving;
        syncAwarenessRenderHold();
        if (!decision.refresh) return;
        layerState.lastSubjectRefreshMs = now;
        if (
          layerState.subject &&
          ['flights', 'military', 'ais-live-vessels'].includes(
            layerState.subject.layerId,
          )
        ) {
          parts.subject.refreshSelectedSubject();
        } else if (!layerState.passive && layerState.autoFocusRetryPending) {
          layerState.autoFocusRetryPending = false;
          parts.focus.focusAttentionTarget();
        } else {
          parts.rendering.scheduleDirectionOverlayUpdate();
        }
      });
    layerState.runtimeListenersAttached = true;
  }

  function detachRuntimeListeners() {
    if (layerState.runtimeListenersAttached) {
      window.removeEventListener(
        'gev:awareness-subject-selected',
        layerState.subjectListener,
      );
      window.removeEventListener(
        'gev:entity-selected',
        layerState.contextListener,
      );
      window.removeEventListener(
        'gev:entity-selection-cleared',
        layerState.clearListener,
      );
      window.removeEventListener(
        'gev:awareness-subject-cleared',
        layerState.subjectClearListener,
      );
    }
    layerState.preRenderRemover?.();
    layerState.preRenderRemover = null;
    layerState.lastCameraPoseSig = '';
    layerState.lastCameraPoseChangeMs = 0;
    layerState.cameraMoving = false;
    // No frames will arrive to run the per-frame release once the listener is
    // gone, so drop the hold here.
    releaseContinuousRender('military-awareness');
    parts.rendering.cancelDirectionOverlayUpdate();
    layerState.runtimeListenersAttached = false;
  }
  const methods = {
    init(viewer) {
      detachRuntimeListeners();
      layerState.viewer = viewer;
      layerState.subjectListener = (event) => {
        if (!layerState.enabled) return;
        parts.subject.selectSubject(event.detail);
      };
      layerState.contextListener = (event) => {
        if (!layerState.enabled) return;
        const subject = parts.subject.subjectFromContext(event.detail);
        if (!subject) return;
        if (parts.model.contextTargetFlyToAllowed(subject.layerId))
          parts.model.releaseAircraftTracking();
        parts.subject.selectSubject(subject);
      };
      layerState.clearListener = (event) => {
        if (!layerState.enabled || layerState.pendingSelectionKey) return;
        if (
          !parts.subject.awarenessClearMatchesSubject(
            layerState.subject,
            event.detail,
          )
        )
          return;
        // An eviction keeps the subject so the readout can hold last-known
        // values; only a deliberate clear tears the selection down.
        if (parts.model.awarenessClearIsEviction(event.detail)) {
          parts.subject.markSubjectEvicted();
          return;
        }
        parts.subject.clearAwarenessSubject();
      };
      layerState.subjectClearListener = (event) => {
        if (!layerState.enabled) return;
        const cleared = event.detail;
        if (layerState.pendingSelectionKey) return;
        if (
          parts.subject.awarenessClearMatchesSubject(
            layerState.subject,
            cleared,
          ) &&
          String(layerState.subject?.id) === String(cleared?.id)
        ) {
          if (parts.model.awarenessClearIsEviction(cleared)) {
            // Deliberately does NOT set autoFocusAttempted: the subject survives,
            // so the entry fallback has nothing to replace and the settlement
            // guard below stays scoped to real deselects.
            parts.subject.markSubjectEvicted();
            return;
          }
          // A deliberate clear during dependency settlement must win over the
          // entry fallback; otherwise Contacts can silently select a replacement.
          layerState.autoFocusAttempted = true;
          parts.subject.clearAwarenessSubject();
        }
      };
    },

    enable() {
      layerState.enabled = true;
      // NO unconditional continuous-render hold here. Contacts animates per frame
      // only while the VIEW is moving (the direction arrows are screen-projected);
      // parked, it is a throttled readout with nothing to animate. The hold is
      // taken and released per frame by syncAwarenessRenderHold().
      attachRuntimeListeners();
      parts.panel.startAwarenessPageRotation();
      layerState.autoFocusAttempted = false;
      layerState.autoFocusRetryPending = false;
      parts.panel.ensurePanel();
      parts.panel.hidePanel();
      if (!layerState.passive)
        return parts.dependencies.activateOperationalContext();
      return true;
    },

    disable() {
      layerState.enabled = false;
      releaseContinuousRender('military-awareness');
      detachRuntimeListeners();
      parts.panel.stopAwarenessPageRotation();
      layerState.cohortPages.clear();
      const releaseActivationId = ++layerState.activationId;
      layerState.autoFocusAttempted = false;
      layerState.autoFocusRetryPending = false;
      layerState.subject = null;
      layerState.results = null;
      layerState.lastSubjectRefreshMs = 0;
      layerState.lastEvaluatedPosition = null;
      layerState.sourceRevision = '';
      layerState.navigationHistory = [];
      layerState.navigationVisited.clear();
      layerState.navigationIndex = -1;
      layerState.suppressedHistoryKey = null;
      layerState.pendingSelectionKey = null;
      parts.rendering.clearVisual();
      parts.panel.hidePanel();
      // The manager must not publish this coordinator as settled OFF while its
      // owned dependency releases are still issuing newer absolute intents.
      // Context mode handoffs restore the pre-entry snapshot only after this
      // promise resolves, preventing those releases from superseding restore.
      layerState.passive = true;
      return parts.dependencies.releaseOwnedDependencies(releaseActivationId);
    },

    destroy() {
      this.disable();
      detachRuntimeListeners();
      layerState.panel?.removeEventListener(
        'click',
        layerState.panelClickListener,
      );
      layerState.panelClickListener = null;
      if (layerState.panelOwned) layerState.panel?.remove();
      else if (layerState.panel) layerState.panel.replaceChildren();
      layerState.panel = null;
      layerState.panelOwned = false;
      layerState.directionRoot?.remove();
      layerState.directionRoot = null;
      layerState.compassRing = null;
      layerState.compassLabels = [];
      layerState.compassHeading = null;
      layerState.directionMarkers = [];
      layerState.panelMarkup = '';
      layerState.subjectListener = null;
      layerState.contextListener = null;
      layerState.clearListener = null;
      layerState.subjectClearListener = null;
      layerState.viewer = null;
      layerState.dataManager = null;
    },
  };

  return {
    cameraMotionSignature,
    syncAwarenessRenderHold,
    attachRuntimeListeners,
    detachRuntimeListeners,
    methods,
  };
}
