// The GNSS integrity cells on the globe contract (engine.ground,
// engine.camera), the same on every engine: one ground cell per binned
// cell, filled in its level's colour at the layer's alpha for that level,
// without an outline. The set is not pickable, so the cells never hide
// what lies under them from a pick.

import * as geo from '../../../geo/index.js';
import { rgbaFromCss } from '../../shared/color.js';
import { viewRectangleCenter } from '../../shared/viewRectangle.js';
import { GNSS_LEVEL_COLORS } from '../records.js';

const SET_ID = 'gnss-integrity';

/**
 * Degrees at the centre of the current view: the ellipsoid under the screen
 * centre, else the view rectangle's centre (at globe scale the rectangle can
 * be the whole world, whose midpoint is unrelated to the place under the
 * screen centre), else under the camera; null when none is finite.
 * @param {import('../../../globe/contract.js').GlobeEngine} engine
 * @returns {{ latitude: number, longitude: number } | null}
 */
export function defaultGnssViewAnchor(engine) {
  const camera = engine?.camera;
  if (!camera) return null;
  const { width, height } = engine.host?.size?.() ?? {};
  const centre =
    width > 0 &&
    height > 0 &&
    camera.pickEllipsoid({ x: width / 2, y: height / 2 });
  let place = centre ? geo.cartographic.fromCartesian(centre) : undefined;
  if (!place) {
    const rectangle = camera.viewRectangle();
    place = rectangle
      ? viewRectangleCenter(rectangle)
      : camera.pose()?.cartographic;
  }
  if (!place) return null;
  const latitude = geo.math.toDegrees(place.latitude);
  const longitude = geo.math.toDegrees(place.longitude);
  return Number.isFinite(latitude) && Number.isFinite(longitude)
    ? { latitude, longitude }
    : null;
}

/**
 * The cells: `{ camera, anchor, setVisible, replace(cells, alpha), destroy }`.
 * `camera` is the engine's (its moveEnd and changed events); `anchor()` is
 * `viewAnchor(engine)`. A cell is `{ west, south, east, north, level }` in
 * degrees; `alpha` maps a level to its fill alpha.
 * @param {import('../../../globe/contract.js').GlobeEngine} engine
 * @param {{ viewAnchor?: (engine: object) => ({ latitude: number, longitude: number } | null) }} [options]
 */
export function createGnssDisplay(
  engine,
  { viewAnchor = defaultGnssViewAnchor } = {},
) {
  const set = engine.ground.createSet({ id: SET_ID, kind: 'cell' });
  set.show(false);
  let destroyed = false;
  return {
    camera: engine.camera,
    anchor: () => viewAnchor(engine),
    setVisible(show) {
      if (!destroyed) set.show(show);
    },
    replace(cells, alpha) {
      if (destroyed) return;
      set.replace(
        cells.map(({ west, south, east, north, level }) => ({
          west,
          south,
          east,
          north,
          fill: rgbaFromCss(GNSS_LEVEL_COLORS[level])
            .withAlpha(alpha[level])
            .rgba(),
        })),
      );
      set.commit();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      set.destroy();
    },
  };
}
