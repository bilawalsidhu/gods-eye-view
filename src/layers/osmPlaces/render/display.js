// The OSM Places points on the globe contract (engine.movers,
// engine.surface, engine.camera), the same on every engine: 9 px discs in
// the place colour with a dark 2 px outline, on top only within 2.5 km of
// the camera. The contract has no ground clamping, so each point sits on the
// sampled surface; visible points refine after camera moves and tile loads.

import * as geo from '../../../geo/index.js';
import { rgbaFromCss } from '../../shared/color.js';
import { createSurfacePoints } from '../../../globe/surfacePlacement.js';
import { OSM_PLACES_LAYER_ID, OSM_PLACE_COLOR } from '../model.js';

// Above the sampled surface, so a point does not sink into it.
const HEIGHT_OFFSET_M = 2;
// The voice search's result cap; a larger set grows the batch.
const INITIAL_CAPACITY = 256;
// Under the moving contacts (src/data/spriteOrder.js), as map data.
const POINT_ORDER = -1;

/** What a pick of a place returns. */
export const osmPlacePickId = (record) => `osm-place:${record.id}`;

/**
 * The places' points: `{ setVisible, replace(records), destroy }`.
 * @param {import('../../../globe/contract.js').GlobeEngine} engine
 */
export function createOsmPlacesDisplay(engine) {
  const color = rgbaFromCss(OSM_PLACE_COLOR).rgba();
  let set = null,
    capacity = 0,
    visible = false,
    points = [],
    destroyed = false;
  const surface = createSurfacePoints(engine, {
    groups: () => [{ set, points: visible ? points : [] }],
    request: () => engine.render.request(OSM_PLACES_LAYER_ID),
    heightOffset: HEIGHT_OFFSET_M,
    estimateGround: true,
  });
  function ensure(count) {
    if (set && count <= capacity) return;
    set?.destroy();
    capacity = Math.max(INITIAL_CAPACITY, count);
    set = engine.movers.createSet({
      id: OSM_PLACES_LAYER_ID,
      kind: 'point',
      capacity,
      order: POINT_ORDER,
      pickable: true,
      depthTest: { disableWithinM: 2500 },
      point: { sizePx: 9, outlinePx: 2, outlineColor: [0, 0, 0, 0.8] },
    });
  }
  function draw() {
    if (destroyed) return;
    const shown = visible ? points : [];
    ensure(shown.length);
    shown.forEach((point, index) => {
      set.set(index, {
        position: point.position,
        color,
        show: true,
        pickId: osmPlacePickId(point.record),
      });
    });
    set.setCount(shown.length);
    set.commit();
    surface.place();
  }
  return {
    setVisible(show) {
      if (visible === Boolean(show)) return;
      visible = Boolean(show);
      draw();
    },
    replace(next) {
      points = next.map((record) => ({
        record,
        cartographic: geo.cartographic.fromDegrees(record.lon, record.lat),
        position: geo.cartesian3.fromDegrees(
          record.lon,
          record.lat,
          HEIGHT_OFFSET_M,
        ),
      }));
      draw();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      surface.destroy();
      set?.destroy();
      set = null;
      points = [];
      engine.render.request('osm-places-destroy');
    },
  };
}
