// The OSM Places points on the globe contract (engine.movers,
// engine.surface, engine.camera), the same on every engine: 9 px discs in
// the place colour with a dark 2 px outline, on top only within 2.5 km of
// the camera. The contract has no ground clamping, so each point sits on the
// sampled surface; visible points refine after camera moves and tile loads.

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
const SAMPLES_PER_PASS = 16;
const SAMPLE_BUDGET_MS = 4;
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
    revision = 0;
  const heights = new Map();
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
    let sampleTime = 0;
    const now = Date.now();
    const size = engine.host.size();
    let samples = 0;
    let delay = Infinity;
    shown.forEach((record, index) => {
      let cached = heights.get(record);
      if (!cached || cached.revision !== revision) {
        cached = {
          height: cached?.height ?? 0,
          revision,
          attempts: 0,
          nextAt: 0,
          resolved: false,
        };
        heights.set(record, cached);
      }
      let position = geo.cartesian3.fromDegrees(
        record.lon,
        record.lat,
        cached.height + HEIGHT_OFFSET_M,
      );
      const screen = engine.projector.horizonVisible(position)
        ? engine.projector.worldToWindow(position)
        : null;
      const inView =
        screen &&
        screen.x >= 0 &&
        screen.y >= 0 &&
        screen.x < size.width &&
        screen.y < size.height;
      if (
        sampling &&
        inView &&
        !cached.resolved &&
        cached.attempts < RESAMPLE_TRIES
      ) {
        if (
          now >= cached.nextAt &&
          samples < SAMPLES_PER_PASS &&
          sampleTime < SAMPLE_BUDGET_MS
        ) {
          const started = performance.now();
          const sampled = engine.surface.sampleHeight(
            geo.cartographic.fromDegrees(record.lon, record.lat),
            [set],
          );
          sampleTime += performance.now() - started;
          samples++;
          cached.attempts++;
          cached.nextAt = now + RESAMPLE_MS;
          // Cesium samples kilometres underground while tiles stream.
          if (Number.isFinite(sampled) && sampled >= -500 && sampled <= 9000) {
            cached.height = sampled;
            cached.resolved = true;
            position = geo.cartesian3.fromDegrees(
              record.lon,
              record.lat,
              sampled + HEIGHT_OFFSET_M,
            );
          }
        }
        if (!cached.resolved && cached.attempts < RESAMPLE_TRIES)
          delay = Math.min(delay, Math.max(0, cached.nextAt - now));
      }
      set.set(index, {
        position,
        color,
        show: true,
        pickId: osmPlacePickId(record),
      });
    });
    set.setCount(shown.length);
    set.commit();
    if (Number.isFinite(delay)) retry = setTimeout(draw, delay);
  }
  function refine() {
    revision++;
    if (visible && records.length) draw();
  }
  const removeMoveEnd = engine.camera.moveEnd.addEventListener(refine);
  let tilesLoaded = engine.surface.tilesLoaded();
  const removeSurface = engine.frames.preRender.addEventListener(() => {
    const loaded = engine.surface.tilesLoaded();
    if (loaded && !tilesLoaded) refine();
    tilesLoaded = loaded;
  });
  return {
    setVisible(show) {
      if (visible === Boolean(show)) return;
      visible = Boolean(show);
      draw();
    },
    replace(next) {
      records = next.slice();
      heights.clear();
      revision++;
      draw();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      clearTimeout(retry);
      removeMoveEnd();
      removeSurface();
      heights.clear();
      set?.destroy();
      set = null;
      records = [];
      engine.render.request('osm-places-destroy');
    },
  };
}
