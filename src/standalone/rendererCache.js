// This cache owns the parked renderer and its map. The layer session owns
// feeds, selection, media and the Director across both renderer attachments.

/** How long a parked renderer waits for a switch back before it is
 * disposed: a parked Navara holds about 1.3 GiB, a parked Cesium about
 * 0.26 GiB. A later switch back builds it cold (1.5-2 s). */
export const PARKED_RELEASE_MS = 3 * 60 * 1000;

/**
 * `engineOf(kind)` names the engine a kind runs: kinds of one engine (Navara
 * and Navara HD) never stay parked together, so acquiring one releases the
 * other first.
 */
export function createRendererCache({
  engineOf = (kind) => kind,
  parkedMs = PARKED_RELEASE_MS,
  onReleaseError = (error) =>
    console.error('Parked renderer release failed:', error),
} = {}) {
  const idle = new Map();
  let retainKind;

  function take(kind) {
    const entry = idle.get(kind);
    idle.delete(kind);
    if (entry) clearTimeout(entry.releaseTimer);
    return entry;
  }

  // Dispose a parked renderer for good.
  function release(kind) {
    const entry = take(kind);
    try {
      entry.dispose();
    } catch (error) {
      onReleaseError(error);
    } finally {
      // A disposed globe's context stays live while anything still
      // references its canvas; losing it frees the GPU memory now (the
      // canvas is out of the document, so no page listener hears it).
      entry.context?.getExtension?.('WEBGL_lose_context')?.loseContext();
    }
  }

  async function acquire(kind, build, defer) {
    const host = document.getElementById('cesiumContainer');
    for (const other of [...idle.keys()])
      if (other !== kind && engineOf(other) === engineOf(kind)) release(other);
    let entry = take(kind);
    // loseContext() takes effect before its queued DOM event is delivered.
    // Check the context itself too, before resuming a parked render loop.
    if (entry && (entry.lost || entry.context?.isContextLost?.())) {
      entry.dispose();
      entry = null;
    }
    if (!entry) {
      const container = document.createElement('div');
      container.className = 'globe-renderer';
      host.prepend(container);
      const cleanups = [() => container.remove()];
      const dispose = () => {
        const errors = [];
        while (cleanups.length) {
          try {
            cleanups.pop()();
          } catch (error) {
            errors.push(error);
          }
        }
        if (errors.length)
          throw new AggregateError(errors, 'Renderer cleanup failed');
      };
      try {
        const scene = await build({
          container,
          defer: (fn) => cleanups.push(fn),
        });
        // The context the globe draws with, read once while it is new: a
        // switch reads its state and never asks the canvas again (a canvas
        // asked for another context type would create one).
        const canvas = scene.engine.host.canvas;
        const context =
          canvas.getContext?.('webgl2') ?? canvas.getContext?.('webgl') ?? null;
        entry = { container, scene, dispose, lost: false, context };
        scene.engine.host.canvas.addEventListener(
          'webglcontextlost',
          () => {
            entry.lost = true;
          },
          { once: true },
        );
      } catch (error) {
        dispose();
        throw error;
      }
    } else {
      try {
        host.prepend(entry.container);
        entry.scene.resume();
        entry.scene.engine.render.request('engine-resume');
      } catch (error) {
        entry.dispose();
        throw error;
      }
    }
    defer(() => {
      const keep = retainKind === kind && !entry.lost;
      retainKind = null;
      if (!keep) return entry.dispose();
      try {
        entry.scene.suspend();
      } catch (error) {
        entry.dispose();
        throw error;
      }
      entry.container.remove();
      idle.set(kind, entry);
      entry.releaseTimer = setTimeout(() => release(kind), parkedMs);
    });
    return entry.scene;
  }

  return {
    acquire,
    retain(kind) {
      retainKind = kind;
    },
    clear() {
      for (const kind of [...idle.keys()]) take(kind).dispose();
    },
  };
}
