import * as geo from '../../geo/index.js';
import { worldClock } from '../../time/worldClock.js';

/** The camera pose to give back, in world coordinates. */
function captureCameraView(engine) {
  const pose = engine?.camera?.pose();
  if (!pose?.position) return null;
  return {
    destination: geo.cartesian3.clone(pose.position),
    orientation: {
      heading: pose.heading,
      pitch: pose.pitch,
      roll: pose.roll,
    },
  };
}

function sameCameraView(pose, view) {
  return (
    geo.cartesian3.equalsEpsilon(pose.position, view.destination, 0, 1) &&
    ['heading', 'pitch', 'roll'].every((key) =>
      geo.math.equalsEpsilon(pose[key], view.orientation[key], 0, 1e-6),
    )
  );
}

/** Restore the pre-entry view if the entry flight still holds the camera. */
function restoreCameraView(engine, view, landedView) {
  const camera = engine?.camera;
  if (!camera) return;
  if (!landedView) camera.cancelFlight();
  else if (!sameCameraView(camera.pose(), landedView)) return;
  camera.setView(view);
}
export function createLifecycle({
  state: layerState,
  services,
  parts,
  source,
  getRenderer,
}) {
  const { holdContinuousRender, releaseContinuousRender } = services.render;
  // While on, the launches loaded span the time from the first to the last,
  // each one a mark. Registered once; off, the layer has no time to show, and
  // each step tells the clock once it has settled.
  worldClock.register({
    id: 'rocket-launches',
    coverage: () => {
      if (!layerState._enabled) return null;
      const marks = layerState._launches
        .map((launch) => Date.parse(launch.launchTime))
        .filter(Number.isFinite)
        .sort((a, b) => a - b);
      if (!marks.length) return null;
      return { start: marks[0], end: marks.at(-1), marks };
    },
  });

  /** The display on `engine`, with its input and frame listeners. */
  function attachDisplay(engine) {
    layerState._engine = engine;
    layerState._renderer = services.renderer.create({ engine });
    parts.panel.createMissionPanel();
    parts.overlays.createReplayVehicleOverlay();
    parts.overlays.clearMissionOverlaySources();
    const enabled = () =>
      layerState._enabled && Boolean(layerState._renderer?.visible());
    layerState._clickHandler = getRenderer().onClick(
      (id) => {
        const launchId = parts.selection.entityLaunchId(id);
        if (!launchId) return;
        parts.selection.setSelectedMission(launchId);
        parts.selection.focusMission(
          layerState._launches.find((l) => l.id === launchId),
        );
      },
      { enabled },
    );
    layerState._moveHandler = getRenderer().onHover({ enabled });
    // Apply horizon visibility before the engine traverses and picks the
    // scene. A postRender write is one frame late and can remain visibly
    // stale when request-on-demand rendering stops after a globe camera move.
    layerState._declutterHandler = getRenderer().on(
      'preRender',
      parts.rendering.updateMissionFrame,
    );
    parts.launchPad.initLaunchPadZonePrimitive();
    if (layerState._enabled) {
      holdContinuousRender('rocket-launches', layerState._engine);
      getRenderer().setVisible(true);
      layerState._orbitMatches = 0;
      for (const launch of layerState._launches)
        parts.rendering.addLaunchElements(launch, layerState._renderedTleText);
      parts.selection.showSelectedMission();
    }
  }

  const methods = {
    // The layer draws through the engine (options.engine) only.
    init(_scene, options) {
      layerState._count = 0;
      layerState._lastUpdate = null;
      layerState._stale = false;
      layerState._lastError = null;
      layerState._orbitMatches = 0;
      this.attachRenderer(null, options);
    },
    attachRenderer(
      _scene,
      { engine = null, waitForCameraRestore = false } = {},
    ) {
      if (engine) attachDisplay(engine);
      layerState._restoringViewport = true;
      if (!waitForCameraRestore) this.resumeViewport();
    },

    resumeViewport() {
      if (!layerState._restoringViewport) return;
      layerState._restoringViewport = false;
      if (layerState._enabled && layerState._replayCameraLaunchId) {
        parts.replay.startMissionReplay(layerState._replayCameraLaunchId, {
          resuming: true,
        });
      } else if (layerState._enabled && layerState._missionZoomAnchorId) {
        const launch = layerState._launches.find(
          (item) => item.id === layerState._missionZoomAnchorId,
        );
        if (launch)
          parts.selection.startMissionZoomAnchor(
            launch,
            layerState._missionZoomRange,
            { resuming: true },
          );
      }
      layerState._resumeRenderer?.();
      layerState._waitForRenderer = layerState._resumeRenderer = null;
    },

    detachRenderer() {
      if (!layerState._renderer) return;
      layerState._waitForRenderer ??= new Promise((resolve) => {
        layerState._resumeRenderer = resolve;
      });
      layerState._replayCameraHeading = layerState._replayTracks.get(
        layerState._replayCameraLaunchId,
      )?.lastCameraHeading;
      layerState._replayCameraToken++;
      layerState._replayCameraRemover?.();
      layerState._missionZoomAnchorRemover?.();
      layerState._replayCameraRemover = layerState._missionZoomAnchorRemover =
        null;
      layerState._clickHandler?.destroy();
      layerState._moveHandler?.destroy();
      layerState._declutterHandler?.();
      layerState._clickHandler =
        layerState._moveHandler =
        layerState._declutterHandler =
          null;
      parts.launchPad.destroyLaunchPadZonePrimitive();
      parts.orbitRendering.removeMissionOrbitPrimitives();
      parts.overlays.clearMissionOverlaySources();
      parts.overlays.destroyReplayVehicleOverlay();
      layerState._missionOverlayRecords.clear();
      layerState._satelliteTelemetry.clear();
      layerState._replayTracks.clear();
      parts.rendering.removeMissionElements();
      if (layerState._enabled)
        releaseContinuousRender('rocket-launches', layerState._engine);
      layerState._renderer.destroy();
      layerState._renderer = layerState._engine = null;
    },

    async enable() {
      layerState._sourceController.abort();
      layerState._sourceController = new AbortController();
      layerState._enabled = true;
      holdContinuousRender('rocket-launches', layerState._engine); // per-frame animator (perf wave 2)
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
      layerState.coverageChanged();
    },

    async _enableBody() {
      layerState._updateDirty = false;
      getRenderer()?.setVisible(true);
      parts.orbitRendering.syncMissionOrbitPrimitiveVisibility();
      // Snapshot the existing follow before the mission flight releases it.
      const dependency = parts.ingestion.captureSatelliteDependency();
      if (layerState._lastUpdate === null) {
        // A new attempt at an index that never loaded starts from loading.
        layerState._lastError = null;
        parts.panel.renderMissionRoster();
        // Kept until the mission index loads, so an entry that never does
        // gives the view back. A newer flight takes the camera and drops it.
        layerState._entryCameraView = captureCameraView(layerState._engine);
        layerState._entryLandedView = null;
      }
      const token = layerState._lifecycleToken;
      const flying = parts.selection.focusFullGlobe(layerState._engine, {
        complete: () => {
          if (token === layerState._lifecycleToken)
            layerState._entryLandedView = captureCameraView(layerState._engine);
        },
        cancel: () => {
          if (token === layerState._lifecycleToken)
            layerState._entryCameraView = null;
        },
      });
      if (!flying) layerState._entryCameraView = null;
      if (layerState._selectedLaunchId)
        parts.selection.setSelectedMission(
          layerState._selectedLaunchId,
          layerState._explicitSelection,
        );
      else parts.selection.setSelectedMission(null, false);
      await dependency;
    },

    async disable() {
      layerState._moveHandler?.reset?.();
      layerState._sourceController.abort();
      layerState._enabled = false;
      const entryView = layerState._entryCameraView;
      layerState._entryCameraView = null;
      if (entryView)
        restoreCameraView(
          layerState._engine,
          entryView,
          layerState._entryLandedView,
        );
      releaseContinuousRender('rocket-launches', layerState._engine);
      layerState._lifecycleToken++;
      layerState._updateDirty = false;
      parts.ingestion.clearPostTleRetry();
      parts.panel.clearMissionRosterHover();
      parts.replay.stopMissionReplay();
      layerState._cameraReleased = true;
      parts.selection.stopMissionZoomAnchor();
      getRenderer()?.setVisible(false);
      parts.orbitRendering.syncMissionOrbitPrimitiveVisibility();
      const cursor = layerState._engine?.host?.canvas?.style;
      if (cursor) cursor.cursor = '';
      parts.launchPad.hideLaunchPadZone();
      parts.overlays.hideReplayVehicleOverlay();
      layerState._selectedLaunchId = null;
      layerState._missionFocusIntentId = null;
      layerState._focusAfterActiveLookup = false;
      parts.overlays.clearMissionOverlaySources();
      await parts.ingestion.restoreSatelliteDependency();
      parts.panel.renderMissionPanel();
      layerState.coverageChanged();
    },

    async destroy() {
      layerState._resumeRenderer?.();
      layerState._waitForRenderer = layerState._resumeRenderer = null;
      layerState._sourceController.abort();
      releaseContinuousRender('rocket-launches', layerState._engine); // direct-destroy path (perf wave 2 fix)
      layerState._enabled = false;
      layerState._lifecycleToken++;
      layerState._updateDirty = false;
      await parts.ingestion.restoreSatelliteDependency();
      parts.panel.clearMissionRosterHover();
      parts.replay.stopMissionReplay();
      layerState._cameraReleased = true;
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
      parts.panel.clearMissionPanel();
      parts.rendering.removeMissionElements();
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
      layerState._renderer?.destroy();
      layerState._renderer = null;
      layerState._engine = null;
    },
  };

  return { methods };
}
