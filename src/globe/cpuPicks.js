// CPU picks of movers and lines for every engine that needs them (Navara's
// hover, drill and synchronous pick, the fake engine): projected positions
// within the drawn size (+3 px, Navara's PICK_RADIUS), lines within 8 px
// (or half their width + 3 px when wider), hidden behind the globe excluded.
// Hits rank as they are drawn on top: sets drawn without a depth test
// ('always') over depth-tested ones, then by set order (higher drawn later,
// on top: the tracked bank over the fleet, flights over local ADS-B), then
// nearest to the camera. Models are checked against their drawn radius when
// the engine knows it (pickRadiusPx). Pure: src/geo and the engine's
// projector only.

import * as geo from '../geo/index.js';

const scratch = geo.cartesian3.create();
const scratchB = geo.cartesian3.create();
const scratchScreen = { x: 0, y: 0 };
const scratchScreenB = { x: 0, y: 0 };

export const PICK_RADIUS_PX = 3;
/** A line is picked within 8 px of its drawn segments (thin trails too). */
export const LINE_PICK_PX = 8;

/** Distance from point p to segment ab (2D). */
export function distanceToSegment(p, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  const t =
    lengthSquared > 0
      ? Math.max(
          0,
          Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSquared),
        )
      : 0;
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

const segmentT = (p, a, b) => {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  return lengthSquared > 0
    ? Math.max(
        0,
        Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSquared),
      )
    : 0;
};

// scaleByDistance [nearM, nearScale, farM, farScale] at `distance`, as
// Cesium's NearFarScalar and the Navara mover shader draw it: over the
// squared distance, eased by ^0.2.
export function distanceScale(scaleByDistance, distance) {
  if (!scaleByDistance) return 1;
  const [near, nearScale, far, farScale] = scaleByDistance;
  const t = Math.pow(
    Math.min(
      1,
      Math.max(
        0,
        (distance * distance - near * near) /
          Math.max(far * far - near * near, 1e-6),
      ),
    ),
    0.2,
  );
  return nearScale + (farScale - nearScale) * t;
}

function moverRadius(options, scale, distance, modelRadiusPx = null) {
  if (options.kind === 'model' && modelRadiusPx != null)
    return Math.max(modelRadiusPx, PICK_RADIUS_PX) + PICK_RADIUS_PX;
  const style =
    options.kind === 'sprite'
      ? options.sprite
      : options.kind === 'point'
        ? options.point
        : null;
  const size = style
    ? style.sizePx * distanceScale(style.scaleByDistance, distance)
    : Math.max(options.model.minimumPixelSize, 24);
  return Math.max((size * scale) / 2, PICK_RADIUS_PX) + PICK_RADIUS_PX;
}

function transformed(matrix, flat, index, result) {
  const x = flat[index * 3];
  const y = flat[index * 3 + 1];
  const z = flat[index * 3 + 2];
  if (!matrix) return geo.cartesian3.fromElements(x, y, z, result);
  return geo.cartesian3.fromElements(
    matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12],
    matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13],
    matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14],
    result,
  );
}

/**
 * @param {{ projector: { worldToWindow: Function, horizonVisible: Function },
 *   camera: { livePosition: object },
 *   movers: () => { options: object, store: object }[],
 *   lines: () => { options: object, flat: Float64Array, modelMatrix: number[] | null }[] }} ports
 * @returns {(at: { x: number, y: number }, limit?: number, options?: { includeMovers?: boolean }) => object[]}
 *   Pick results ({ id, owner, instance? }) under a window position, nearest first.
 */
export function createCpuPicker({ projector, camera, movers, lines }) {
  const depthOf = (position) =>
    geo.cartesian3.distance(position, camera.livePosition);

  function moverHits(at, hits) {
    for (const { options, store, pickRadiusPx } of movers()) {
      if (!options.pickable) continue;
      const onTop = options.depthTest === 'always' ? 1 : 0;
      const order = Number(options.order) || 0;
      const { positions, shows, scales, pickIds } = store;
      for (let index = 0; index < store.count; index++) {
        if (shows[index] !== 1) continue;
        geo.cartesian3.fromElements(
          positions[index * 3],
          positions[index * 3 + 1],
          positions[index * 3 + 2],
          scratch,
        );
        const screen = projector.worldToWindow(scratch, scratchScreen);
        if (!screen || !projector.horizonVisible(scratch)) continue;
        const distance = Math.hypot(screen.x - at.x, screen.y - at.y);
        const depth = depthOf(scratch);
        if (
          distance >
          moverRadius(options, scales[index], depth, pickRadiusPx?.(index))
        )
          continue;
        hits.push({
          onTop,
          order,
          depth,
          result: { id: pickIds[index], owner: options.id, instance: index },
        });
      }
    }
  }

  function lineHits(at, hits) {
    for (const { options, flat, modelMatrix } of lines()) {
      if (options.pickId === undefined) continue;
      const limit = Math.max(
        LINE_PICK_PX,
        options.widthPx / 2 + PICK_RADIUS_PX,
      );
      let best = null;
      for (let index = 0; index + 1 < flat.length / 3; index++) {
        const a = transformed(modelMatrix, flat, index, scratch);
        const b = transformed(modelMatrix, flat, index + 1, scratchB);
        if (!projector.horizonVisible(a) && !projector.horizonVisible(b))
          continue;
        const sa = projector.worldToWindow(a, scratchScreen);
        const sb = sa && projector.worldToWindow(b, scratchScreenB);
        if (!sa || !sb) continue;
        if (distanceToSegment(at, sa, sb) > limit) continue;
        const t = segmentT(at, sa, sb);
        const depth = depthOf(
          geo.cartesian3.lerp(a, b, t, geo.cartesian3.create()),
        );
        if (best === null || depth < best) best = depth;
      }
      if (best !== null)
        hits.push({
          // Lines are depth-tested and drawn in their own order.
          onTop: 0,
          order: Number(options.order) || 0,
          depth: best,
          result: { id: options.pickId, owner: options.id },
        });
    }
  }

  const drill = (
    at,
    limit = Infinity,
    { includeMovers = true, includeLines = true } = {},
  ) => {
    const hits = [];
    if (includeMovers) moverHits(at, hits);
    if (includeLines) lineHits(at, hits);
    hits.sort(
      (a, b) => b.onTop - a.onTop || b.order - a.order || a.depth - b.depth,
    );
    return hits.slice(0, limit).map(({ result }) => result);
  };
  /**
   * Whether a mover instance is drawn near a window position: within its
   * pick radius times `slack` (a check of a GPU answer). Unknown sets, and
   * models whose drawn size the engine does not know yet, count as near.
   */
  drill.near = (owner, instance, at, slack = 2) => {
    const found = movers().find(({ options }) => options.id === owner);
    if (!found) return true;
    const { options, store, pickRadiusPx } = found;
    const modelRadius =
      options.kind === 'model' ? (pickRadiusPx?.(instance) ?? null) : null;
    if (options.kind === 'model' && modelRadius == null) return true;
    if (instance >= store.count) return false;
    geo.cartesian3.fromElements(
      store.positions[instance * 3],
      store.positions[instance * 3 + 1],
      store.positions[instance * 3 + 2],
      scratch,
    );
    const screen = projector.worldToWindow(scratch, scratchScreen);
    if (!screen) return false;
    return (
      Math.hypot(screen.x - at.x, screen.y - at.y) <=
      moverRadius(
        options,
        store.scales[instance],
        depthOf(scratch),
        modelRadius,
      ) *
        slack
    );
  };
  return drill;
}
