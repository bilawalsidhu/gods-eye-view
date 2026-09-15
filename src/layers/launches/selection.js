import * as Cesium from 'cesium';
import { MISSION_GLOBE_VIEW_RANGE_M, MISSION_FOCUS_RANGE_M } from './policy.js';

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
    const cartographic = viewer?.camera?.positionCartographic;
    const fovy = viewer?.camera?.frustum?.fovy;
    if (
      !(width > 0) ||
      !(height > 0) ||
      !cartographic ||
      !Number.isFinite(fovy) ||
      fovy <= 0 ||
      fovy >= Math.PI
    )
      return;
    const earthRadius = Cesium.Ellipsoid.WGS84.maximumRadius;
    const keyholeRadius = getKeyholeGeometry(width, height).radius;
    const targetScreenRadius = keyholeRadius * 0.61;
    const angularRadius = Math.atan(
      (targetScreenRadius / (height * 0.5)) * Math.tan(fovy * 0.5),
    );
    const distance = earthRadius / Math.max(Math.sin(angularRadius), 1e-4);
    const altitude = Math.max(earthRadius * 1.55, distance - earthRadius);
    viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromRadians(
        cartographic.longitude,
        cartographic.latitude,
        altitude,
      ),
      orientation: {
        heading: viewer.camera.heading,
        pitch: -Cesium.Math.PI_OVER_TWO,
        roll: 0,
      },
      duration,
      easingFunction: Cesium.EasingFunction.CUBIC_IN_OUT,
    });
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
      layerState._viewer.selectedEntity = undefined;
    }
    if (!layerState._dataSource) return;
    for (const entity of layerState._dataSource.entities.values) {
      const relatedId = entityLaunchId(entity);
      entity.show = launchId
        ? relatedId === launchId
        : entity.id.startsWith('rocket-launch:');
    }
    parts.orbitRendering.syncMissionOrbitPrimitiveVisibility();
    parts.overlays.syncMissionOverlayEntries();
    parts.panel.renderMissionPanel();
  }

  function stopMissionZoomAnchor() {
    if (layerState._missionZoomAnchorRemover)
      layerState._missionZoomAnchorRemover();
    layerState._missionZoomAnchorRemover = null;
    layerState._missionZoomAnchorId = null;
    if (layerState._viewer?.camera && !layerState._replayCameraLaunchId) {
      layerState._viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
    }
  }

  function startMissionZoomAnchor(launch, initialRange) {
    if (!layerState._viewer || !launch || layerState._replayCameraLaunchId)
      return;
    stopMissionZoomAnchor();
    const target = Cesium.Cartesian3.fromDegrees(launch.lon, launch.lat);
    const range = Math.max(
      2000,
      Number(initialRange) || MISSION_GLOBE_VIEW_RANGE_M,
    );
    layerState._missionZoomAnchorId = launch.id;
    layerState._viewer.camera.lookAt(
      target,
      new Cesium.HeadingPitchRange(
        0,
        parts.camera.missionZoomPitch(range),
        range,
      ),
    );
  }

  function focusMission(launch) {
    if (!layerState._viewer || !launch) return;
    stopMissionZoomAnchor();
    layerState._viewer.selectedEntity = layerState._dataSource.entities.getById(
      `rocket-launch:${launch.id}`,
    );
    const orbitEntity = layerState._dataSource.entities.getById(
      `rocket-orbit:${launch.id}`,
    );
    const orbitPositions = orbitEntity?.polyline?.positions?.getValue(
      Cesium.JulianDate.now(),
    );
    const launchPosition = Cesium.Cartesian3.fromDegrees(
      launch.lon,
      launch.lat,
    );
    let range = 18000000;
    if (orbitPositions?.length > 1) {
      const canvas = layerState._viewer.scene.canvas;
      const fovy =
        layerState._viewer.camera.frustum?.fovy || Cesium.Math.toRadians(60);
      const aspect = Math.max(
        0.1,
        (canvas.clientWidth || canvas.width) /
          Math.max(1, canvas.clientHeight || canvas.height),
      );
      const fovx = 2 * Math.atan(Math.tan(fovy * 0.5) * aspect);
      const paddedHalfAngle = Math.min(fovy, fovx) * 0.5 * 0.62;
      const orbitExtent = orbitPositions.reduce(
        (largest, point) =>
          Math.max(largest, Cesium.Cartesian3.distance(launchPosition, point)),
        0,
      );
      range = Math.max(
        orbitExtent / Math.max(Math.sin(paddedHalfAngle), 0.1),
        18000000,
      );
    }
    const targetNormal = Cesium.Cartesian3.normalize(
      launchPosition,
      new Cesium.Cartesian3(),
    );
    const destination = Cesium.Cartesian3.add(
      launchPosition,
      Cesium.Cartesian3.multiplyByScalar(
        targetNormal,
        range,
        new Cesium.Cartesian3(),
      ),
      new Cesium.Cartesian3(),
    );
    const direction = Cesium.Cartesian3.negate(
      targetNormal,
      new Cesium.Cartesian3(),
    );
    let right = Cesium.Cartesian3.cross(
      direction,
      Cesium.Cartesian3.UNIT_Z,
      new Cesium.Cartesian3(),
    );
    if (Cesium.Cartesian3.magnitudeSquared(right) < 1e-8) {
      right = Cesium.Cartesian3.cross(
        direction,
        Cesium.Cartesian3.UNIT_Y,
        right,
      );
    }
    Cesium.Cartesian3.normalize(right, right);
    const up = Cesium.Cartesian3.normalize(
      Cesium.Cartesian3.cross(right, direction, new Cesium.Cartesian3()),
      new Cesium.Cartesian3(),
    );
    layerState._viewer.camera.flyTo({
      destination,
      orientation: { direction, up },
      duration: 1.1,
      complete: () => {
        if (layerState._selectedLaunchId === launch.id)
          startMissionZoomAnchor(launch, range);
      },
    });
  }

  function focusLaunchSite(launch) {
    if (!layerState._viewer || !launch) return;
    parts.replay.stopMissionReplay();
    stopMissionZoomAnchor();
    const launchPosition = Cesium.Cartesian3.fromDegrees(
      launch.lon,
      launch.lat,
    );
    layerState._viewer.selectedEntity = layerState._dataSource.entities.getById(
      `rocket-launch:${launch.id}`,
    );
    layerState._viewer.camera.flyToBoundingSphere(
      new Cesium.BoundingSphere(launchPosition, 0),
      {
        offset: new Cesium.HeadingPitchRange(
          0,
          Cesium.Math.toRadians(-42),
          MISSION_FOCUS_RANGE_M,
        ),
        duration: 1.4,
        easingFunction: Cesium.EasingFunction.CUBIC_IN_OUT,
        complete: () => {
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
