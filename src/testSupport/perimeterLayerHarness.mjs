/** The Fire Perimeters layer on the stub renderer, for its draw-set tests. */
import { createFirePerimetersLayer } from '../layers/perimeters/index.js';
import {
  PERIMETER_EDGE,
  PERIMETER_FILL,
} from '../layers/perimeters/drawing.js';
import { bindRenderer } from '../render/rendererOf.js';
import { createStubRenderer } from '../render/stub/index.js';

export {
  FILL_MIN_VERTICES,
  LINE_MIN_VERTICES,
} from '../layers/perimeters/drawing.js';
/** The vertices a square of `piece()` draws: its ring, and its line. */
export const SQUARE_VERTICES = 5;
export const HOUR = 3600000;
export const AT = Date.UTC(2026, 7, 20, 12);

/** A small square ring at `lon, lat`, `size` degrees across. */
export const square = (lon, lat, size = 0.01) => [
  [lon, lat],
  [lon + size, lat],
  [lon + size, lat + size],
  [lon, lat + size],
  [lon, lat],
];
export const fireAt = (id, lon, lat) => ({
  id,
  name: id,
  containedPct: 0,
  lastGrowthTime: null,
  anchor: { lon, lat },
});
/** A piece of `count` squares beside each other, each outlined. */
export const piece = (
  fireId,
  id,
  born,
  { lon = -120, lat = 38, count = 1 } = {},
) => {
  const polygons = [];
  for (let i = 0; i < count; i++) polygons.push([square(lon + i * 0.02, lat)]);
  return {
    ...(id === null ? {} : { id }),
    fireId,
    born,
    polygons,
    outline: polygons.map((rings) => rings[0]),
  };
};
export const snapshot = (fires, pieces, { at = AT, revision } = {}) => ({
  at,
  fetchedAt: at,
  stale: false,
  revision: revision ?? pieces.map((p) => p.id ?? '').join('|'),
  note: null,
  fires,
  pieces,
});

/**
 * The layer drawn on the stub renderer, every write to its draw sets
 * logged as `{set, call, ids}` (`set` the set's id, `call` set, upsert or
 * remove, `ids` the item ids).
 */
export function harness(read, extra = {}) {
  const renderer = createStubRenderer();
  const viewer = {};
  bindRenderer(viewer, renderer);
  const writes = [];
  const sets = new Map();
  const draw = renderer.draw;
  for (const kind of ['shapes', 'lines']) {
    const make = draw[kind].bind(draw);
    draw[kind] = (spec) => {
      const set = make(spec);
      sets.set(spec.id, set);
      for (const call of ['set', 'upsert', 'remove']) {
        const write = set[call].bind(set);
        set[call] = (items) => {
          writes.push({
            set: spec.id,
            call,
            ids: items.map((item) => (call === 'remove' ? item : item.id)),
          });
          return write(items);
        };
      }
      return set;
    };
  }
  const layer = createFirePerimetersLayer({
    source: { getSnapshot: async () => read() },
    ...extra,
  });
  layer.init(viewer);
  layer.enable(viewer);
  /** The items drawn now in the layer's sets of `kind`, by id. */
  const items = (kind) => {
    const out = new Map();
    for (const id of renderer.testing.sets()) {
      if (!id.startsWith('fire-perimeters:') || !id.endsWith(`:${kind}`))
        continue;
      for (const [itemId, item] of renderer.testing.setRecord(id).items)
        out.set(itemId, { ...item, set: id });
    }
    return out;
  };
  return { renderer, viewer, layer, writes, items, sets };
}

export const FILL = PERIMETER_FILL;
export const EDGE = PERIMETER_EDGE;
