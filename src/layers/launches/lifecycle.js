import { isFollowing } from '../../data/followed.js';
import { isPointerFree } from '../../data/inputOwnership.js';
import { inputFor } from '../../input/dispatcher.js';
import { canvasOf, findCamera, findFrame } from '../../render/rendererOf.js';
import { worldClock } from '../../time/worldClock.js';
import {
  ROCKET_MISSION_AMBIENT_OVERLAY_SOURCE_ID,
  ROCKET_MISSION_SELECTED_OVERLAY_SOURCE_ID,
  cockpitActive,
} from './policy.js';

const HOVER_PICK_INTERVAL_MS = 120;

/**
 * Bound hover picking independently of precise click selection. A move inside
 * the throttle window is not dropped: its position is kept and one trailing
 * check runs when the window ends, so a pointer that stops is still resolved.
 */
export function createLaunchHover({
  viewer,
  enabled,
  launchAt,
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
    const canvas = canvasOf(viewer);
    if (ownsCursor && canvas.style.cursor === 'pointer')
      canvas.style.cursor = '';
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
    if (launchAt(position)) {
      canvasOf(viewer).style.cursor = 'pointer';
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
  const camera = findCamera(viewer);
  const removeStart = camera?.on('moveStart', start);
  const removeEnd = camera?.on('moveEnd', end);
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
        // The input source may reuse the movement object, so keep a copy of
        // the position.
        const end = movement.endPosition;
        if (end == null) pendingPosition = undefined;
        else {
          pendingPosition ??= { x: 0, y: 0 };
          pendingPosition.x = end.x;
          pendingPosition.y = end.y;
        }
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

/** The camera pose to give back, in world coordinates. */
function captureCameraView(viewer) {
  const pose = viewer ? findCamera(viewer)?.pose() : null;
  if (!pose?.position) return null;
  const { x, y, z } = pose.position;
  return {
    destination: { x, y, z },
    orientation: { heading: pose.heading, pitch: pose.pitch, roll: pose.roll },
  };
}

function sameCameraView(pose, view) {
  const { x, y, z } = view.destination;
  return (
    Math.hypot(pose.position.x - x, pose.position.y - y, pose.position.z - z) <=
      1 &&
    ['heading', 'pitch', 'roll'].every(
      (key) => Math.abs(pose[key] - view.orientation[key]) <= 1e-6,
    )
  );
}

/** Restore the pre-entry view if the entry flight still holds the camera. */
function restoreCameraView(viewer, view, landedView) {
  const camera = viewer ? findCamera(viewer) : null;
  if (!camera) return;
  if (!landedView) camera.cancelFlight();
  else if (!sameCameraView(camera.pose(), landedView)) return;
  camera.setView(view);
}

/** The longest name a timeline mark carries, as in the mission index. */
const MARK_LABEL_LENGTH = 27;

function markerLaunchId(hit) {
  if (
    hit?.sourceId !== ROCKET_MISSION_AMBIENT_OVERLAY_SOURCE_ID &&
    hit?.sourceId !== ROCKET_MISSION_SELECTED_OVERLAY_SOURCE_ID
  )
    return null;
  return hit.entryId.startsWith('launch:') ? hit.entryId.slice(7) : null;
}

export function createLifecycle({
  state: layerState,
  services,
  parts,
  source,
}) {
  const { holdContinuousRender, releaseContinuousRender } = services.render;
  const overlayAt = (position) =>
    services.overlays?.hitTestWorldOverlay?.(position?.x, position?.y);
  const missionsShown = () =>
    layerState._enabled && parts.rendering.missionsShown();
  const focusLaunch = (id, { move = true } = {}) => {
    if (!id) return false;
    const launch = layerState._launches.find((entry) => entry.id === id);
    if (!launch) return false;
    parts.selection.setSelectedMission(launch.id);
    if (move) parts.selection.focusMission(launch);
    for (const listener of [...layerState._globePickListeners]) {
      try {
        listener(launch.id);
      } catch (error) {
        console.warn('[Data:RocketLaunches] globe pick listener failed', error);
      }
    }
    return true;
  };
  let hover = null;
  // While on, the launches loaded span the time from the first to the last,
  // each one a mark labelled with its mission's name (the launch's where it
  // has none), cut short and in capitals as the mission index shows names.
  // Registered once; off, the layer has no time to show, and each step tells
  // the clock once it has settled.
  const clockSource = {
    id: 'rocket-launches',
    coverage: () => {
      if (!layerState._enabled) return null;
      const marks = layerState._launches
        .map((launch) => ({
          time: Date.parse(launch.launchTime),
          label: parts.overlays
            .shortMissionLabel(
              launch.missionName || launch.name,
              MARK_LABEL_LENGTH,
            )
            .toUpperCase(),
          ...(launch.id != null ? { id: String(launch.id) } : {}),
          kind: 'launch',
        }))
        .filter(({ time }) => Number.isFinite(time))
        .sort((a, b) => a.time - b.time);
      if (!marks.length) return null;
      return { start: marks[0].time, end: marks.at(-1).time, marks };
    },
  };
  // Unregistered on destroy, so a page that builds the app again holds no old layer; init
  // registers it again.
  let uncover = worldClock.register(clockSource);

  const methods = {
    init(viewer) {
      layerState._viewer = viewer;
      uncover ??= worldClock.register(clockSource);
      layerState._enabled = false;
      parts.panel.createMissionPanel();
      parts.overlays.createReplayVehicleOverlay();
      parts.rendering.attach(viewer);
      layerState._count = 0;
      layerState._lastUpdate = null;
      layerState._stale = false;
      layerState._lastError = null;
      layerState._orbitMatches = 0;
      parts.overlays.clearMissionOverlaySources();
      const input = inputFor(viewer);
      const overlayClicks = new WeakSet();
      const unsubscribeLabelClick = input.onOverlayClick((event) => {
        if (!missionsShown()) return false;
        const hit = overlayAt(event.screenPosition);
        if (!hit) return false;
        // Capture the painted hit before other handlers can invalidate the
        // overlay. An unrelated label keeps the click above mission geometry.
        overlayClicks.add(event);
        // The label is the card on top, so every other layer and the cockpit
        // leave its click alone. In the cockpit, which holds the camera, the
        // label and the dot select the mission without moving there.
        return focusLaunch(markerLaunchId(hit), { move: !cockpitActive() });
      });
      const unsubscribeClick = input.onClick((event) => {
        // Another layer's card or label on top is that layer's click, read
        // once per click as every layer reads it.
        if (
          !missionsShown() ||
          overlayClicks.has(event) ||
          services.picking?.clickCard?.(event)
        )
          return;
        focusLaunch(
          parts.rendering.launchIdFromPicks(
            parts.rendering.missionHitsAt(event.position, 12),
          ),
          { move: !cockpitActive() },
        );
      });
      hover = createLaunchHover({
        viewer,
        enabled: missionsShown,
        launchAt(position) {
          const hit = overlayAt(position);
          return hit
            ? Boolean(markerLaunchId(hit))
            : parts.rendering.launchMarkerAt(position);
        },
      });
      const unsubscribeHover = input.onPointer('move', hover.move);
      layerState._inputSubscription = () => {
        unsubscribeLabelClick();
        unsubscribeClick();
        unsubscribeHover();
      };
      // Apply horizon visibility before the renderer draws and picks.
      // A postRender write is one frame late and can remain visibly stale when
      // request-on-demand rendering stops after a globe camera move.
      layerState._declutterHandler =
        findFrame(viewer)?.on('preRender', () =>
          parts.rendering.updateMissionFrame(),
        ) ?? null;
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
      layerState.coverageChanged();
    },

    async _enableBody() {
      layerState._updateDirty = false;
      parts.rendering.showMissions(true);
      parts.orbitRendering.syncMissionOrbitPrimitiveVisibility();
      if (layerState._lastUpdate === null) {
        // A new attempt at an index that never loaded starts from loading.
        layerState._lastError = null;
        parts.panel.renderMissionRoster();
        // Kept until the mission index loads, so an entry that never does
        // gives the view back. A newer flight takes the camera and drops it.
        layerState._entryCameraView = captureCameraView(layerState._viewer);
        layerState._entryLandedView = null;
      }
      const token = layerState._lifecycleToken;
      const followed = isFollowing(layerState._viewer);
      if (followed) layerState._cameraReleased = true;
      const flying =
        !followed &&
        parts.selection.focusFullGlobe(layerState._viewer, {
          complete: () => {
            if (token === layerState._lifecycleToken)
              layerState._entryLandedView = captureCameraView(
                layerState._viewer,
              );
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
      await parts.ingestion.captureSatelliteDependency();
    },

    async disable() {
      hover?.reset();
      layerState._sourceController.abort();
      layerState._enabled = false;
      const entryView = layerState._entryCameraView;
      layerState._entryCameraView = null;
      if (entryView)
        restoreCameraView(
          layerState._viewer,
          entryView,
          layerState._entryLandedView,
        );
      releaseContinuousRender('rocket-launches');
      layerState._lifecycleToken++;
      layerState._updateDirty = false;
      parts.ingestion.clearPostTleRetry();
      parts.panel.clearMissionRosterHover();
      parts.replay.stopMissionReplay();
      layerState._cameraReleased = true;
      parts.selection.stopMissionZoomAnchor();
      parts.rendering.showMissions(false);
      parts.orbitRendering.syncMissionOrbitPrimitiveVisibility();
      const canvas = canvasOf(layerState._viewer);
      if (canvas) canvas.style.cursor = '';
      parts.launchPad.hideLaunchPadZone();
      parts.overlays.hideReplayVehicleOverlay();
      layerState._selectedLaunchId = null;
      parts.overlays.clearMissionOverlaySources();
      parts.panel.renderMissionPanel();
      await parts.ingestion.restoreSatelliteDependency();
      layerState.coverageChanged();
    },

    async destroy(viewer) {
      hover?.destroy();
      uncover?.();
      uncover = null;
      hover = null;
      layerState._sourceController.abort();
      releaseContinuousRender('rocket-launches'); // direct-destroy path (perf wave 2 fix)
      layerState._enabled = false;
      layerState._lifecycleToken++;
      layerState._updateDirty = false;
      // A failed Satellites restore still tears everything else down; the
      // failure is reported once teardown is complete.
      let restoreError = null;
      try {
        await parts.ingestion.restoreSatelliteDependency();
      } catch (error) {
        restoreError = error;
      }
      layerState._inputSubscription?.();
      layerState._inputSubscription = null;
      parts.satelliteIntents.connect(null);
      parts.panel.clearMissionRosterHover();
      parts.replay.stopMissionReplay();
      layerState._cameraReleased = true;
      parts.selection.stopMissionZoomAnchor();
      parts.ingestion.clearPostTleRetry();
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
      layerState._viewer = null;
      parts.rendering.detach();
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
      if (restoreError) throw restoreError;
    },
  };

  return { methods };
}
