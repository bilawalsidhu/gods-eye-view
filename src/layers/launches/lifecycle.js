import * as Cesium from 'cesium';
import { isPointerFree } from '../../data/inputOwnership.js';

const HOVER_PICK_INTERVAL_MS = 120;

/**
 * Bound hover picking independently of precise click selection. A move inside
 * the throttle window is not dropped: its position is kept and one trailing
 * check runs when the window ends, so a pointer that stops is still resolved.
 */
export function createLaunchHover({
  viewer,
  enabled,
  entityLaunchId,
  now = () => performance.now(),
  documentRef = globalThis.document,
  pointerFree = isPointerFree,
  setTimer = globalThis.setTimeout,
  clearTimer = globalThis.clearTimeout,
}) {
  let moving = false;
  let lastPick = -Infinity;
  let ownsCursor = false;
  let pendingPosition = null;
  let trailingTimer = null;
  const clearCursor = () => {
    if (ownsCursor && viewer.scene.canvas.style.cursor === 'pointer')
      viewer.scene.canvas.style.cursor = '';
    ownsCursor = false;
  };
  const cancelTrailing = () => {
    if (trailingTimer !== null) clearTimer(trailingTimer);
    trailingTimer = null;
    pendingPosition = null;
  };
  const reset = () => {
    cancelTrailing();
    clearCursor();
    lastPick = -Infinity;
  };
  const start = () => {
    moving = true;
    reset();
  };
  const end = () => {
    moving = false;
    reset();
  };
  const visibility = () => {
    if (documentRef?.hidden || documentRef?.visibilityState === 'hidden')
      reset();
  };
  const eligible = () =>
    enabled() &&
    !moving &&
    !documentRef?.hidden &&
    documentRef?.visibilityState !== 'hidden' &&
    pointerFree();
  const pick = (position, at) => {
    lastPick = at;
    const found = viewer.scene
      .drillPick(position, 12)
      .some((picked) => entityLaunchId(picked?.id));
    if (found) {
      viewer.scene.canvas.style.cursor = 'pointer';
      ownsCursor = true;
    } else clearCursor();
  };
  const trailing = () => {
    trailingTimer = null;
    const position = pendingPosition;
    pendingPosition = null;
    if (!position) return;
    // Eligibility may have changed while the check waited.
    if (!eligible()) {
      reset();
      return;
    }
    pick(position, now());
  };
  const removeStart = viewer.camera?.moveStart?.addEventListener(start);
  const removeEnd = viewer.camera?.moveEnd?.addEventListener(end);
  documentRef?.addEventListener?.('visibilitychange', visibility);
  return {
    move(movement) {
      if (!eligible()) {
        reset();
        return;
      }
      const at = now();
      const wait = HOVER_PICK_INTERVAL_MS - (at - lastPick);
      if (wait > 0) {
        // Cesium reuses the movement object, so keep a copy of the position.
        pendingPosition = Cesium.Cartesian2.clone(
          movement.endPosition,
          pendingPosition ?? undefined,
        );
        if (trailingTimer === null) trailingTimer = setTimer(trailing, wait);
        return;
      }
      cancelTrailing();
      pick(movement.endPosition, at);
    },
    reset,
    destroy() {
      reset();
      removeStart?.();
      removeEnd?.();
      documentRef?.removeEventListener?.('visibilitychange', visibility);
    },
  };
}

export function createLifecycle({
  state: layerState,
  services,
  parts,
  source,
}) {
  const { holdContinuousRender, releaseContinuousRender } = services.render;
  let hover = null;

  const methods = {
    init(viewer) {
      layerState._viewer = viewer;
      layerState._enabled = false;
      parts.panel.createMissionPanel();
      parts.overlays.createReplayVehicleOverlay();
      layerState._dataSource = new Cesium.CustomDataSource('rocket-launches');
      layerState._dataSource.show = false;
      viewer.dataSources.add(layerState._dataSource);
      layerState._count = 0;
      layerState._lastUpdate = null;
      layerState._stale = false;
      layerState._lastError = null;
      layerState._orbitMatches = 0;
      parts.overlays.clearMissionOverlaySources();
      layerState._clickHandler = new Cesium.ScreenSpaceEventHandler(
        viewer.scene.canvas,
      );
      layerState._clickHandler.setInputAction((movement) => {
        // A tool owns the pointer (src/data/inputOwnership.js): yield the click.
        if (!isPointerFree()) return;
        if (!layerState._enabled || !layerState._dataSource?.show) return;
        const entity = viewer.scene
          .drillPick(movement.position, 12)
          .map((picked) => picked?.id)
          .find((candidate) => parts.selection.entityLaunchId(candidate));
        const launchId = parts.selection.entityLaunchId(entity);
        if (!launchId) return;
        parts.selection.setSelectedMission(launchId);
        parts.selection.focusMission(
          layerState._launches.find((launch) => launch.id === launchId),
        );
      }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
      layerState._moveHandler = new Cesium.ScreenSpaceEventHandler(
        viewer.scene.canvas,
      );
      hover = createLaunchHover({
        viewer,
        enabled: () => layerState._enabled && layerState._dataSource?.show,
        entityLaunchId: parts.selection.entityLaunchId,
      });
      layerState._moveHandler.setInputAction(
        hover.move,
        Cesium.ScreenSpaceEventType.MOUSE_MOVE,
      );
      // Apply horizon visibility before Cesium traverses and picks the scene.
      // A postRender write is one frame late and can remain visibly stale when
      // request-on-demand rendering stops after a globe camera move.
      layerState._declutterHandler = viewer.scene.preRender.addEventListener(
        parts.rendering.updateMissionFrame,
      );
      parts.launchPad.initLaunchPadZonePrimitive();
    },

    async enable() {
      layerState._sourceController.abort();
      layerState._sourceController = new AbortController();
      layerState._enabled = true;
      holdContinuousRender('rocket-launches'); // per-frame animator (perf wave 2)
      layerState._lifecycleToken++;
      layerState._postTleRetryCount = 0;
      try {
        await this._enableBody();
      } catch (error) {
        // Enable is a transaction: a failed dependency must not leave mission
        // UI/datasource visible or the satellite snapshot retained (a retained
        // snapshot makes the next enable skip dependency capture entirely).
        try {
          await this.disable();
        } catch (cleanupError) {
          console.warn('[Missions] enable rollback failed:', cleanupError);
        }
        throw error;
      }
    },

    async _enableBody() {
      layerState._updateDirty = false;
      if (layerState._dataSource) layerState._dataSource.show = true;
      parts.orbitRendering.syncMissionOrbitPrimitiveVisibility();
      parts.selection.focusFullGlobe(layerState._viewer);
      document.getElementById('cockpit-context')?.setAttribute('hidden', '');
      if (layerState._selectedLaunchId)
        parts.selection.setSelectedMission(
          layerState._selectedLaunchId,
          layerState._explicitSelection,
        );
      else parts.selection.setSelectedMission(null, false);
      await parts.ingestion.captureSatelliteDependency();
    },

    async disable() {
      hover?.reset();
      layerState._sourceController.abort();
      layerState._enabled = false;
      releaseContinuousRender('rocket-launches');
      layerState._lifecycleToken++;
      layerState._updateDirty = false;
      parts.ingestion.clearPostTleRetry();
      parts.panel.clearMissionRosterHover();
      parts.replay.stopMissionReplay();
      parts.selection.stopMissionZoomAnchor();
      if (layerState._dataSource) layerState._dataSource.show = false;
      parts.orbitRendering.syncMissionOrbitPrimitiveVisibility();
      if (layerState._viewer?.scene?.canvas)
        layerState._viewer.scene.canvas.style.cursor = '';
      parts.launchPad.hideLaunchPadZone();
      parts.overlays.hideReplayVehicleOverlay();
      layerState._selectedLaunchId = null;
      parts.overlays.clearMissionOverlaySources();
      await parts.ingestion.restoreSatelliteDependency();
      parts.panel.renderMissionPanel();
    },

    async destroy(viewer) {
      hover?.destroy();
      hover = null;
      layerState._sourceController.abort();
      releaseContinuousRender('rocket-launches'); // direct-destroy path (perf wave 2 fix)
      layerState._enabled = false;
      layerState._lifecycleToken++;
      layerState._updateDirty = false;
      await parts.ingestion.restoreSatelliteDependency();
      parts.panel.clearMissionRosterHover();
      parts.replay.stopMissionReplay();
      parts.selection.stopMissionZoomAnchor();
      parts.ingestion.clearPostTleRetry();
      if (layerState._clickHandler) layerState._clickHandler.destroy();
      layerState._clickHandler = null;
      if (layerState._moveHandler) layerState._moveHandler.destroy();
      layerState._moveHandler = null;
      if (layerState._declutterHandler) layerState._declutterHandler();
      layerState._declutterHandler = null;
      parts.launchPad.destroyLaunchPadZonePrimitive();
      parts.orbitRendering.removeMissionOrbitPrimitives();
      parts.overlays.clearMissionOverlaySources();
      parts.overlays.destroyReplayVehicleOverlay();
      layerState._launches = [];
      layerState._missionOverlayRecords.clear();
      layerState._animationStarts.clear();
      layerState._satelliteTelemetry.clear();
      layerState._replayTracks.clear();
      layerState._missionPanel?.remove();
      layerState._missionPanel = null;
      if (layerState._missionRoster) {
        layerState._missionRoster.onclick = null;
      }
      layerState._missionRosterPreviewOwnership = null;
      layerState._missionRoster = null;
      layerState._viewer = null;
      if (layerState._dataSource)
        viewer.dataSources.remove(layerState._dataSource, true);
      layerState._dataSource = null;
      layerState._count = 0;
      layerState._orbitMatches = 0;
      layerState._lastUpdate = null;
      layerState._stale = false;
      layerState._activeTleText = null;
      layerState._activeTlePromise = null;
      layerState._activeTlePromiseToken = 0;
      layerState._renderedTleText = null;
      layerState._postTleRetryCount = 0;
      layerState._satelliteStateBeforeMission = null;
      layerState._satelliteActivationPromise = null;
      layerState._dataManager = null;
    },
  };

  return { methods };
}
