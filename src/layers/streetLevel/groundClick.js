import * as Cesium from 'cesium';
import { GROUND_CLICK_MAX_HEIGHT_M } from './policy.js';
import { cameraHeightAboveGround } from './view.js';

/** Whether the camera is low enough for a click on the ground to mean a street. */
export function groundClickHeightOk(viewer, groundAt) {
  if (!viewer?.camera?.positionCartographic) return false;
  return (
    cameraHeightAboveGround(viewer, { groundAt }) <= GROUND_CLICK_MAX_HEIGHT_M
  );
}

/**
 * A click on the map itself (nothing picked, or Google 3D tile content) at
 * street zoom opens the nearest image of the active, available providers
 * that have no coverage to click (`groundClick`, Google Street View). The
 * camera stays put: the user chose the spot.
 * The height is measured at the click, not read from the cached flag.
 * @param {{state: object, openNearest: Function, isAvailable: (entry: object) => boolean, groundAt?: Function}} options
 * @returns {(screenPosition: {x: number, y: number}, picked?: object) => Promise<boolean>|false}
 */
export function createGroundClick({
  state,
  openNearest,
  isAvailable,
  groundAt = null,
}) {
  return function openAtGround(screenPosition, picked) {
    const scenePick = state.services.scenePick;
    if (!state.enabled || !state.viewer || !scenePick?.pickGroundPosition)
      return false;
    if (
      !scenePick.isSurfacePick(picked) ||
      !groundClickHeightOk(state.viewer, groundAt)
    )
      return false;
    const providerIds = [...state.providers.values()]
      .filter(
        (entry) =>
          entry.on &&
          entry.def.groundClick &&
          entry.status?.configured &&
          isAvailable(entry),
      )
      .map((entry) => entry.def.id);
    if (!providerIds.length) return false;
    const position = scenePick.pickGroundPosition(state.viewer, screenPosition);
    const carto = position && Cesium.Cartographic.fromCartesian(position);
    if (!carto) return false;
    return openNearest(
      {
        lon: Cesium.Math.toDegrees(carto.longitude),
        lat: Cesium.Math.toDegrees(carto.latitude),
      },
      { providerIds, frame: false },
    );
  };
}
