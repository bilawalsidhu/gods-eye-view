import * as Cesium from 'cesium';
import { FOLLOW_EYE_HEIGHT_M } from './policy.js';

/**
 * Drive the globe camera from the street-level pose: either continuously
 * ("camera follows view") or once, framing the image from behind.
 */
export function createCameraFollow({ state }) {
  const { render } = state.services;

  function requestRender() {
    render?.governorRequestRender?.('street-level-follow');
  }

  function groundHeightAt(lon, lat, fallback) {
    const scene = state.viewer?.scene;
    const carto = Cesium.Cartographic.fromDegrees(lon, lat);
    let height = null;
    try {
      if (scene?.sampleHeightSupported) height = scene.sampleHeight(carto);
    } catch {
      /* not sampleable yet */
    }
    if (!Number.isFinite(height)) height = scene?.globe?.getHeight?.(carto);
    if (!Number.isFinite(height)) height = fallback;
    return Number.isFinite(height) ? height : 0;
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
