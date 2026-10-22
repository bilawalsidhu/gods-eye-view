export function createLifecycle({
  state: layerState,
  services,
  parts,
  source,
  getRenderer,
}) {
  const { holdContinuousRender, releaseContinuousRender } = services.render;

  const methods = {
    init(viewer, { engine = null } = {}) {
      layerState._engine = engine;
      layerState._renderer = services.renderer.create({ viewer, engine });
      layerState._viewer = layerState._renderer.view;
      layerState._declutterOccluder = getRenderer().occluder();
      layerState._enabled = false;
      parts.panel.createMissionPanel();
      parts.overlays.createReplayVehicleOverlay();
      layerState._dataSource = getRenderer().createDataSource();
      layerState._count = 0;
      layerState._lastUpdate = null;
      layerState._lastError = null;
      layerState._orbitMatches = 0;
      parts.overlays.clearMissionOverlaySources();
      const enabled = () => layerState._enabled && layerState._dataSource?.show;
      layerState._clickHandler = getRenderer().listenClick(
        layerState._dataSource,
        (entity) => {
          const launchId = parts.selection.entityLaunchId(entity);
          if (!launchId) return;
          parts.selection.setSelectedMission(launchId);
          parts.selection.focusMission(
            layerState._launches.find((l) => l.id === launchId),
          );
        },
        { enabled },
      );
      layerState._moveHandler = getRenderer().listenMove(
        layerState._dataSource,
        (entity) => {
          layerState._viewer.scene.canvas.style.cursor = entity
            ? 'pointer'
            : '';
        },
        { enabled },
      );
      // Apply horizon visibility before Cesium traverses and picks the scene.
      // A postRender write is one frame late and can remain visibly stale when
      // request-on-demand rendering stops after a globe camera move.
      layerState._declutterHandler = getRenderer().on(
        'preRender',
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
      if (layerState._dataSource)
        getRenderer().removeDataSource(layerState._dataSource);
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
      layerState._renderer?.destroy();
      layerState._renderer = null;
      layerState._engine = null;
      layerState._viewer = null;
    },
  };

  return { methods };
}
