import * as geo from '../../geo/index.js';
import { GROUND_CLICK_MAX_HEIGHT_M } from './policy.js';
import { cameraHeightAboveGround, cameraLocation } from './view.js';

/** Whether the camera is low enough for a click on the ground to mean a street. */
export function groundClickHeightOk(map) {
  if (!cameraLocation(map)) return false;
  return cameraHeightAboveGround(map) <= GROUND_CLICK_MAX_HEIGHT_M;
}

/**
 * A click on the map itself at street zoom opens the nearest image of the
 * active `groundClick` providers, without moving the camera. The height is
 * measured at the click, not read from the cached flag.
 * @param {{state: object, openNearest: Function, isAvailable: (entry: object) => boolean}} options
 * @returns {(screenPosition: {x: number, y: number}, picked?: object) => Promise<boolean>|false}
 */
export function createGroundClick({ state, openNearest, isAvailable }) {
  return function openAtGround(screenPosition, picked) {
    const scenePick = state.services.scenePick;
    if (!state.enabled || !state.map || !scenePick?.pickGroundPosition)
      return false;
    if (!scenePick.isSurfacePick(picked) || !groundClickHeightOk(state.map))
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
    const position = scenePick.pickGroundPosition(
      state.map.engine,
      screenPosition,
    );
    const carto = position && geo.cartographic.fromCartesian(position);
    if (!carto) return false;
    return openNearest(
      {
        lon: geo.math.toDegrees(carto.longitude),
        lat: geo.math.toDegrees(carto.latitude),
      },
      { providerIds, frame: false },
    );
  };
}
