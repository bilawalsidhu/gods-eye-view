import * as Cesium from 'cesium';
import { FOLLOW_EYE_HEIGHT_M } from './policy.js';

/** Ellipsoidal heights a land surface can have (Dead Sea shore to Everest, with geoid slack). */
const SURFACE_MIN_M = -500;
const SURFACE_MAX_M = 9000;
/** Rendered mesh window around the bare earth: roofs and bridges, not whole towers. */
const MESH_BELOW_DEM_M = 15;
const MESH_ABOVE_DEM_M = 80;

/**
 * Drive the globe camera from the street-level pose: either continuously
 * ("camera follows view") or once, framing the image from behind.
 */
export function createCameraFollow({ state, parts }) {
  const { render } = state.services;

  function requestRender() {
    render?.governorRequestRender?.('street-level-follow');
  }

  /**
   * Ground under a photo for framing and following. The rendered surface is
   * sampled first, but `sampleHeight` can return nonsense before the tiles
   * under the point have loaded (kilometres below the ellipsoid), so a sample
   * counts only when it is a plausible surface height and, once the bare-earth
   * height is known, lies within the mesh window around it.
   */
  function groundHeightAt(lon, lat, fallback) {
    const scene = state.viewer?.scene;
    const carto = Cesium.Cartographic.fromDegrees(lon, lat);
    const caster = parts?.groundCaster;
    const dem = caster?.groundAt(lon, lat) ?? null;
    if (dem === null) caster?.prepare([[lon, lat]]);
    const plausible = (height) =>
      Number.isFinite(height) &&
      height >= SURFACE_MIN_M &&
      height <= SURFACE_MAX_M &&
      (dem === null ||
        (height >= dem - MESH_BELOW_DEM_M && height <= dem + MESH_ABOVE_DEM_M));
    let height = null;
    try {
      if (scene?.sampleHeightSupported) height = scene.sampleHeight(carto);
    } catch {
      /* not sampleable yet */
    }
    if (!plausible(height)) height = dem;
    if (!plausible(height)) height = scene?.globe?.getHeight?.(carto);
    if (!plausible(height)) height = fallback;
    return plausible(height) ? height : 0;
  }

  /** Put the Cesium camera where the street-level camera is. */
  function followCamera() {
    const { position, bearing, tilt, follow, altitude } = state.street;
    if (!follow || !position || !state.viewer) return;
    const ground = groundHeightAt(position.lon, position.lat, altitude);
    state.viewer.camera.setView({
      destination: Cesium.Cartesian3.fromDegrees(
        position.lon,
        position.lat,
        ground + FOLLOW_EYE_HEIGHT_M,
      ),
      orientation: {
        heading: Cesium.Math.toRadians(bearing || 0),
        pitch: Cesium.Math.toRadians(Number.isFinite(tilt) ? tilt : 0),
        roll: 0,
      },
    });
    requestRender();
  }

  /** Frame the current image from a short distance behind it. */
  function lookAtPosition() {
    const { position, bearing, altitude } = state.street;
    if (!position || !state.viewer) return;
    const ground = groundHeightAt(position.lon, position.lat, altitude);
    state.viewer.camera.flyToBoundingSphere(
      new Cesium.BoundingSphere(
        Cesium.Cartesian3.fromDegrees(position.lon, position.lat, ground + 2),
        4,
      ),
      {
        offset: new Cesium.HeadingPitchRange(
          Cesium.Math.toRadians(bearing || 0),
          Cesium.Math.toRadians(-32),
          140,
        ),
        duration: 1.6,
      },
    );
  }

  function setFollow(enabled) {
    state.street.follow = enabled === true && state.street.followAvailable;
    if (state.street.follow) followCamera();
    state.notify?.();
  }

  return { followCamera, lookAtPosition, setFollow };
}
