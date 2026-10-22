import * as geo from '../../geo/index.js';
import {
  REPLAY_ASCENT_CAMERA_OFFSET_RAD,
  REPLAY_ORBIT_CAMERA_OFFSET_RAD,
  MISSION_CLOSE_VIEW_RANGE_M,
  MISSION_GLOBE_VIEW_RANGE_M,
  REPLAY_INITIAL_RANGE_M,
  REPLAY_LOCAL_MAX_RANGE_M,
  REPLAY_CONTEXT_ALTITUDE_END_M,
  REPLAY_CONTEXT_MAX_RANGE_M,
  REPLAY_ORBIT_PULLBACK_FRACTION,
  REPLAY_ORBIT_GLOBE_RANGE_M,
  REPLAY_ORBIT_FRAME_CENTER_BLEND,
} from './policy.js';

export function createCamera({
  state: layerState,
  services,
  parts,
  source,
  getRenderer,
}) {
  function cameraHeadingForPath(path, progress, fallback = Math.PI) {
    if (!path?.length) return fallback;
    const current = parts.paths.samplePath(path, progress);
    const currentCartographic =
      geo.ellipsoid.WGS84.cartesianToCartographic(current);
    if (!currentCartographic) return fallback;
    for (const step of [0.01, 0.025, 0.05, 0.1, 0.2]) {
      const next = parts.paths.samplePath(path, Math.min(1, progress + step));
      const nextCartographic =
        geo.ellipsoid.WGS84.cartesianToCartographic(next);
      if (!nextCartographic) continue;
      const geodesic = geo.ellipsoidGeodesic.create(
        currentCartographic,
        nextCartographic,
      );
      if (
        geodesic.surfaceDistance > 10 &&
        Number.isFinite(geodesic.startHeading)
      ) {
        // HeadingPitchRange positions the camera opposite its heading vector.
        // Passing the forward path heading therefore keeps the camera behind
        // the vehicle, with the remaining ascent receding into the scene.
        return geo.math.zeroToTwoPi(geodesic.startHeading);
      }
    }
    return fallback;
  }

  /**
   * Resolve the initial replay heading as a profile view of the path.
   * @param {Cesium.Cartesian3[]} path Replay path.
   * @returns {number} Heading perpendicular to the initial path direction.
   */

  function replayInitialCameraHeading(path) {
    return geo.math.zeroToTwoPi(
      cameraHeadingForPath(path, 0, Math.PI) + geo.math.PI_OVER_TWO,
    );
  }

  /**
   * Keep ascent framing behind and slightly to one side of the vehicle, then
   * widen that rear-quarter angle as the orbit becomes visible.
   * @param {number} pathHeading Forward path bearing in radians.
   * @param {number} orbitBlend Normalized orbit-camera transition.
   * @returns {number} Cesium HeadingPitchRange heading.
   */

  function replayChaseCameraHeading(pathHeading, orbitBlend = 0) {
    const blend = geo.math.clamp(Number(orbitBlend) || 0, 0, 1);
    return geo.math.zeroToTwoPi(
      pathHeading +
        geo.math.lerp(
          REPLAY_ASCENT_CAMERA_OFFSET_RAD,
          REPLAY_ORBIT_CAMERA_OFFSET_RAD,
          blend,
        ),
    );
  }

  /**
   * Limit replay-camera yaw changes so a path heading wrap or insertion turn
   * cannot swing the chase view through the front of the vehicle.
   * @param {number} previous Previous Cesium heading in radians.
   * @param {number} desired Desired Cesium heading in radians.
   * @param {number} [maxStepRad] Maximum angular change for one rendered frame.
   * @returns {number}
   */

  function smoothReplayCameraHeading(
    previous,
    desired,
    maxStepRad = geo.math.toRadians(2),
  ) {
    if (!Number.isFinite(previous)) return geo.math.zeroToTwoPi(desired);
    if (!Number.isFinite(desired)) return geo.math.zeroToTwoPi(previous);
    const delta = geo.math.negativePiToPi(desired - previous);
    const step = geo.math.clamp(
      delta,
      -Math.abs(maxStepRad),
      Math.abs(maxStepRad),
    );
    return geo.math.zeroToTwoPi(previous + step);
  }

  /**
   * Blend from a global nadir view into an oblique local 3D view as the user
   * approaches a selected launch site.
   * @param {number} rangeM Camera distance from the launch-site anchor.
   * @returns {number} Cesium camera pitch in radians.
   */

  function missionZoomPitch(rangeM) {
    const range = Math.max(0, Number(rangeM) || 0);
    const blend = geo.math.clamp(
      (Math.log(Math.max(range, MISSION_CLOSE_VIEW_RANGE_M)) -
        Math.log(MISSION_CLOSE_VIEW_RANGE_M)) /
        (Math.log(MISSION_GLOBE_VIEW_RANGE_M) -
          Math.log(MISSION_CLOSE_VIEW_RANGE_M)),
      0,
      1,
    );
    return geo.math.lerp(geo.math.toRadians(-42), -geo.math.PI_OVER_TWO, blend);
  }

  /**
   * Resolve the replay camera offset for either close ascent tracking or the
   * orbital globe pullback.
   * @param {{ascending: boolean, phaseProgress: number}} state Replay phase.
   * @param {number} altitudeM Animated vehicle altitude above the ellipsoid.
   * @returns {{range: number, pitch: number}}
   */

  function replayCameraView(state, altitudeM) {
    const altitude = Math.max(0, Number(altitudeM) || 0);
    const localRange = geo.math.clamp(
      REPLAY_INITIAL_RANGE_M + altitude * 0.7,
      REPLAY_INITIAL_RANGE_M,
      REPLAY_LOCAL_MAX_RANGE_M,
    );
    const rawContextBlend = geo.math.clamp(
      (altitude - 20000) / (REPLAY_CONTEXT_ALTITUDE_END_M - 20000),
      0,
      1,
    );
    const contextBlend =
      rawContextBlend * rawContextBlend * (3 - 2 * rawContextBlend);
    const contextRange = geo.math.clamp(
      180000 + altitude * 3.8,
      MISSION_CLOSE_VIEW_RANGE_M,
      REPLAY_CONTEXT_MAX_RANGE_M,
    );
    const ascentRange = geo.math.lerp(localRange, contextRange, contextBlend);
    const ascentPitch = geo.math.lerp(
      geo.math.toRadians(-20),
      geo.math.toRadians(-34),
      contextBlend,
    );
    if (state?.ascending) {
      return { range: ascentRange, pitch: ascentPitch };
    }
    const rawBlend = geo.math.clamp(
      (Number(state?.phaseProgress) || 0) / REPLAY_ORBIT_PULLBACK_FRACTION,
      0,
      1,
    );
    const blend = rawBlend * rawBlend * (3 - 2 * rawBlend);
    return {
      range: geo.math.lerp(ascentRange, REPLAY_ORBIT_GLOBE_RANGE_M, blend),
      // Keep an oblique tactical view of the complete orbit rather than ending
      // in a nadir view. This also prevents the camera from appearing to
      // return toward the launch site after insertion.
      pitch: geo.math.lerp(ascentPitch, geo.math.toRadians(-45), blend),
    };
  }

  /**
   * Move the orbit-follow target from the vehicle toward its sub-satellite
   * globe anchor, keeping Earth centered while the vehicle remains in frame.
   * @param {Cesium.Cartesian3} position Animated orbital position.
   * @param {number} orbitBlend Normalized orbit-camera transition.
   * @returns {Cesium.Cartesian3} Camera look-at target.
   */

  function replayOrbitGlobeAnchor(position, orbitBlend = 0) {
    if (!position) return position;
    const blend = geo.math.clamp(Number(orbitBlend) || 0, 0, 1);
    if (blend <= 0) return geo.cartesian3.clone(position);
    const cartographic = geo.ellipsoid.WGS84.cartesianToCartographic(position);
    if (!cartographic) return geo.cartesian3.clone(position);
    const altitude = Math.max(0, cartographic.height || 0);
    return geo.cartesian3.fromRadians(
      cartographic.longitude,
      cartographic.latitude,
      geo.math.lerp(altitude, altitude * 0.1, blend),
    );
  }

  /**
   * Keep the orbital camera's look-at frame biased toward the moving vehicle.
   * Blending completely to a whole-orbit bounding-sphere center can place the
   * target at (or numerically close to) Earth's center. That frame is singular
   * for a heading/pitch camera and lets compact-orbit vehicles leave the view as
   * the camera rotates. Retaining a radial vehicle bias keeps the local frame
   * stable while the wider camera range still contains Earth and the full orbit.
   * @param {Cesium.Cartesian3} vehicleAnchor Globe-side anchor below the vehicle.
   * @param {Cesium.Cartesian3|null} frameCenter Combined Earth/orbit frame center.
   * @param {number} orbitBlend Normalized orbit-camera transition.
   * @returns {Cesium.Cartesian3} Stable camera look-at target.
   */

  function replayOrbitCameraTarget(vehicleAnchor, frameCenter, orbitBlend = 0) {
    if (!vehicleAnchor) return vehicleAnchor;
    if (!frameCenter) return geo.cartesian3.clone(vehicleAnchor);
    const blend =
      geo.math.clamp(Number(orbitBlend) || 0, 0, 1) *
      REPLAY_ORBIT_FRAME_CENTER_BLEND;
    return geo.cartesian3.lerp(
      vehicleAnchor,
      frameCenter,
      blend,
      geo.cartesian3.create(),
    );
  }

  /**
   * Build a stable orbit-relative camera pose. The camera remains on one side
   * of the orbital plane and uses the vehicle radial as its visual up axis.
   * Consequently the forward orbit tangent always projects toward screen-left
   * instead of changing direction when local compass headings wrap near a pole.
   * @param {Cesium.Cartesian3} position Current vehicle position.
   * @param {Cesium.Cartesian3} tangentPosition Nearby forward path position.
   * @param {Cesium.Cartesian3} target Camera look-at target.
   * @param {number} range Camera distance from the target.
   * @param {number} pitch Camera elevation below the local horizon.
   * @returns {{destination: Cesium.Cartesian3, direction: Cesium.Cartesian3, up: Cesium.Cartesian3}|null}
   */

  function replayOrbitCameraPose(
    position,
    tangentPosition,
    target,
    range,
    pitch,
  ) {
    if (!position || !tangentPosition || !target) return null;
    const radial = geo.cartesian3.normalize(
      geo.cartesian3.clone(position),
      geo.cartesian3.create(),
    );
    const tangent = geo.cartesian3.subtract(
      tangentPosition,
      position,
      geo.cartesian3.create(),
    );
    if (geo.cartesian3.magnitudeSquared(tangent) < 1) return null;
    geo.cartesian3.normalize(tangent, tangent);
    const orbitNormal = geo.cartesian3.cross(
      radial,
      tangent,
      geo.cartesian3.create(),
    );
    if (geo.cartesian3.magnitudeSquared(orbitNormal) < 1e-12) return null;
    geo.cartesian3.normalize(orbitNormal, orbitNormal);

    const distance = Math.max(1, Number(range) || 1);
    const elevation = geo.math.clamp(
      Math.abs(Number(pitch) || 0),
      geo.math.toRadians(5),
      geo.math.toRadians(80),
    );
    const planeOffset = geo.cartesian3.multiplyByScalar(
      orbitNormal,
      Math.cos(elevation) * distance,
      geo.cartesian3.create(),
    );
    const radialOffset = geo.cartesian3.multiplyByScalar(
      radial,
      Math.sin(elevation) * distance,
      geo.cartesian3.create(),
    );
    const destination = geo.cartesian3.add(
      target,
      planeOffset,
      geo.cartesian3.create(),
    );
    geo.cartesian3.add(destination, radialOffset, destination);
    const direction = geo.cartesian3.normalize(
      geo.cartesian3.subtract(target, destination, geo.cartesian3.create()),
      geo.cartesian3.create(),
    );
    const radialAlongView = geo.cartesian3.multiplyByScalar(
      direction,
      geo.cartesian3.dot(radial, direction),
      geo.cartesian3.create(),
    );
    const up = geo.cartesian3.normalize(
      geo.cartesian3.subtract(radial, radialAlongView, geo.cartesian3.create()),
      geo.cartesian3.create(),
    );
    return { destination, direction, up };
  }

  /**
   * Build one conservative frame that contains both Earth and the complete
   * selected orbit. High-apogee missions cannot be composed from the vehicle's
   * instantaneous altitude alone because the opposite side of the orbit may
   * extend much farther from the globe.
   * @param {Cesium.Cartesian3[]} orbitPath Selected orbit samples.
   * @returns {Cesium.BoundingSphere} Combined Earth/orbit frame.
   */

  function replayOrbitFrameSphere(orbitPath = []) {
    const earth = geo.boundingSphere.create(
      geo.cartesian3.ZERO,
      geo.ellipsoid.WGS84.maximumRadius,
    );
    if (!Array.isArray(orbitPath) || orbitPath.length < 2) return earth;
    const orbit = geo.boundingSphere.fromPoints(orbitPath);
    return geo.boundingSphere.union(earth, orbit, geo.boundingSphere.create());
  }

  /**
   * Ensure high-altitude missions frame both the globe and selected vehicle.
   * @param {number} baseRange Range from the normal replay camera transition.
   * @param {number} altitudeM Vehicle altitude above the ellipsoid.
   * @param {number} orbitBlend Normalized orbit-camera transition.
   * @param {number} frameRadiusM Radius of the combined Earth/orbit frame.
   * @returns {number} Camera range in metres.
   */

  function replayOrbitGlobeRange(
    baseRange,
    altitudeM,
    orbitBlend = 0,
    frameRadiusM = 0,
  ) {
    const range = Math.max(0, Number(baseRange) || 0);
    const altitude = Math.max(0, Number(altitudeM) || 0);
    const frameRadius = Math.max(0, Number(frameRadiusM) || 0);
    const blend = geo.math.clamp(Number(orbitBlend) || 0, 0, 1);
    const globeAndVehicleRange = Math.max(
      range,
      altitude + geo.ellipsoid.WGS84.maximumRadius * 2.4,
      frameRadius * 3,
    );
    return geo.math.lerp(range, globeAndVehicleRange, blend);
  }
  return {
    cameraHeadingForPath,
    replayInitialCameraHeading,
    replayChaseCameraHeading,
    smoothReplayCameraHeading,
    missionZoomPitch,
    replayCameraView,
    replayOrbitGlobeAnchor,
    replayOrbitCameraTarget,
    replayOrbitCameraPose,
    replayOrbitFrameSphere,
    replayOrbitGlobeRange,
  };
}
