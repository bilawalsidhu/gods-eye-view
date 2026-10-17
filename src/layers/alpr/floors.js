/** One cancellable consumer of the shared terrain service, coalesced by floor cell. */
export function createAlprFloorResolver(ground) {
  const pending = new Map();
  const queued = new Map();
  let owner = null;
  let running = false;

  async function pump(controller) {
    try {
      while (queued.size && !controller.signal.aborted) {
        const batch = [...queued.values()].slice(0, 64);
        for (const cell of batch) queued.delete(cell.key);
        try {
          await ground.resolveGroundFloorCells(
            batch.map(({ lat, lon }) => ({ lat, lon })),
            { signal: controller.signal },
          );
        } catch {
          // Missing floors remain clamped; cancellation must not publish later.
        }
        for (const cell of batch) {
          if (pending.get(cell.key) === cell) pending.delete(cell.key);
          cell.finish();
        }
      }
    } finally {
      if (owner === controller) running = false;
    }
  }

  function resolve(points) {
    if (typeof ground.resolveGroundFloorCells !== 'function')
      return Promise.resolve();
    owner ??= new AbortController();
    const waits = [];
    for (const point of points) {
      const lat = Number(point.lat.toFixed(3));
      const lon = Number(point.lon.toFixed(3));
      const key = `${lat},${lon}`;
      let cell = pending.get(key);
      if (!cell) {
        let finish;
        const promise = new Promise((done) => {
          finish = done;
        });
        cell = { key, lat, lon, promise, finish };
        pending.set(key, cell);
        queued.set(key, cell);
      }
      waits.push(cell.promise);
    }
    if (!running && queued.size) {
      running = true;
      void pump(owner);
    }
    return Promise.all(waits);
  }

  async function prepare(points) {
    let timer;
    try {
      await Promise.race([
        resolve(points),
        new Promise((done) => {
          timer = setTimeout(done, ground.FLOOR_RESOLVE_DEADLINE_MS ?? 1200);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  function cancel() {
    owner?.abort();
    owner = null;
    running = false;
    for (const cell of pending.values()) cell.finish();
    pending.clear();
    queued.clear();
  }
  return { resolve, prepare, cancel };
}
