import * as geo from '../../geo/index.js';
import { createFakeEngine } from '../../globe/testing/fakeEngine.js';
import { createRendering } from './rendering.js';
import { createSelection } from './selection.js';
import { WILDLIFE_ATLAS_CELLS } from './sprites.js';

export const DENSE_CONTINENT_CELLS = 6 * 32 * 32;
export const DENSE_CONTINENT_ROWS = 500;
const NOW = Date.parse('2026-11-04T18:00:00Z');

/** The real render + selection pipeline on the engine contract's mover sets
 * (a fake engine). Only the drawing and external overlay host are replaced. Six fully
 * occupied logical tiles deliberately include off-window cells and collisions. */
export function denseContinentalRendering({ onOperations } = {}) {
  const cells = [];
  const z = 3;
  for (let x = 1; x < 3; x++)
    for (let y = 1; y < 4; y++)
      for (let row = 1; row < 64; row += 2)
        for (let column = 1; column < 64; column += 2)
          cells.push({
            id: `grid:${z}/${x}/${y}:${row}:${column}`,
            lat:
              (Math.atan(
                Math.sinh(Math.PI * (1 - (2 * (y + row / 64)) / 2 ** z)),
              ) *
                180) /
              Math.PI,
            lon: ((x + column / 64) / 2 ** z) * 360 - 180,
            cellCount: row * 64 + column,
          });
  const rows = cells
    .slice(1200, 1200 + DENSE_CONTINENT_ROWS)
    .map((cell, i) => ({
      stableId: `synthetic:continent:${i}`,
      origin: 'inaturalist',
      lat: cell.lat,
      lon: cell.lon,
      iconic: 'Aves',
      commonName: i % 2 ? `Synthetic bird ${i}` : null,
      observedAt: NOW - i * 1000,
      quality: 'research',
      obscured: false,
      cell: null,
    }));
  const engine = createFakeEngine({ width: 1440, height: 900 });
  // High above the continent, so every kernel is in front of the limb; the
  // opacity reads a regional 2,000 km camera height.
  engine.fake.setPose({ position: geo.cartesian3.fromDegrees(-112, 42, 2e7) });
  engine.camera.height = () => 2_000_000;
  engine.projector.horizonVisible = () => true;
  const state = {
    enabled: true,
    engine,
    rows: new Map(rows.map((row) => [row.stableId, row])),
    gridCells: cells,
    gridAvailable: true,
    renderedRows: [],
    rowById: new Map(),
    pointById: new Map(),
    positions: new Map(),
    cells: [],
    staging: null,
    taxa: 'all',
    selectedId: null,
    query: { visibleBoxes: [{ south: 5, west: -130, north: 75, east: -50 }] },
    band: 'regional',
    ambientRows: [],
    ambientIds: [],
    labelRows: [],
    carriers: new Map(),
    contextIds: new Set(),
  };
  const centre = geo.cartesian3.fromDegrees(-90, 42);
  const frame = geo.transforms.eastNorthUpToFixedFrame(centre);
  const east = { x: frame[0], y: frame[1], z: frame[2] };
  const north = { x: frame[4], y: frame[5], z: frame[6] };
  const metrics = { projections: 0, publications: 0, cartesianBuilds: 0 };
  const atlas = {
    url: 'data:image/svg+xml,badges',
    cells: WILDLIFE_ATLAS_CELLS,
  };
  let pan = 0;
  let nextIdle = 0;
  const idle = new Map();
  const slices = [];
  const timers = new Map();
  let nextTimer = 0;
  const parts = {};
  const services = {
    now: () => NOW,
    setTimer(fn, delay) {
      timers.set(++nextTimer, { fn, delay });
      return nextTimer;
    },
    clearTimer: (id) => timers.delete(id),
    requestIdleCallback(fn) {
      idle.set(++nextIdle, fn);
      return nextIdle;
    },
    cancelIdleCallback(id) {
      idle.delete(id);
    },
    performanceSlice(slice) {
      slices.push(slice);
    },
    badgeSprites: {
      atlas: () => atlas,
      subscribe: () => () => {},
    },
    render: { governorRequestRender() {} },
    overlayHost: {
      setEntries() {
        metrics.publications++;
      },
    },
    performanceOperations(operations) {
      metrics.cartesianBuilds += operations.positionBuilds;
      onOperations?.(operations);
    },
  };
  engine.fake.script('worldToWindow', (anchor) => {
    metrics.projections++;
    return {
      x:
        720 +
        (anchor.x * east.x + anchor.y * east.y + anchor.z * east.z) / 8000 +
        pan,
      y:
        450 -
        (anchor.x * north.x + anchor.y * north.y + anchor.z * north.z) / 8000,
    };
  });
  parts.rendering = createRendering({ state, services, parts });
  parts.photos = { get: () => null, setAmbient() {} };
  parts.selection = createSelection({ state, services, parts });
  parts.rendering.init();
  return {
    state,
    metrics,
    moveEnd(offset = 0) {
      pan = offset;
      metrics.projections = metrics.publications = metrics.cartesianBuilds = 0;
      slices.length = 0;
      const result = parts.rendering.rebuild();
      if (result !== 'pending') {
        parts.selection.refreshAmbient();
        parts.selection.publishSelected();
        parts.selection.refreshContexts();
      }
      return result;
    },
    flush(maxSlices = Infinity) {
      let count = 0;
      while (idle.size && count++ < maxSlices) {
        const [id, fn] = idle.entries().next().value;
        idle.delete(id);
        const threadStart = process.threadCpuUsage();
        fn({ timeRemaining: () => 8, didTimeout: false });
        const threadUsed = process.threadCpuUsage(threadStart);
        if (slices.length)
          slices.at(-1).threadCpuMs =
            (threadUsed.user + threadUsed.system) / 1000;
      }
      return {
        ...metrics,
        billboards: state.renderedRows.length,
        glowPrimitives: parts.rendering.density?.size ?? 0,
        slices: [...slices],
      };
    },
    destroy() {
      parts.rendering.destroy();
    },
  };
}
