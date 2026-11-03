// This cache owns the parked renderer and its map. The layer session owns
// feeds, selection, media and the Director across both renderer attachments.
export function createRendererCache() {
  const idle = new Map();
  let retainKind;

  async function acquire(kind, build, defer) {
    const host = document.getElementById('cesiumContainer');
    let entry = idle.get(kind);
    idle.delete(kind);
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
    });
    return entry.scene;
  }

  return {
    acquire,
    retain(kind) {
      retainKind = kind;
    },
    clear() {
      for (const entry of idle.values()) entry.dispose();
      idle.clear();
    },
  };
}
