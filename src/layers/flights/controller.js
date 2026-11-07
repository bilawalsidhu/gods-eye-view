import { findCamera } from '../../render/rendererOf.js';

export function createController({
  flightState,
  services,
  parts,
  layer,
  resolveAsset,
}) {
  function _abortActiveUpdates() {
    for (const controller of flightState.feed._activeUpdateControllers)
      controller.abort();
    flightState.feed._activeUpdateControllers.clear();
  }

  /** The feed query around the camera's ground point, or {} with none. */
  function _flightQuery(viewer) {
    const pose = viewer ? findCamera(viewer)?.pose() : null;
    // An eye at the earth's centre has no ground point: the pose gives NaN.
    return pose && Number.isFinite(pose.lat) && Number.isFinite(pose.lon)
      ? { latitude: pose.lat, longitude: pose.lon }
      : {};
  }
  return { _abortActiveUpdates, _flightQuery };
}
