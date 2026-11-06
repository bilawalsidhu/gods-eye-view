import * as geo from '../../geo/index.js';
import { createPolicyHelpers } from './policyHelpers.js';
import { createIngestion } from './ingestion.js';
import { createOrbitRendering } from './orbitRendering.js';
import { createOverlays } from './overlays.js';
import { createSelection } from './selection.js';
import { createReplay } from './replay.js';
import { createPanel } from './panel.js';
import { createPaths } from './paths.js';
import { createLaunchPad } from './launchPad.js';
import { createCamera } from './camera.js';
import { createModel } from './model.js';
import { createRendering } from './rendering.js';
import { createTesting } from './testing.js';
import { createControls } from './controls.js';
import { createLifecycle } from './lifecycle.js';
import { createState } from './state.js';

/** Construct one layer with its own scene state and supplied application services. */
export function createRocketLaunchesLayer({ services, source }) {
  if (typeof source?.getLaunches !== 'function')
    throw new TypeError('A launches source is required');
  const state = createState({ services });
  const parts = {};
  // The display the layer draws through (render/display.js), while attached.
  const getRenderer = () => state._renderer;
  const context = { state, services, parts, source, getRenderer };
  parts.policyHelpers = createPolicyHelpers(context);
  parts.ingestion = createIngestion(context);
  parts.orbitRendering = createOrbitRendering(context);
  parts.overlays = createOverlays(context);
  parts.selection = createSelection(context);
  parts.replay = createReplay(context);
  parts.panel = createPanel(context);
  parts.paths = createPaths(context);
  parts.launchPad = createLaunchPad(context);
  parts.camera = createCamera(context);
  parts.model = createModel(context);
  parts.rendering = createRendering(context);
  parts.testing = createTesting(context);
  parts.controls = createControls(context);
  parts.lifecycle = createLifecycle(context);
  return Object.assign(
    {},
    parts.controls.methods,
    parts.lifecycle.methods,
    parts.ingestion.methods,
    parts.panel.commands,
    {
      qaDrawn() {
        const display = state._renderer;
        if (!display) return null;
        const elements = [...state._missionElements.values()];
        const plain = (p) => (p ? { x: p.x, y: p.y, z: p.z } : null);
        const anchors = (positions) =>
          !positions?.length
            ? []
            : Array.from({ length: 8 }, (_, i) =>
                plain(positions[Math.floor((i * (positions.length - 1)) / 8)]),
              );
        const track = state._replayTracks.get(state._selectedLaunchId);
        const frame = track?.getReplayState();
        return {
          enabled: state._enabled,
          selected: state._selectedLaunchId,
          speed: state._replaySpeed,
          paused: state._replayPaused,
          records: state._launches.map((l) => ({
            id: l.id,
            name: l.name,
            longitude: l.lon,
            latitude: l.lat,
            orbit: l.orbit?.name,
          })),
          points: elements
            .filter((e) => e.point && e.position)
            .map((e) => {
              const color = e.pointStyle.color;
              return {
                id: e.id,
                position: plain(parts.rendering.elementPosition(e)),
                show: display.visible() && e.point.show,
                size: e.pointStyle.pixelSize,
                color: color
                  ? [color.red, color.green, color.blue, color.alpha]
                  : null,
              };
            }),
          paths: elements
            .filter((e) => e.line)
            .map((e) => ({
              id: e.id,
              show: display.visible() && e.line.show,
              anchors: anchors(e.positions),
            })),
          rings: [...state._missionOrbitPrimitives].map(([id, path]) => ({
            id,
            show: display.visible() && path.line.show,
            anchors: anchors(path.basePositions).map((p) =>
              plain(
                geo.matrix4.multiplyByPoint(
                  path.modelMatrix,
                  p,
                  geo.cartesian3.create(),
                ),
              ),
            ),
          })),
          replay: frame
            ? {
                ...frame,
                active: state._replayCameraLaunchId === state._selectedLaunchId,
                ascentDurationSec: track.ascentDurationSec,
                position: plain(
                  parts.paths.samplePath(
                    frame.ascending
                      ? track.ascentPath
                      : track.animatedOrbitPath,
                    frame.phaseProgress,
                  ),
                ),
              }
            : null,
          padVisible: state._launchPadZonePrimitive?.show === true,
          padHeightM: state._launchPadZonePrimitive?.heightM ?? null,
        };
      },
      subscribePanel: parts.panel.subscribePanel,
      subscribeReplayOverlay: parts.overlays.subscribeReplayOverlay,
      satelliteParamsForSpaceMissions:
        parts.policyHelpers.satelliteParamsForSpaceMissions,
      satelliteParamsAfterSpaceMissions:
        parts.policyHelpers.satelliteParamsAfterSpaceMissions,
      launchStatusAllowsOrbit: parts.policyHelpers.launchStatusAllowsOrbit,
      missionPathPresentation: parts.policyHelpers.missionPathPresentation,
      shouldRetryAfterActiveTle: parts.ingestion.shouldRetryAfterActiveTle,
      releaseAircraftTracking: parts.policyHelpers.releaseAircraftTracking,
      launchPadZoneVisible: parts.policyHelpers.launchPadZoneVisible,
      missionAnchorHorizonVisible: parts.overlays.missionAnchorHorizonVisible,
      missionAnchorVisible: parts.overlays.missionAnchorVisible,
      compactLaunchSiteName: parts.overlays.compactLaunchSiteName,
      createRocketMissionMarkerOverlayEntry:
        parts.overlays.createRocketMissionMarkerOverlayEntry,
      createRocketMissionElementOverlayEntry:
        parts.overlays.createRocketMissionElementOverlayEntry,
      selectRocketMissionMarkerOverlayCohort:
        parts.overlays.selectRocketMissionMarkerOverlayCohort,
      replayOverlayMode: parts.overlays.replayOverlayMode,
      replayVehicleScreenRotation: parts.replay.replayVehicleScreenRotation,
      smoothReplayWindowPosition: parts.replay.smoothReplayWindowPosition,
      missionDataCompleteness: parts.policyHelpers.missionDataCompleteness,
      missionRosterEntries: parts.policyHelpers.missionRosterEntries,
      missionHoverPreviewRange: parts.panel.missionHoverPreviewRange,
      createMissionRosterPreviewOwnership:
        parts.panel.createMissionRosterPreviewOwnership,
      resolveMissionRosterPreviewLaunch:
        parts.panel.resolveMissionRosterPreviewLaunch,
      formatMissionEventTime: parts.policyHelpers.formatMissionEventTime,
      parseMissionDurationSeconds:
        parts.policyHelpers.parseMissionDurationSeconds,
      replayAscentDurationSeconds: parts.replay.replayAscentDurationSeconds,
      normalizeReplaySpeed: parts.replay.normalizeReplaySpeed,
      replayStartAfterPause: parts.replay.replayStartAfterPause,
      replayState: parts.replay.replayState,
      approximateOrbitPath: parts.paths.approximateOrbitPath,
      samplePath: parts.paths.samplePath,
      orbitProgressAtTime: parts.paths.orbitProgressAtTime,
      reconstructedAscentPath: parts.paths.reconstructedAscentPath,
      buildMissionPaths: parts.paths.buildMissionPaths,
      cameraHeadingForPath: parts.camera.cameraHeadingForPath,
      replayInitialCameraHeading: parts.camera.replayInitialCameraHeading,
      replayChaseCameraHeading: parts.camera.replayChaseCameraHeading,
      smoothReplayCameraHeading: parts.camera.smoothReplayCameraHeading,
      missionZoomPitch: parts.camera.missionZoomPitch,
      replayCameraView: parts.camera.replayCameraView,
      replayOrbitGlobeAnchor: parts.camera.replayOrbitGlobeAnchor,
      replayOrbitCameraTarget: parts.camera.replayOrbitCameraTarget,
      replayOrbitCameraPose: parts.camera.replayOrbitCameraPose,
      replayOrbitFrameSphere: parts.camera.replayOrbitFrameSphere,
      replayOrbitGlobeRange: parts.camera.replayOrbitGlobeRange,
      missionMarkerColor: parts.model.missionMarkerColor,
      normalizeRocketLaunches: parts.model.normalizeRocketLaunches,
      _setRocketMissionOverlayHostForTest:
        parts.testing._setRocketMissionOverlayHostForTest,
      _setSelectedRocketMissionForTest:
        parts.testing._setSelectedRocketMissionForTest,
      _missionElementForTest: parts.testing._missionElementForTest,
    },
  );
}
export {
  ROCKET_MISSION_AMBIENT_OVERLAY_SOURCE_ID,
  ROCKET_MISSION_SELECTED_OVERLAY_SOURCE_ID,
  ROCKET_MISSION_AMBIENT_OVERLAY_COHORT_LIMIT,
  ROCKET_MISSION_AMBIENT_OVERLAY_COLLISION_CAPACITY,
  ROCKET_MISSION_SELECTED_OVERLAY_SOURCE_OPTIONS,
  LAUNCH_PAD_ZONE_RADIUS_M,
} from './policy.js';
export { createLaunchSource } from './source.js';
