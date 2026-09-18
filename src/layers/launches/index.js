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
  const context = { state, services, parts, source };
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
    {
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
      bindMissionRosterItemKeyboardPreview:
        parts.panel.bindMissionRosterItemKeyboardPreview,
      captureMissionRosterFocus: parts.panel.captureMissionRosterFocus,
      restoreMissionRosterFocus: parts.panel.restoreMissionRosterFocus,
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
