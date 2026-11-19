import { GROUND_CLICK_MAX_HEIGHT_M } from './policy.js';
import { cameraHeightAboveGround } from './view.js';
import { toLonLatH } from '../../geo/index.js';

/** Whether the camera is low enough for a click on the ground to mean a street. */
export function groundClickHeightOk(viewer) {
  const height = cameraHeightAboveGround(viewer);
  return height !== null && height <= GROUND_CLICK_MAX_HEIGHT_M;
}

/**
 * A click on the map itself at street zoom opens the nearest image of the
 * active `groundClick` providers, without moving the camera. The height is
 * measured at the click, not read from the cached flag.
 * @param {{state: object, openNearest: Function, isAvailable: (entry: object) => boolean}} options
 * @returns {(click: {surface: boolean, ground: () => {x: number, y: number, z: number}|null}) => Promise<boolean>|false}
 *   `surface`: whether the click hit the map itself; `ground`: the world
 *   position under it, null over the sky.
 */
export function createGroundClick({ state, openNearest, isAvailable }) {
  return function openAtGround({ surface, ground: groundAt }) {
    if (!state.enabled || !state.viewer) return false;
    if (!surface || !groundClickHeightOk(state.viewer)) return false;
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
    const position = groundAt();
    const ground = position && toLonLatH(position);
    if (!ground) return false;
    return openNearest(
      { lon: ground.lon, lat: ground.lat },
      { providerIds, frame: false },
    );
  };
}
