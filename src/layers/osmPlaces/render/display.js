// The OSM Places points on the globe contract (engine.movers,
// engine.surface, engine.camera), the same on every engine: 9 px discs in
// the place colour with a dark 2 px outline, on top only within 2.5 km of
// the camera. The contract has no ground clamping, so each point sits on the
// sampled surface; heights are read again after each camera move, and
// shortly after a draw that found no surface under a place yet.

import * as geo from '../../../geo/index.js';
import { rgbaFromCss } from '../../shared/color.js';
import { OSM_PLACES_LAYER_ID, OSM_PLACE_COLOR } from '../model.js';

// Above the sampled surface, so a point does not sink into it.
const HEIGHT_OFFSET_M = 2;
// The voice search's result cap; a larger set grows the batch.
const INITIAL_CAPACITY = 256;
// While the surface under a place has not loaded, its height is asked again.
const RESAMPLE_MS = 500;
const RESAMPLE_TRIES = 20;
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
    records = [],
    destroyed = false,
    retry = null,
    tries = 0;
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
    clearTimeout(retry);
    retry = null;
    const shown = visible ? records : [];
    ensure(shown.length);
    const sampling = engine.surface.supported;
    let unsampled = false;
    shown.forEach((record, index) => {
      const sampled = sampling
        ? engine.surface.sampleHeight(
            geo.cartographic.fromDegrees(record.lon, record.lat),
            [set],
          )
        : undefined;
      if (!Number.isFinite(sampled)) unsampled = true;
      set.set(index, {
        position: geo.cartesian3.fromDegrees(
          record.lon,
          record.lat,
          (Number.isFinite(sampled) ? sampled : 0) + HEIGHT_OFFSET_M,
        ),
        color,
        show: true,
        pickId: osmPlacePickId(record),
      });
    });
    set.setCount(shown.length);
    set.commit();
    if (unsampled && sampling && tries++ < RESAMPLE_TRIES)
      retry = setTimeout(draw, RESAMPLE_MS);
  }
  const removeMoveEnd = engine.camera.moveEnd.addEventListener(() => {
    tries = 0;
    if (visible && records.length) draw();
  });
  return {
    setVisible(show) {
      if (visible === Boolean(show)) return;
      visible = Boolean(show);
      draw();
    },
    replace(next) {
      records = next.slice();
      tries = 0;
      draw();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      clearTimeout(retry);
      removeMoveEnd();
      set?.destroy();
      set = null;
      records = [];
      engine.render.request('osm-places-destroy');
    },
  };
}
