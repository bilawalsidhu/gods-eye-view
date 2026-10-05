import * as Cesium from 'cesium';
import { isPointerFree } from '../../data/inputOwnership.js';

export function createLifecycle({
  state: layerState,
  services,
  parts,
  source,
}) {
  const { holdContinuousRender, releaseContinuousRender } = services.render;

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
      layerState._moveHandler.setInputAction((movement) => {
        if (!layerState._enabled || !layerState._dataSource?.show) return;
        const missionEntity = viewer.scene
          .drillPick(movement.endPosition, 12)
          .map((picked) => picked?.id)
          .find((candidate) => parts.selection.entityLaunchId(candidate));
        viewer.scene.canvas.style.cursor = missionEntity ? 'pointer' : '';
      }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);
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
