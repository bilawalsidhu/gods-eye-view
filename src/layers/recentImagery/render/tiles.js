const LIMIT = 85.05112878;
export const TILE_SIZE = 256;
const MAX_TILE_SIDE = 8;
export const mercatorX = (lon) => (lon + 180) / 360;
export const mercatorY = (lat) => {
  const r = (Math.max(-LIMIT, Math.min(LIMIT, lat)) * Math.PI) / 180;
  return (1 - Math.log(Math.tan(Math.PI / 4 + r / 2)) / Math.PI) / 2;
};

/** At most 8×8 visible source tiles per slot, never a global mosaic. */
export function imageryTilePlan(box, rectangle, level) {
  let area = { ...box };
  if (rectangle && rectangle.east >= rectangle.west) {
    const degrees = 180 / Math.PI;
    area = {
      west: Math.max(box.west, rectangle.west * degrees),
      east: Math.min(box.east, rectangle.east * degrees),
      south: Math.max(box.south, rectangle.south * degrees),
      north: Math.min(box.north, rectangle.north * degrees),
    };
  }
  if (area.west >= area.east || area.south >= area.north) return null;
  for (let z = Math.max(0, Math.floor(level)); z >= 0; z--) {
    const n = 2 ** z;
    const x = Math.max(0, Math.floor(mercatorX(area.west) * n));
    const y = Math.max(0, Math.floor(mercatorY(area.north) * n));
    const right = Math.min(n - 1, Math.ceil(mercatorX(area.east) * n) - 1);
    const bottom = Math.min(n - 1, Math.ceil(mercatorY(area.south) * n) - 1);
    const width = right - x + 1,
      height = bottom - y + 1;
    if (width <= MAX_TILE_SIDE && height <= MAX_TILE_SIDE)
      return {
        key: [z, x, y, width, height].join('/'),
        z,
        x,
        y,
        width,
        height,
        bounds: [x / n, y / n, width / n, height / n],
      };
  }
  return null;
}

export function imageryTileUrl(template, x, y, z) {
  return template
    .replaceAll('{x}', String(x))
    .replaceAll('{y}', String(y))
    .replaceAll('{z}', String(z))
    .replaceAll('{s}', ['a', 'b', 'c'][(x + y) % 3]);
}

/** Cancellation holds its admission slot until fetch AND decode settle. */
export function createImageryTileQueue({ load, limit = 6 }) {
  let active = 0,
    peak = 0,
    destroyed = false;
  const pending = [],
    controllers = new Set();
  function pump() {
    while (!destroyed && active < limit && pending.length) {
      const task = pending.shift();
      if (!task.live()) continue;
      const controller = new AbortController();
      controllers.add(controller);
      task.controllers.add(controller);
      active++;
      peak = Math.max(peak, active);
      Promise.resolve()
        .then(() => load(task.url, controller.signal))
        .then((image) => {
          try {
            if (!destroyed && !controller.signal.aborted && task.live())
              task.draw(image);
          } finally {
            image?.close?.();
          }
        })
        .catch((error) => {
          if (!destroyed && !controller.signal.aborted && task.live())
            task.fail(error);
        })
        .finally(() => {
          controllers.delete(controller);
          task.controllers.delete(controller);
          active--;
          pump();
        });
    }
  }
  return {
    add(tasks) {
      if (!destroyed) {
        pending.push(...tasks);
        pump();
      }
    },
    prune() {
      for (let i = pending.length - 1; i >= 0; i--)
        if (!pending[i].live()) pending.splice(i, 1);
    },
    diagnostics: () => ({
      active,
      queued: pending.filter((t) => t.live()).length,
      peak,
    }),
    destroy() {
      destroyed = true;
      pending.length = 0;
      for (const c of controllers) c.abort();
    },
  };
}
