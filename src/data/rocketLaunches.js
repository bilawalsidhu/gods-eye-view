import { createApplicationLaunches } from '../app/layers/rocketLaunches.js';
import { createSourceSlot } from '../sources/sourceSlot.js';
import { createLaunchSource } from '../layers/launches/index.js';
import * as satellites from './satellites.js';

const sourceSlot = createSourceSlot(
  createLaunchSource(),
  ['getLaunches', 'getActiveTle'],
  'Launch source',
);
export const configureLaunchSource = sourceSlot.configure;
const layer = createApplicationLaunches({
  source: sourceSlot.source,
  satellites,
});
export const satelliteParamsForSpaceMissions =
  layer.satelliteParamsForSpaceMissions;
export const satelliteParamsAfterSpaceMissions =
  layer.satelliteParamsAfterSpaceMissions;
export const launchStatusAllowsOrbit = layer.launchStatusAllowsOrbit;
export const missionPathPresentation = layer.missionPathPresentation;
export const shouldRetryAfterActiveTle = layer.shouldRetryAfterActiveTle;
export const releaseAircraftTracking = layer.releaseAircraftTracking;
export const launchPadZoneVisible = layer.launchPadZoneVisible;
export const missionAnchorHorizonVisible = layer.missionAnchorHorizonVisible;
export const missionAnchorVisible = layer.missionAnchorVisible;
export const compactLaunchSiteName = layer.compactLaunchSiteName;
export const createRocketMissionMarkerOverlayEntry =
  layer.createRocketMissionMarkerOverlayEntry;
export const createRocketMissionElementOverlayEntry =
  layer.createRocketMissionElementOverlayEntry;
export const selectRocketMissionMarkerOverlayCohort =
  layer.selectRocketMissionMarkerOverlayCohort;
export const replayOverlayMode = layer.replayOverlayMode;
export const replayVehicleScreenRotation = layer.replayVehicleScreenRotation;
export const smoothReplayWindowPosition = layer.smoothReplayWindowPosition;
export const missionDataCompleteness = layer.missionDataCompleteness;
export const missionRosterEntries = layer.missionRosterEntries;
export const missionHoverPreviewRange = layer.missionHoverPreviewRange;
export const createMissionRosterPreviewOwnership =
  layer.createMissionRosterPreviewOwnership;
export const bindMissionRosterItemKeyboardPreview =
  layer.bindMissionRosterItemKeyboardPreview;
export const captureMissionRosterFocus = layer.captureMissionRosterFocus;
export const restoreMissionRosterFocus = layer.restoreMissionRosterFocus;
export const resolveMissionRosterPreviewLaunch =
  layer.resolveMissionRosterPreviewLaunch;
export const formatMissionEventTime = layer.formatMissionEventTime;
export const parseMissionDurationSeconds = layer.parseMissionDurationSeconds;
export const replayAscentDurationSeconds = layer.replayAscentDurationSeconds;
export const normalizeReplaySpeed = layer.normalizeReplaySpeed;
export const replayStartAfterPause = layer.replayStartAfterPause;
export const replayState = layer.replayState;
export const approximateOrbitPath = layer.approximateOrbitPath;
export const samplePath = layer.samplePath;
export const orbitProgressAtTime = layer.orbitProgressAtTime;
export const reconstructedAscentPath = layer.reconstructedAscentPath;
export const buildMissionPaths = layer.buildMissionPaths;
export const cameraHeadingForPath = layer.cameraHeadingForPath;
export const replayInitialCameraHeading = layer.replayInitialCameraHeading;
export const replayChaseCameraHeading = layer.replayChaseCameraHeading;
export const smoothReplayCameraHeading = layer.smoothReplayCameraHeading;
export const missionZoomPitch = layer.missionZoomPitch;
export const replayCameraView = layer.replayCameraView;
export const replayOrbitGlobeAnchor = layer.replayOrbitGlobeAnchor;
export const replayOrbitCameraTarget = layer.replayOrbitCameraTarget;
export const replayOrbitCameraPose = layer.replayOrbitCameraPose;
export const replayOrbitFrameSphere = layer.replayOrbitFrameSphere;
export const replayOrbitGlobeRange = layer.replayOrbitGlobeRange;
export const missionMarkerColor = layer.missionMarkerColor;
export const normalizeRocketLaunches = layer.normalizeRocketLaunches;
export const _setRocketMissionOverlayHostForTest =
  layer._setRocketMissionOverlayHostForTest;
export const _setSelectedRocketMissionForTest =
  layer._setSelectedRocketMissionForTest;
export {
  ROCKET_MISSION_AMBIENT_OVERLAY_SOURCE_ID,
  ROCKET_MISSION_SELECTED_OVERLAY_SOURCE_ID,
  ROCKET_MISSION_AMBIENT_OVERLAY_COHORT_LIMIT,
  ROCKET_MISSION_AMBIENT_OVERLAY_COLLISION_CAPACITY,
  ROCKET_MISSION_SELECTED_OVERLAY_SOURCE_OPTIONS,
  LAUNCH_PAD_ZONE_RADIUS_M,
} from '../layers/launches/index.js';
export default layer;
