import * as geo from '../../geo/index.js';

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

  /** The feed query around the camera of `view` (a viewer or the renderer's view). */
  function _flightQuery(view) {
    const cartographic = view?.camera?.positionCartographic;
    return cartographic
      ? {
          latitude: geo.math.toDegrees(cartographic.latitude),
          longitude: geo.math.toDegrees(cartographic.longitude),
        }
      : {};
  }
  return { _abortActiveUpdates, _flightQuery };
}
