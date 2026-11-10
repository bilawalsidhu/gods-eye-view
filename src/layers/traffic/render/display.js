// Street Traffic on the globe contract, the same on every engine:
// - vehicles: two engine.movers point sets written from the layer's dots once
//   a frame, an outline disc under each fill disc (the outline of Cesium's
//   PointPrimitive, pixelSize plus outlineWidth on each side); each dot is
//   sized and faded by its camera distance as a PointPrimitive's
//   scaleByDistance and translucencyByDistance are (over the squared
//   distance, eased by ^0.2), and depth-tested against the scene;
// - flow lines: three ground corridor sets (free, slow, jam), draped on the
//   visible surface; congestion heat lines use two (jam, slow), on 3D tiles.
//   A bucket's look (the jam's glow and pulse) goes to the engine, which
//   animates it on the GPU.
// The layer keeps each dot's look as plain data on `dot.point` (position,
// pixelSize, color, outlineColor, outlineWidth, show, scaleByDistance,
// translucencyByDistance); the display only reads it.

import * as geo from '../../../geo/index.js';
import { MAX_DOTS } from '../policy.js';

export const TRAFFIC_SET_IDS = Object.freeze({
  outline: 'traffic-outline',
  fill: 'traffic-fill',
  jam: 'traffic-heat-jam',
  slow: 'traffic-heat-slow',
  free: 'traffic-flow-free',
});
// Cesium culls a point whose translucency falls under this.
const MIN_TRANSLUCENCY = 0.004;
// Draw order of the heat-line sets: the jam batch was added first.
const HEAT_ORDER = Object.freeze({ jam: 0, slow: 1 });

/**
 * A NearFarScalar `{ near, nearValue, far, farValue }` at `distance` metres:
 * Cesium's interpolation over the squared distance, eased by ^0.2; 1 without
 * one.
 */
export function nearFarValue(scalar, distance) {
  if (!scalar) return 1;
  const nearSq = scalar.near * scalar.near;
  const span = scalar.far * scalar.far - nearSq;
  const t =
    span > 0
      ? Math.min(1, Math.max(0, (distance * distance - nearSq) / span))
      : distance > scalar.near
        ? 1
        : 0;
  return (
    scalar.nearValue + (scalar.farValue - scalar.nearValue) * Math.pow(t, 0.2)
  );
}

/**
 * @param {import('../../../globe/contract.js').GlobeEngine} engine
 * @returns {{ drawDots: (dots: object[]) => void, show: (visible: boolean) => void,
 *   setHeat: (bucket: 'jam'|'slow'|'free', roads: object[], style: { color: number[], widthPx: number, glow?: object, pulse?: object }) => void,
 *   clearHeat: () => void, excluded: () => object[], destroy: () => void }}
 */
export function createTrafficDisplay(engine) {
  const roles = ['outline', 'fill'];
  const sets = roles.map((role, order) =>
    engine.movers.createSet({
      id: TRAFFIC_SET_IDS[role],
      kind: 'point',
      order,
      capacity: MAX_DOTS,
      depthTest: 'normal',
      pickable: false,
      point: { sizePx: 1, outlinePx: 0 },
    }),
  );
  const heat = new Map();
  let heatGeneration = 0;
  const color = [0, 0, 0, 0];
  const fields = { position: null, scale: 1, color, show: true };
  const counts = [0, 0];
  let visible = true;
  let drawn = false;
  let destroyed = false;

  function commit() {
    for (let i = 0; i < sets.length; i++) {
      sets[i].setCount(counts[i]);
      sets[i].commit();
    }
  }

  function write(index, point, size, alpha, tint) {
    color[0] = tint.red;
    color[1] = tint.green;
    color[2] = tint.blue;
    color[3] = tint.alpha * alpha;
    fields.position = point.position;
    fields.scale = size;
    sets[index].set(counts[index]++, fields);
  }

  function drawDots(dots) {
    if (destroyed) return;
    counts[0] = counts[1] = 0;
    const camera = engine.camera.livePosition;
    if (visible && camera)
      for (const dot of dots) {
        const point = dot.point;
        // A dot at size 0 (fading in, recycled at a road end) draws nothing,
        // its outline included.
        if (!point?.show || !(point.pixelSize > 0) || !point.position) continue;
        const distance = geo.cartesian3.distance(point.position, camera);
        const alpha = nearFarValue(point.translucencyByDistance, distance);
        if (alpha < MIN_TRANSLUCENCY) continue;
        const scale = nearFarValue(point.scaleByDistance, distance);
        const outline = point.outlineWidth > 0 && point.outlineColor;
        if (outline && counts[0] < MAX_DOTS)
          write(
            0,
            point,
            Math.max(0, (point.pixelSize + 2 * point.outlineWidth) * scale),
            alpha,
            point.outlineColor,
          );
        if (counts[1] < MAX_DOTS)
          write(
            1,
            point,
            Math.max(0, point.pixelSize * scale),
            alpha,
            point.color,
          );
      }
    fields.position = null;
    // An empty population is written once, not every frame.
    if (!counts[0] && !counts[1] && !drawn) return;
    drawn = counts[0] > 0 || counts[1] > 0;
    commit();
  }

  function dropHeat(bucket) {
    heat.get(bucket)?.destroy();
    heat.delete(bucket);
  }

  return {
    drawDots,
    /** Shows or hides the vehicles (the heat lines go with the layer's roads). */
    show(next) {
      visible = next !== false;
      if (!visible && drawn && !destroyed) {
        counts[0] = counts[1] = 0;
        drawn = false;
        commit();
      }
    },
    /**
     * One bucket's heat lines: a corridor per road, along its coordinates,
     * with the bucket's glow and pulse (engine.ground corridor looks).
     */
    setHeat(
      bucket,
      roads,
      {
        color: rgba,
        widthPx,
        glow,
        pulse,
        drape = 'tiles',
        order = HEAT_ORDER[bucket],
      },
    ) {
      if (destroyed) return;
      dropHeat(bucket);
      if (!roads.length) return;
      const set = engine.ground.createSet({
        id: heatGeneration
          ? `${TRAFFIC_SET_IDS[bucket]}-${heatGeneration}`
          : TRAFFIC_SET_IDS[bucket],
        kind: 'corridor',
        order,
        pickable: false,
        drape,
      });
      heat.set(bucket, set);
      const look = {
        ...(glow ? { glow } : {}),
        ...(pulse ? { pulse } : {}),
      };
      set.replace(
        roads.map((road) => ({
          positions: road.coords,
          color: rgba,
          widthPx,
          ...look,
        })),
      );
      set.commit();
    },
    heatBuilding: () => [...heat.values()].some((set) => !set.ready()),
    // Transfer ownership without destroying the lines still on screen.
    takeHeat() {
      const taken = [...heat.values()];
      heat.clear();
      if (taken.length) heatGeneration++;
      return taken;
    },
    clearHeat() {
      for (const bucket of [...heat.keys()]) dropHeat(bucket);
    },
    /** The vehicle sets, which surface height samples look through. */
    excluded: () => (destroyed ? [] : sets.slice()),
    destroy() {
      if (destroyed) return;
      destroyed = true;
      for (const bucket of [...heat.keys()]) dropHeat(bucket);
      for (const set of sets) set.destroy();
    },
  };
}
