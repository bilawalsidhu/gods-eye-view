import { appClock } from '../../time/clock.js';
import * as geo from '../../geo/index.js';
import { MISSION_GLOBE_VIEW_RANGE_M, MISSION_FOCUS_RANGE_M } from './policy.js';

export function createSelection({
  state: layerState,
  services,
  parts,
  source,
  getRenderer,
}) {
  const { getKeyholeGeometry } = services.geometry;

  /** @returns {boolean} Whether the flight started. */
  function focusFullGlobe(engine, { duration = 2.4, complete, cancel } = {}) {
    const camera = engine?.camera;
    const { width, height } = engine?.host?.size() ?? {};
    const pose = camera?.pose();
    const cartographic = pose?.cartographic;
    const fovy = pose?.fovy;
    if (
      !(width > 0) ||
      !(height > 0) ||
      !cartographic ||
      !Number.isFinite(fovy) ||
      fovy <= 0 ||
      fovy >= Math.PI
    )
      return false;
    const earthRadius = geo.ellipsoid.WGS84.maximumRadius;
    const keyholeRadius = getKeyholeGeometry(width, height).radius;
    const targetScreenRadius = keyholeRadius * 0.61;
    const angularRadius = Math.atan(
      (targetScreenRadius / (height * 0.5)) * Math.tan(fovy * 0.5),
    );
    const distance = earthRadius / Math.max(Math.sin(angularRadius), 1e-4);
    const altitude = Math.max(earthRadius * 1.55, distance - earthRadius);
    layerState._cameraReleased = false;
    camera.flyTo({
      destination: geo.cartesian3.fromRadians(
        cartographic.longitude,
        cartographic.latitude,
        altitude,
      ),
      orientation: {
        heading: pose.heading,
        pitch: -geo.math.PI_OVER_TWO,
        roll: 0,
      },
      duration,
      easing: 'cubicInOut',
      complete,
      cancel,
    });
    return true;
  }

  /** The mission a pick id (`rocket-<kind>:<launch id>…`) belongs to. */
  function entityLaunchId(id) {
    if (!id || typeof id !== 'string') return null;
    const match = id.match(/^rocket-[^:]+:([^:]+)/);
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
    if (layerState._missionFocusIntentId !== launchId)
      layerState._missionFocusIntentId = null;
    layerState._selectedLaunchId = launchId;
    layerState._explicitSelection = Boolean(launchId && isolate);
    if (launchId) layerState._animationStarts.set(launchId, appClock.now());
    if (!launchId && layerState._engine) stopMissionZoomAnchor();
    showSelectedMission();
  }

  function showSelectedMission() {
    if (!getRenderer()) return;
    const launchId = layerState._selectedLaunchId;
    for (const element of layerState._missionElements.values())
      parts.rendering.setElementShown(
        element,
        launchId
          ? element.launchId === launchId
          : element.id.startsWith('rocket-launch:'),
      );
    parts.orbitRendering.syncMissionOrbitPrimitiveVisibility();
    parts.overlays.syncMissionOverlayEntries();
    parts.panel.renderMissionPanel();
  }

  function stopMissionZoomAnchor() {
    if (layerState._missionZoomAnchorRemover)
      layerState._missionZoomAnchorRemover();
    layerState._missionZoomAnchorRemover = null;
    layerState._missionZoomAnchorId = null;
    if (layerState._engine && !layerState._replayCameraLaunchId)
      layerState._engine.camera.release();
  }

  function startMissionZoomAnchor(
    launch,
    initialRange,
    { resuming = false } = {},
  ) {
    if (!layerState._engine || !launch || layerState._replayCameraLaunchId)
      return;
    stopMissionZoomAnchor();
    const target = geo.cartesian3.fromDegrees(launch.lon, launch.lat);
    const range = Math.max(
      2000,
      Number(initialRange) || MISSION_GLOBE_VIEW_RANGE_M,
    );
    layerState._missionZoomAnchorId = launch.id;
    layerState._missionZoomRange = range;
    if (resuming) {
      layerState._engine.camera.lookAtTransform(
        geo.transforms.eastNorthUpToFixedFrame(target),
      );
      return;
    }
    layerState._engine.camera.lookAt(target, {
      heading: 0,
      pitch: parts.camera.missionZoomPitch(range),
      range,
    });
  }

  function focusMission(launch) {
    const engine = layerState._engine;
    if (!engine || !launch) return;
    stopMissionZoomAnchor();
    layerState._missionFocusIntentId = launch.id;
    const orbitPositions = layerState._missionElements.get(
      `rocket-orbit:${launch.id}`,
    )?.positions;
    const launchPosition = geo.cartesian3.fromDegrees(launch.lon, launch.lat);
    let range = 18000000;
    if (orbitPositions?.length > 1) {
      const size = engine.host.size();
      const fovy = engine.camera.pose().fovy || geo.math.toRadians(60);
      const aspect = Math.max(0.1, size.width / Math.max(1, size.height));
      const fovx = 2 * Math.atan(Math.tan(fovy * 0.5) * aspect);
      const paddedHalfAngle = Math.min(fovy, fovx) * 0.5 * 0.62;
      const orbitExtent = orbitPositions.reduce(
        (largest, point) =>
          Math.max(largest, geo.cartesian3.distance(launchPosition, point)),
        0,
      );
      range = Math.max(
        orbitExtent / Math.max(Math.sin(paddedHalfAngle), 0.1),
        18000000,
      );
    }
    const targetNormal = geo.cartesian3.normalize(
      launchPosition,
      geo.cartesian3.create(),
    );
    const destination = geo.cartesian3.add(
      launchPosition,
      geo.cartesian3.multiplyByScalar(
        targetNormal,
        range,
        geo.cartesian3.create(),
      ),
      geo.cartesian3.create(),
    );
    const direction = geo.cartesian3.negate(
      targetNormal,
      geo.cartesian3.create(),
    );
    let right = geo.cartesian3.cross(
      direction,
      geo.cartesian3.UNIT_Z,
      geo.cartesian3.create(),
    );
    if (geo.cartesian3.magnitudeSquared(right) < 1e-8) {
      right = geo.cartesian3.cross(direction, geo.cartesian3.UNIT_Y, right);
    }
    geo.cartesian3.normalize(right, right);
    const up = geo.cartesian3.normalize(
      geo.cartesian3.cross(right, direction, geo.cartesian3.create()),
      geo.cartesian3.create(),
    );
    layerState._cameraReleased = false;
    // Without an easing: the engine's own for the flight's heights.
    engine.camera.flyTo({
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
    if (!layerState._engine || !launch) return;
    parts.replay.stopMissionReplay();
    layerState._missionFocusIntentId = null;
    stopMissionZoomAnchor();
    const launchPosition = geo.cartesian3.fromDegrees(launch.lon, launch.lat);
    layerState._cameraReleased = false;
    layerState._engine.camera.flyToSphere(
      geo.boundingSphere.create(launchPosition, 0),
      {
        heading: 0,
        pitch: geo.math.toRadians(-42),
        range: MISSION_FOCUS_RANGE_M,
        duration: 1.4,
        easing: 'cubicInOut',
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
    showSelectedMission,
    stopMissionZoomAnchor,
    startMissionZoomAnchor,
    focusMission,
    focusLaunchSite,
  };
}
