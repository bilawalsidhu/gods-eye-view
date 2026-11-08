// Navara 0.2.1 never takes a global batch id back: its core keeps every id
// ctx.genGlobalBatchId() hands out (about 20 bytes of WASM memory each,
// never freed). A PickableInstancedMeshWrapper takes one id per instance of
// its capacity, and a layer builds its mover sets again each time it
// attaches to the engine, so every switch back to Navara with 10 000
// flights took some 32 000 new ids (about 650 KiB). This pool gives the ids
// of a wrapper that is gone to the next wrapper on the same view. Upstream
// ask: release a batch id, or a wrapper's ids when it is unregistered.

/** A pool of one view's released global batch ids. */
export function createBatchIdPool() {
  const free = [];
  const released = new WeakSet();
  return {
    /**
     * The view's `ctx` to build a pickable wrapper with, whose batch ids
     * come from the pool first; everything else is the view's own.
     */
    source(ctx) {
      const take = () => (free.length ? free.pop() : ctx.genGlobalBatchId());
      return new Proxy(ctx, {
        get: (target, key, receiver) =>
          key === 'genGlobalBatchId'
            ? take
            : Reflect.get(target, key, receiver),
      });
    },
    /**
     * Takes back the ids of a wrapper no longer drawn or registered for
     * picking; a wrapper's ids come back once.
     */
    release(wrapper) {
      if (!wrapper || released.has(wrapper)) return;
      released.add(wrapper);
      for (const id of wrapper.batchIds) if (id > 0) free.push(id);
    },
  };
}
