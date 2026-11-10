// The engine-neutral QA probe: window.__godsEyeView.layers. QA scripts ask
// it what a layer shows and where, the same way on Cesium and Navara,
// instead of reading Cesium objects. Read-only apart from enable/disable,
// which go through the layer manager as a user toggle would.
//
//   list()                 [{ id, name, enabled, available }] (the catalog)
//   unavailable()          [{ id, name }] layers this engine leaves out
//   available(id)          whether this engine can show layer `id`
//   enable(id) / disable(id)   → Promise<boolean>
//   objects(id, max?)      [{ id, label, position, screen }] (position a
//                          plain { x, y, z }, screen a window point or null)
//   screenOf(id, objectId) the window point of one object, or null
//   selected(id)           the layer's tracked/selected info, or null
//   drawn(id)              what the layer draws per object (glyph, model),
//                          as plain data, or null (layers with qaDrawn)
//   following()            { label, native } of engine.camera.following()
//   movers()               engine.movers.list()
//   framesDrawn()          frames drawn since the probe started
//   settled({ frames? })   readiness conditions over drawn frames

const plain = (position) =>
  position ? { x: position.x, y: position.y, z: position.z } : null;

/** Frame-based readiness, also serialized by the production QA harness. */
export function createSettledState(
  engine,
  getRestore = () =>
    globalThis.window?.__godsEyeView?.styleManager?.initialRestorePromise,
) {
  let drawn = 0;
  let stable = 0;
  let previous = null;
  let restore;
  let restored = false;
  let restoreError = null;
  const observeRestore = () => {
    const next = getRestore();
    if (!next || next === restore) return;
    restore = next;
    restored = false;
    restoreError = null;
    Promise.resolve(next).then(
      () => {
        if (restore === next) restored = true;
      },
      (error) => {
        if (restore === next) restoreError = String(error);
      },
    );
  };
  const pose = () => {
    const value = engine.camera.pose();
    return [
      ...['position', 'direction', 'up'].flatMap((key) =>
        ['x', 'y', 'z'].map((axis) => value[key][axis]),
      ),
      value.fovy,
      value.aspectRatio,
    ];
  };
  const same = (a, b) =>
    a && a.every((n, i) => Math.abs(n - b[i]) <= (i < 3 ? 1e-6 : 1e-10));
  const remove = engine.frames.postRender.addEventListener(() => {
    observeRestore();
    drawn++;
    const current = pose();
    stable =
      same(previous, current) &&
      !engine.camera.flightActive() &&
      engine.input.cameraInputsEnabled()
        ? stable + 1
        : 0;
    previous = current;
  });
  observeRestore();
  return {
    settled({ frames = 3 } = {}) {
      observeRestore();
      const started = !engine.isDestroyed();
      const conditions = {
        engineStarted: started,
        initialViewRestored: restored,
        frameDrawn: drawn > 0,
        noFlight: started && !engine.camera.flightActive(),
        cameraInputsEnabled: started && engine.input.cameraInputsEnabled(),
        cameraPoseStable: started && stable >= frames && same(previous, pose()),
      };
      const unmet = Object.keys(conditions).filter((key) => !conditions[key]);
      return {
        settled: !unmet.length,
        conditions,
        unmet,
        framesDrawn: drawn,
        stableFrames: stable,
        restoreError,
      };
    },
    destroy: remove,
  };
}

/**
 * @param {{
 *   engine: import('../globe/contract.js').GlobeEngine,
 *   dataManager: object,
 * }} options
 */
export function createQaProbe({ engine, dataManager }) {
  const readiness = createSettledState(engine);
  let frames = 0;
  const removeFrames = engine.frames.postRender.addEventListener(() => {
    frames++;
  });
  const moduleOf = (layerId) => dataManager.layers.get(layerId)?.module;
  const screenOf = (position) => {
    if (!position || !engine.projector.horizonVisible(position)) return null;
    const screen = engine.projector.worldToWindow(position);
    return screen ? { x: screen.x, y: screen.y } : null;
  };
  const objects = (layerId, max = 500) => {
    const rows = moduleOf(layerId)?.getAllPositions?.(max) ?? [];
    return rows.map((row) => ({
      id: row.id,
      label: row.label ?? null,
      position: plain(row.position),
      screen: screenOf(row.position),
    }));
  };
  return {
    list: () =>
      dataManager.getAll().map(({ id, name, enabled }) => ({
        id,
        name,
        enabled: Boolean(enabled),
        available: true,
      })),
    unavailable: () => [],
    available: (layerId) => dataManager.layers.has(layerId),
    enable: (layerId) =>
      dataManager.setEnabled(layerId, true, { origin: 'user' }),
    disable: (layerId) =>
      dataManager.setEnabled(layerId, false, { origin: 'user' }),
    objects,
    screenOf(layerId, objectId) {
      const row = (moduleOf(layerId)?.getAllPositions?.(1_000_000) ?? []).find(
        ({ id }) => String(id) === String(objectId),
      );
      return row ? screenOf(row.position) : null;
    },
    // The tracked object, or the selected one of a layer that selects
    // without tracking (vessels).
    selected: (layerId) => {
      const module = moduleOf(layerId);
      return module?.getTrackedInfo?.() ?? module?.getSelectedInfo?.() ?? null;
    },
    drawn: (layerId) => moduleOf(layerId)?.qaDrawn?.() ?? null,
    following() {
      const handle = engine.camera.following();
      if (!handle) return null;
      return {
        label: handle.label?.id ?? null,
        native: handle.native?.id ?? null,
      };
    },
    movers: () => engine.movers.list(),
    framesDrawn: () => frames,
    settled: (options) => readiness.settled(options),
    destroy() {
      removeFrames();
      readiness.destroy();
    },
  };
}
