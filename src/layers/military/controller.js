import * as Cesium from 'cesium';
import {
  MILITARY_REGIONAL_VIEW_MAX_HEIGHT_M,
  MILITARY_SCENE_RADIUS_NM,
} from './recordPolicy.js';

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

  /**
   * The scene anchor the snapshot request carries (mirrors the civil layer's
   * `_flightQuery`). `radiusNm` is added ONLY in a regional view (camera
   * below 2,000 km) so the proxy filters server-side; the globe view omits it
   * and keeps the worldwide list.
   */
  function _militaryQuery(viewer) {
    const cartographic = viewer?.camera?.positionCartographic;
    if (!cartographic) return {};
    const query = {
      latitude: Cesium.Math.toDegrees(cartographic.latitude),
      longitude: Cesium.Math.toDegrees(cartographic.longitude),
    };
    if (
      Number.isFinite(cartographic.height) &&
      cartographic.height < MILITARY_REGIONAL_VIEW_MAX_HEIGHT_M
    ) {
      query.radiusNm = MILITARY_SCENE_RADIUS_NM;
    }
    return query;
  }
  return { _abortActiveUpdates, _militaryQuery };
}
