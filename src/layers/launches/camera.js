import {
  WGS84,
  fromRadians,
  toCartographicRadians,
} from '../../geo/ellipsoid.js';
import { geodesicInverse } from '../../geo/geodesic.js';
import { sphereFromPoints, sphereUnion } from '../../geo/sphere.js';
import {
  PI_OVER_TWO,
  add,
  clamp,
  clone,
  cross,
  dot,
  negativePiToPi,
  normalize,
  scale,
  sub,
  toRadians,
  zeroToTwoPi,
} from '../../geo/vector.js';
import { lerp, lerpPoint } from './geometry.js';
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

export function createCamera({ state: layerState, services, parts, source }) {
  function cameraHeadingForPath(path, progress, fallback = Math.PI) {
    if (!path?.length) return fallback;
    const current = parts.paths.samplePath(path, progress);
    const currentCartographic = toCartographicRadians(current);
    if (!currentCartographic) return fallback;
    for (const step of [0.01, 0.025, 0.05, 0.1, 0.2]) {
      const next = parts.paths.samplePath(path, Math.min(1, progress + step));
      const nextCartographic = toCartographicRadians(next);
      if (!nextCartographic) continue;
      const geodesic = geodesicInverse(
        currentCartographic.lon,
        currentCartographic.lat,
        nextCartographic.lon,
        nextCartographic.lat,
      );
      if (geodesic.distance > 10 && Number.isFinite(geodesic.startHeading)) {
        // HeadingPitchRange positions the camera opposite its heading vector.
        // Passing the forward path heading therefore keeps the camera behind
        // the vehicle, with the remaining ascent receding into the scene.
        return zeroToTwoPi(geodesic.startHeading);
      }
    }
    return fallback;
  }

  /**
   * Resolve the initial replay heading as a profile view of the path.
   * @param {Array<{x: number, y: number, z: number}>} path Replay path, ECEF.
   * @returns {number} Heading perpendicular to the initial path direction.
   */

  function replayInitialCameraHeading(path) {
    return zeroToTwoPi(cameraHeadingForPath(path, 0, Math.PI) + PI_OVER_TWO);
  }

  /**
   * Keep ascent framing behind and slightly to one side of the vehicle, then
   * widen that rear-quarter angle as the orbit becomes visible.
   * @param {number} pathHeading Forward path bearing in radians.
   * @param {number} orbitBlend Normalized orbit-camera transition.
   * @returns {number} Camera heading, as a heading-pitch-range offset takes it.
   */

  function replayChaseCameraHeading(pathHeading, orbitBlend = 0) {
    const blend = clamp(Number(orbitBlend) || 0, 0, 1);
    return zeroToTwoPi(
      pathHeading +
        lerp(
          REPLAY_ASCENT_CAMERA_OFFSET_RAD,
          REPLAY_ORBIT_CAMERA_OFFSET_RAD,
          blend,
        ),
    );
  }

  /**
   * Limit replay-camera yaw changes so a path heading wrap or insertion turn
   * cannot swing the chase view through the front of the vehicle.
   * @param {number} previous Previous camera heading in radians.
   * @param {number} desired Desired camera heading in radians.
   * @param {number} [maxStepRad] Maximum angular change for one rendered frame.
   * @returns {number}
   */

  function smoothReplayCameraHeading(
    previous,
    desired,
    maxStepRad = toRadians(2),
  ) {
    if (!Number.isFinite(previous)) return zeroToTwoPi(desired);
    if (!Number.isFinite(desired)) return zeroToTwoPi(previous);
    const delta = negativePiToPi(desired - previous);
    const step = clamp(delta, -Math.abs(maxStepRad), Math.abs(maxStepRad));
    return zeroToTwoPi(previous + step);
  }

  /**
   * Blend from a global nadir view into an oblique local 3D view as the user
   * approaches a selected launch site.
   * @param {number} rangeM Camera distance from the launch-site anchor.
   * @returns {number} Camera pitch in radians.
   */

  function missionZoomPitch(rangeM) {
    const range = Math.max(0, Number(rangeM) || 0);
    const blend = clamp(
      (Math.log(Math.max(range, MISSION_CLOSE_VIEW_RANGE_M)) -
        Math.log(MISSION_CLOSE_VIEW_RANGE_M)) /
        (Math.log(MISSION_GLOBE_VIEW_RANGE_M) -
          Math.log(MISSION_CLOSE_VIEW_RANGE_M)),
      0,
      1,
    );
    return lerp(toRadians(-42), -PI_OVER_TWO, blend);
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
    const localRange = clamp(
      REPLAY_INITIAL_RANGE_M + altitude * 0.7,
      REPLAY_INITIAL_RANGE_M,
      REPLAY_LOCAL_MAX_RANGE_M,
    );
    const rawContextBlend = clamp(
      (altitude - 20000) / (REPLAY_CONTEXT_ALTITUDE_END_M - 20000),
      0,
      1,
    );
    const contextBlend =
      rawContextBlend * rawContextBlend * (3 - 2 * rawContextBlend);
    const contextRange = clamp(
      180000 + altitude * 3.8,
      MISSION_CLOSE_VIEW_RANGE_M,
      REPLAY_CONTEXT_MAX_RANGE_M,
    );
    const ascentRange = lerp(localRange, contextRange, contextBlend);
    const ascentPitch = lerp(toRadians(-20), toRadians(-34), contextBlend);
    if (state?.ascending) {
      return { range: ascentRange, pitch: ascentPitch };
    }
    const rawBlend = clamp(
      (Number(state?.phaseProgress) || 0) / REPLAY_ORBIT_PULLBACK_FRACTION,
      0,
      1,
    );
    const blend = rawBlend * rawBlend * (3 - 2 * rawBlend);
    return {
      range: lerp(ascentRange, REPLAY_ORBIT_GLOBE_RANGE_M, blend),
      // Keep an oblique tactical view of the complete orbit rather than ending
      // in a nadir view. This also prevents the camera from appearing to
      // return toward the launch site after insertion.
      pitch: lerp(ascentPitch, toRadians(-45), blend),
    };
  }

  /**
   * Move the orbit-follow target from the vehicle toward its sub-satellite
   * globe anchor, keeping Earth centered while the vehicle remains in frame.
   * Positions are ECEF `{x, y, z}`.
   * @param {object} position Animated orbital position.
   * @param {number} orbitBlend Normalized orbit-camera transition.
   * @returns {object} Camera look-at target.
   */

  function replayOrbitGlobeAnchor(position, orbitBlend = 0) {
    if (!position) return position;
    const blend = clamp(Number(orbitBlend) || 0, 0, 1);
    if (blend <= 0) return clone(position);
    const cartographic = toCartographicRadians(position);
    if (!cartographic) return clone(position);
    const altitude = Math.max(0, cartographic.height || 0);
    return fromRadians(
      cartographic.lon,
      cartographic.lat,
      lerp(altitude, altitude * 0.1, blend),
    );
  }

  /**
   * Keep the orbital camera's look-at frame biased toward the moving vehicle.
   * Blending completely to a whole-orbit bounding-sphere center can place the
   * target at (or numerically close to) Earth's center. That frame is singular
   * for a heading/pitch camera and lets compact-orbit vehicles leave the view as
   * the camera rotates. Retaining a radial vehicle bias keeps the local frame
   * stable while the wider camera range still contains Earth and the full orbit.
   * Positions are ECEF `{x, y, z}`.
   * @param {object} vehicleAnchor Globe-side anchor below the vehicle.
   * @param {object|null} frameCenter Combined Earth/orbit frame center.
   * @param {number} orbitBlend Normalized orbit-camera transition.
   * @returns {object} Stable camera look-at target.
   */

  function replayOrbitCameraTarget(vehicleAnchor, frameCenter, orbitBlend = 0) {
    if (!vehicleAnchor) return vehicleAnchor;
    if (!frameCenter) return clone(vehicleAnchor);
    const blend =
      clamp(Number(orbitBlend) || 0, 0, 1) * REPLAY_ORBIT_FRAME_CENTER_BLEND;
    return lerpPoint(vehicleAnchor, frameCenter, blend);
  }

  /**
   * Build a stable orbit-relative camera pose. The camera remains on one side
   * of the orbital plane and uses the vehicle radial as its visual up axis.
   * Consequently the forward orbit tangent always projects toward screen-left
   * instead of changing direction when local compass headings wrap near a pole.
   * Positions and vectors are ECEF `{x, y, z}`.
   * @param {object} position Current vehicle position.
   * @param {object} tangentPosition Nearby forward path position.
   * @param {object} target Camera look-at target.
   * @param {number} range Camera distance from the target.
   * @param {number} pitch Camera elevation below the local horizon.
   * @returns {{destination: object, direction: object, up: object}|null}
   */

  function replayOrbitCameraPose(
    position,
    tangentPosition,
    target,
    range,
    pitch,
  ) {
    if (!position || !tangentPosition || !target) return null;
    const radial = normalize(position);
    const offset = sub(tangentPosition, position);
    if (dot(offset, offset) < 1) return null;
    const tangent = normalize(offset);
    const normal = cross(radial, tangent);
    if (dot(normal, normal) < 1e-12) return null;
    const orbitNormal = normalize(normal);

    const distance = Math.max(1, Number(range) || 1);
    const elevation = clamp(
      Math.abs(Number(pitch) || 0),
      toRadians(5),
      toRadians(80),
    );
    const planeOffset = scale(orbitNormal, Math.cos(elevation) * distance);
    const radialOffset = scale(radial, Math.sin(elevation) * distance);
    const destination = add(add(target, planeOffset), radialOffset);
    const direction = normalize(sub(target, destination));
    const radialAlongView = scale(direction, dot(radial, direction));
    const up = normalize(sub(radial, radialAlongView));
    return { destination, direction, up };
  }

  /**
   * Build one conservative frame that contains both Earth and the complete
   * selected orbit. High-apogee missions cannot be composed from the vehicle's
   * instantaneous altitude alone because the opposite side of the orbit may
   * extend much farther from the globe.
   * @param {Array<{x: number, y: number, z: number}>} orbitPath Selected
   *   orbit samples, ECEF.
   * @returns {{center: {x: number, y: number, z: number}, radius: number}}
   *   Combined Earth/orbit frame.
   */

  function replayOrbitFrameSphere(orbitPath = []) {
    const earth = { center: { x: 0, y: 0, z: 0 }, radius: WGS84.radii.x };
    if (!Array.isArray(orbitPath) || orbitPath.length < 2) return earth;
    return sphereUnion(earth, sphereFromPoints(orbitPath));
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
    const blend = clamp(Number(orbitBlend) || 0, 0, 1);
    const globeAndVehicleRange = Math.max(
      range,
      altitude + WGS84.radii.x * 2.4,
      frameRadius * 3,
    );
    return lerp(range, globeAndVehicleRange, blend);
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
