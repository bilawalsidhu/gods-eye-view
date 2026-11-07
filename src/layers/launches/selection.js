import { WGS84, fromDegrees } from '../../geo/ellipsoid.js';
import {
  PI_OVER_TWO,
  add,
  cross,
  distance,
  dot,
  negate,
  normalize,
  scale,
  toRadians,
  vec,
} from '../../geo/vector.js';
import { MISSION_GLOBE_VIEW_RANGE_M, MISSION_FOCUS_RANGE_M } from './policy.js';
import { cameraOf, findCamera } from '../../render/rendererOf.js';

export function createSelection({
  state: layerState,
  services,
  parts,
  source,
}) {
  const { getKeyholeGeometry } = services.geometry;

  function focusFullGlobe(viewer, duration = 2.4) {
    const canvas = viewer?.scene?.canvas;
    const height = canvas?.clientHeight || canvas?.height;
    const width = canvas?.clientWidth || canvas?.width;
    if (!(width > 0) || !(height > 0)) return;
    const pose = findCamera(viewer)?.pose();
    const fovy = pose?.fovy;
    if (
      !pose ||
      !Number.isFinite(pose.lon) ||
      !Number.isFinite(fovy) ||
      fovy <= 0 ||
      fovy >= Math.PI
    )
      return;
    const earthRadius = WGS84.radii.x;
    const keyholeRadius = getKeyholeGeometry(width, height).radius;
    const targetScreenRadius = keyholeRadius * 0.61;
    const angularRadius = Math.atan(
      (targetScreenRadius / (height * 0.5)) * Math.tan(fovy * 0.5),
    );
    const distance = earthRadius / Math.max(Math.sin(angularRadius), 1e-4);
    const altitude = Math.max(earthRadius * 1.55, distance - earthRadius);
    const camera = cameraOf(viewer);
    camera.flyTo(
      { lon: pose.lon, lat: pose.lat, height: altitude },
      {
        orientation: {
          heading: pose.heading,
          pitch: -PI_OVER_TWO,
          roll: 0,
        },
        durationS: duration,
        easing: 'cubicInOut',
      },
    );
  }

  function entityLaunchId(entity) {
    if (!entity?.id || typeof entity.id !== 'string') return null;
    const match = entity.id.match(/^rocket-[^:]+:([^:]+)/);
    return match?.[1] || null;
  }

  function setSelectedMission(launchId, isolate = true) {
    if (launchId) parts.panel.clearMissionRosterHover();
    if (
      layerState._replayCameraLaunchId &&
      layerState._replayCameraLaunchId !== launchId
    )
      parts.replay.stopMissionReplay();
    if (
      layerState._missionZoomAnchorId &&
      layerState._missionZoomAnchorId !== launchId
    )
      stopMissionZoomAnchor();
    layerState._selectedLaunchId = launchId;
    layerState._explicitSelection = Boolean(launchId && isolate);
    if (launchId) layerState._animationStarts.set(launchId, Date.now());
    if (!launchId && layerState._viewer) {
      stopMissionZoomAnchor();
      parts.rendering.selectLaunchEntity(null);
    }
    if (!layerState._dataSource) return;
    parts.rendering.isolateMission(launchId);
    parts.orbitRendering.syncMissionOrbitPrimitiveVisibility();
    parts.overlays.syncMissionOverlayEntries();
    parts.panel.renderMissionPanel();
  }

  function stopMissionZoomAnchor() {
    if (layerState._missionZoomAnchorRemover)
      layerState._missionZoomAnchorRemover();
    layerState._missionZoomAnchorRemover = null;
    layerState._missionZoomAnchorId = null;
    if (!layerState._replayCameraLaunchId)
      findCamera(layerState._viewer)?.release();
  }

  function startMissionZoomAnchor(launch, initialRange) {
    if (!layerState._viewer || !launch || layerState._replayCameraLaunchId)
      return;
    stopMissionZoomAnchor();
    const target = fromDegrees(launch.lon, launch.lat);
    const range = Math.max(
      2000,
      Number(initialRange) || MISSION_GLOBE_VIEW_RANGE_M,
    );
    layerState._missionZoomAnchorId = launch.id;
    cameraOf(layerState._viewer).lookAt(target, {
      heading: 0,
      pitch: parts.camera.missionZoomPitch(range),
      range,
    });
  }

  function focusMission(launch) {
    if (!layerState._viewer || !launch) return;
    stopMissionZoomAnchor();
    parts.rendering.selectLaunchEntity(launch.id);
    const camera = cameraOf(layerState._viewer);
    const orbitPositions = parts.rendering.projectedOrbitPath(launch.id);
    const launchPosition = fromDegrees(launch.lon, launch.lat);
    let range = 18000000;
    if (orbitPositions?.length > 1) {
      const canvas = layerState._viewer.scene.canvas;
      const fovy = camera.pose().fovy || toRadians(60);
      const aspect = Math.max(
        0.1,
        (canvas.clientWidth || canvas.width) /
          Math.max(1, canvas.clientHeight || canvas.height),
      );
      const fovx = 2 * Math.atan(Math.tan(fovy * 0.5) * aspect);
      const paddedHalfAngle = Math.min(fovy, fovx) * 0.5 * 0.62;
      const orbitExtent = orbitPositions.reduce(
        (largest, point) => Math.max(largest, distance(launchPosition, point)),
        0,
      );
      range = Math.max(
        orbitExtent / Math.max(Math.sin(paddedHalfAngle), 0.1),
        18000000,
      );
    }
    const targetNormal = normalize(launchPosition);
    const destination = add(launchPosition, scale(targetNormal, range));
    const direction = negate(targetNormal);
    let right = cross(direction, vec(0, 0, 1));
    if (dot(right, right) < 1e-8) right = cross(direction, vec(0, 1, 0));
    right = normalize(right);
    const up = normalize(cross(right, direction));
    camera.flyTo(destination, {
      orientation: { direction, up },
      durationS: 1.1,
      onComplete: () => {
        if (layerState._selectedLaunchId === launch.id)
          startMissionZoomAnchor(launch, range);
      },
    });
  }

  function focusLaunchSite(launch) {
    if (!layerState._viewer || !launch) return;
    parts.replay.stopMissionReplay();
    stopMissionZoomAnchor();
    parts.rendering.selectLaunchEntity(launch.id);
    cameraOf(layerState._viewer).flyToBounds(
      { center: { lon: launch.lon, lat: launch.lat }, radius: 0 },
      {
        offset: {
          heading: 0,
          pitch: toRadians(-42),
          range: MISSION_FOCUS_RANGE_M,
        },
        durationS: 1.4,
        easing: 'cubicInOut',
        onComplete: () => {
          if (layerState._selectedLaunchId === launch.id) {
            startMissionZoomAnchor(launch, MISSION_FOCUS_RANGE_M);
          }
        },
      },
    );
  }
  return {
    focusFullGlobe,
    entityLaunchId,
    setSelectedMission,
    stopMissionZoomAnchor,
    startMissionZoomAnchor,
    focusMission,
    focusLaunchSite,
  };
}
