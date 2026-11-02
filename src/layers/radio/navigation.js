import * as Cesium from 'cesium';
import {
  HORIZON_CAMERA_MOVE_EPSILON_M,
  GLOBAL_RADIO_ALTITUDE_M,
  RADIO_GLOBE_RECENTER_MAX_HEIGHT_M,
} from './policy.js';

export function createNavigation({
  state: layerState,
  services,
  parts,
  source,
}) {
  const {
    isFullGlobeInsideKeyhole,
    GLOBE_ENTER_CLEARANCE_PX,
    projectEarthDiscToViewport,
    earthDiscScreenRadius,
    getKeyholeGeometry,
  } = services.globe;

  /** Return whether camera translation materially changes horizon visibility. */

  function radioCameraPositionChanged(
    previous,
    current,
    epsilonM = HORIZON_CAMERA_MOVE_EPSILON_M,
  ) {
    if (!previous || !current) return true;
    const dx = Number(current.x) - Number(previous.x);
    const dy = Number(current.y) - Number(previous.y);
    const dz = Number(current.z) - Number(previous.z);
    if (![dx, dy, dz].every(Number.isFinite)) return true;
    const threshold = Math.max(0, Number(epsilonM) || 0);
    return dx * dx + dy * dy + dz * dz > threshold * threshold;
  }

  /** Classify a globe-scale Radio view without flapping on Cesium height round-off. */

  function radioViewIsGlobal(altitudeM) {
    return (
      Number.isFinite(altitudeM) &&
      Math.round(altitudeM) >= GLOBAL_RADIO_ALTITUDE_M
    );
  }

  /** Plan a station-centered camera move that preserves altitude and view angle. */

  function radioStationCameraPlan(station, cameraState = {}) {
    const targetLat = Number(station?.lat);
    const targetLon = Number(station?.lon);
    const height = Math.max(1, Number(cameraState.height) || 1);
    const heading = Number.isFinite(cameraState.heading)
      ? cameraState.heading
      : 0;
    const pitch = Number.isFinite(cameraState.pitch)
      ? cameraState.pitch
      : -Math.PI / 2;
    const roll = Number.isFinite(cameraState.roll) ? cameraState.roll : 0;
    if (!Number.isFinite(targetLat) || !Number.isFinite(targetLon)) return null;

    const downAngle = Math.min(
      Math.PI / 2,
      Math.max(0.08, Math.abs(Math.min(-0.001, pitch))),
    );
    const groundOffsetM =
      downAngle > Math.PI / 2 - 1e-6
        ? 0
        : Math.min(2_000_000, height / Math.max(0.08, Math.tan(downAngle)));
    const angularDistance = groundOffsetM / 6_378_137;
    const targetLatRad = (targetLat * Math.PI) / 180;
    const cameraBearing = heading + Math.PI;
    const cameraLatRad = Math.asin(
      Math.sin(targetLatRad) * Math.cos(angularDistance) +
        Math.cos(targetLatRad) *
          Math.sin(angularDistance) *
          Math.cos(cameraBearing),
    );
    const cameraLonRad =
      (targetLon * Math.PI) / 180 +
      Math.atan2(
        Math.sin(cameraBearing) *
          Math.sin(angularDistance) *
          Math.cos(targetLatRad),
        Math.cos(angularDistance) -
          Math.sin(targetLatRad) * Math.sin(cameraLatRad),
      );
    const cameraLon = (((cameraLonRad * 180) / Math.PI + 540) % 360) - 180;
    return {
      lat: (cameraLatRad * 180) / Math.PI,
      lon: cameraLon,
      height,
      heading,
      pitch,
      roll,
    };
  }

  /**
   * Decide whether Radio navigation should first restore a centered Earth view.
   * Fit-capable clipped discs and closer views whose optical center has reached
   * the Earth limb use the staged path; ordinary centered local views stay direct.
   */

  function radioGlobeNeedsRecentering(geometry) {
    if (!geometry || isFullGlobeInsideKeyhole(geometry, false)) return false;
    const centeredGeometry = {
      ...geometry,
      earthCenterX: geometry.keyholeCenterX,
      earthCenterY: geometry.keyholeCenterY,
    };
    if (isFullGlobeInsideKeyhole(centeredGeometry, false)) return true;
    const values = [
      geometry.earthCenterX,
      geometry.earthCenterY,
      geometry.earthRadius,
      geometry.keyholeCenterX,
      geometry.keyholeCenterY,
    ];
    if (!values.every(Number.isFinite) || geometry.earthRadius <= 0)
      return false;
    const centerOffset = Math.hypot(
      geometry.earthCenterX - geometry.keyholeCenterX,
      geometry.earthCenterY - geometry.keyholeCenterY,
    );
    return geometry.earthRadius - centerOffset < GLOBE_ENTER_CLEARANCE_PX;
  }

  /** Preserve closer zoom while capping an extreme full-globe recovery. */

  function radioGlobeRecenterHeight(currentHeight, fullGlobeCapable) {
    if (!Number.isFinite(currentHeight) || currentHeight < 0) return null;
    return fullGlobeCapable
      ? Math.min(currentHeight, RADIO_GLOBE_RECENTER_MAX_HEIGHT_M)
      : currentHeight;
  }

  function radioCameraState(camera = layerState._viewer?.camera) {
    if (!camera) return null;
    return {
      height: camera.positionCartographic?.height,
      heading: camera.heading,
      pitch: camera.pitch,
      roll: camera.roll,
    };
  }

  /** Radio may move the globe only while no tracked entity owns the follow camera. */

  function radioCameraNavigationAllowed(viewer = layerState._viewer) {
    return Boolean(viewer?.camera) && !viewer.trackedEntity;
  }

  function radioGlobeRecenterPlan(viewer = layerState._viewer) {
    const camera = viewer?.camera;
    const canvas = viewer?.scene?.canvas;
    const width = canvas?.clientWidth || canvas?.width;
    const height = canvas?.clientHeight || canvas?.height;
    const cartographic = camera?.positionCartographic;
    if (!camera || !cartographic || !(width > 0) || !(height > 0)) return null;
    const geometry = projectEarthDiscToViewport(
      viewer,
      width,
      height,
      layerState._radioEarthScreenCenter,
      layerState._radioEarthToCenter,
    );
    let fullGlobeCapable = false;
    if (geometry) {
      if (!radioGlobeNeedsRecentering(geometry)) return null;
      fullGlobeCapable = isFullGlobeInsideKeyhole(
        {
          ...geometry,
          earthCenterX: geometry.keyholeCenterX,
          earthCenterY: geometry.keyholeCenterY,
        },
        false,
      );
    } else {
      const earthRadius = earthDiscScreenRadius(
        Cesium.Cartesian3.magnitude(camera.positionWC),
        height,
        camera.frustum?.fovy,
      );
      const facingEarthCenter =
        Cesium.Cartesian3.dot(
          camera.directionWC,
          layerState._radioEarthToCenter,
        ) > 0;
      if (!earthRadius || facingEarthCenter) return null;
      const keyhole = getKeyholeGeometry(width, height);
      fullGlobeCapable =
        earthRadius + GLOBE_ENTER_CLEARANCE_PX <= keyhole.radius;
    }
    const recenterHeight = radioGlobeRecenterHeight(
      cartographic.height,
      fullGlobeCapable,
    );
    if (recenterHeight == null) return null;
    return {
      destination: Cesium.Cartesian3.fromRadians(
        cartographic.longitude,
        cartographic.latitude,
        recenterHeight,
      ),
      cameraState: {
        ...radioCameraState(camera),
        height: recenterHeight,
        heading: 0,
        pitch: -Cesium.Math.PI_OVER_TWO,
        roll: 0,
      },
    };
  }

  function radioCameraNavigationIsCurrent(navigation) {
    return Boolean(
      navigation &&
      navigation.generation === layerState._radioCameraNavigationGeneration &&
      layerState._enabled &&
      radioCameraNavigationAllowed(layerState._viewer),
    );
  }

  function cancelActiveRadioCameraFlight() {
    if (
      !layerState._activeRadioCameraFlight ||
      !radioCameraNavigationAllowed(layerState._viewer)
    )
      return;
    layerState._activeRadioCameraFlight = null;
    layerState._viewer.camera.cancelFlight();
  }

  function invalidateRadioCameraNavigation() {
    layerState._radioCameraNavigationGeneration += 1;
    cancelActiveRadioCameraFlight();
    layerState._activeRadioCameraFlight = null;
  }

  function radioCameraNavigationOwnsSelection(navigation, station) {
    return Boolean(
      navigation &&
      station &&
      navigation.generation === layerState._radioCameraNavigationGeneration &&
      navigation.target?.id === station.id,
    );
  }

  function startRadioCameraFlight(navigation, options, onComplete) {
    if (!radioCameraNavigationIsCurrent(navigation)) return false;
    const token = ++layerState._radioCameraFlightSequence;
    layerState._activeRadioCameraFlight = {
      generation: navigation.generation,
      token,
    };
    const finish = (completed) => {
      if (layerState._activeRadioCameraFlight?.token === token)
        layerState._activeRadioCameraFlight = null;
      if (completed && radioCameraNavigationIsCurrent(navigation))
        onComplete?.();
    };
    layerState._viewer.camera.flyTo({
      ...options,
      complete: () => finish(true),
      cancel: () => finish(false),
    });
    return true;
  }

  function focusRadioNavigationTarget(navigation) {
    if (!radioCameraNavigationIsCurrent(navigation) || !navigation.target)
      return false;
    const plan = radioStationCameraPlan(
      navigation.target,
      navigation.cameraState,
    );
    if (!plan) return false;
    navigation.phase = 'focusing';
    return startRadioCameraFlight(
      navigation,
      {
        destination: Cesium.Cartesian3.fromDegrees(
          plan.lon,
          plan.lat,
          plan.height,
        ),
        orientation: {
          heading: plan.heading,
          pitch: plan.pitch,
          roll: plan.roll,
        },
        duration: navigation.duration,
      },
      () => {
        navigation.phase = 'settled';
      },
    );
  }

  function beginRadioCameraNavigation(cameraState = null) {
    const generation = ++layerState._radioCameraNavigationGeneration;
    if (
      !radioCameraNavigationAllowed(layerState._viewer) ||
      !layerState._enabled
    )
      return null;
    cancelActiveRadioCameraFlight();
    const recenterPlan = radioGlobeRecenterPlan(layerState._viewer);
    return {
      generation,
      phase: 'idle',
      recentered: false,
      recenterPlan,
      cameraState:
        recenterPlan?.cameraState || cameraState || radioCameraState(),
      target: null,
      duration: 0.35,
    };
  }

  function rotateRadioStationIntoView(
    station,
    duration = 0.35,
    cameraState = null,
    navigation = null,
  ) {
    const activeNavigation =
      navigation || beginRadioCameraNavigation(cameraState);
    if (!station || !radioCameraNavigationIsCurrent(activeNavigation))
      return false;
    activeNavigation.target = station;
    activeNavigation.duration = duration;
    if (activeNavigation.phase === 'recentering') return true;
    if (activeNavigation.phase === 'focusing') cancelActiveRadioCameraFlight();
    if (activeNavigation.recenterPlan && !activeNavigation.recentered) {
      activeNavigation.phase = 'recentering';
      const recenterDuration = Math.min(0.9, Math.max(0.65, duration));
      return startRadioCameraFlight(
        activeNavigation,
        {
          destination: activeNavigation.recenterPlan.destination,
          orientation: {
            heading: activeNavigation.cameraState.heading,
            pitch: activeNavigation.cameraState.pitch,
            roll: activeNavigation.cameraState.roll,
          },
          duration: recenterDuration,
          easingFunction: Cesium.EasingFunction.CUBIC_IN_OUT,
        },
        () => {
          activeNavigation.recentered = true;
          activeNavigation.phase = 'idle';
          focusRadioNavigationTarget(activeNavigation);
        },
      );
    }
    return focusRadioNavigationTarget(activeNavigation);
  }

  function focusStation(station) {
    layerState._radioCameraNavigationGeneration += 1;
    if (!station || !radioCameraNavigationAllowed(layerState._viewer))
      return false;
    cancelActiveRadioCameraFlight();
    layerState._viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(
        station.lon,
        station.lat,
        85_000,
      ),
      duration: 1.1,
    });
    return true;
  }
  return {
    radioCameraPositionChanged,
    radioViewIsGlobal,
    radioStationCameraPlan,
    radioGlobeNeedsRecentering,
    radioGlobeRecenterHeight,
    radioCameraState,
    radioCameraNavigationAllowed,
    radioGlobeRecenterPlan,
    radioCameraNavigationIsCurrent,
    cancelActiveRadioCameraFlight,
    invalidateRadioCameraNavigation,
    radioCameraNavigationOwnsSelection,
    startRadioCameraFlight,
    focusRadioNavigationTarget,
    beginRadioCameraNavigation,
    rotateRadioStationIntoView,
    focusStation,
  };
}
