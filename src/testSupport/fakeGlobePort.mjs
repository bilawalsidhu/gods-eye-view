/**
 * A globe port for tests of code that drapes imagery through the renderer's
 * globe port (`src/render/contract/globe.d.ts`): it records each layer and
 * its spec, orders layers by `zOrder` as the contract says, and lets a test
 * drive tile requests through a layer's hooks and raise its tile errors.
 */

/**
 * @param {{settled?: (kind: string) => boolean}} [options]
 *   `settled`: what `isSettled` answers.
 */
export function fakeGlobePort({ settled = () => true } = {}) {
  /** Live layers, bottom to top. */
  const layers = [];
  /** Every layer ever added, in the order added. */
  const added = [];
  let split = 0;
  let globeVisible = true;

  function add(spec, index) {
    const listeners = { tileError: new Set(), frameReady: new Set() };
    const layer = {
      spec,
      alpha: 1,
      show: true,
      split: 'none',
      drapeOn: 'all',
      lit: true,
      removed: false,
      on(event, cb) {
        listeners[event]?.add(cb);
        return () => listeners[event]?.delete(cb);
      },
      raise() {
        const i = layers.indexOf(layer);
        if (i < 0 || i === layers.length - 1) return;
        layers.splice(i, 1);
        layers.splice(i + 1, 0, layer);
      },
      lower() {
        const i = layers.indexOf(layer);
        if (i <= 0) return;
        layers.splice(i, 1);
        layers.splice(i - 1, 0, layer);
      },
      remove() {
        if (layer.removed) return;
        layer.removed = true;
        layers.splice(layers.indexOf(layer), 1);
        listeners.tileError.clear();
        listeners.frameReady.clear();
      },
      /**
       * Ask for a tile as the renderer would: `admit` decides, and an issued
       * request runs `fetch` (the renderer's own fetch) then `tileTransform`.
       * @param {{x: number, y: number, level: number}} tile
       * @param {() => Promise<unknown> | undefined} fetch
       */
      request(tile, fetch) {
        const issue = () => {
          const started = fetch();
          if (!started || !spec.tileTransform) return started;
          return Promise.resolve(started).then((image) =>
            spec.tileTransform(tile, image),
          );
        };
        return spec.admit ? spec.admit(tile, issue) : issue();
      },
      /** Tell the layer's `tileError` listeners. */
      fail(error) {
        for (const cb of [...listeners.tileError]) cb(error);
      },
      listenerCount: (event) => listeners[event]?.size ?? 0,
    };
    let at = index;
    if (at === undefined) {
      const z = Number.isFinite(spec.zOrder) ? spec.zOrder : 0;
      at = layers.length;
      while (at > 0 && (layers[at - 1].spec.zOrder ?? 0) > z) at -= 1;
    }
    layers.splice(Math.max(0, Math.min(at, layers.length)), 0, layer);
    added.push(layer);
    return layer;
  }

  return {
    layers,
    added,
    imagery: {
      add,
      list: () => layers.slice(),
      getSplit: () => split,
      setSplit: (x01) => {
        split = Math.min(1, Math.max(0, Number(x01)));
      },
    },
    isSettled: (kind) => settled(kind),
    setGlobeVisible(visible) {
      globeVisible = Boolean(visible);
    },
    isGlobeVisible: () => globeVisible,
    get globeVisible() {
      return globeVisible;
    },
    on: () => () => {},
  };
}
