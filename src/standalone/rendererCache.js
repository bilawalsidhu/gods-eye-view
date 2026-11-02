import { releaseCameraVerbs } from '../cameraVerbs.js';
import { uninstallRenderGovernor } from '../renderGovernor.js';

// Only the renderer and its map survive a switch. The outgoing UI, data feeds,
// tools and their subscriptions are still disposed with their application.
export function createRendererCache() {
  const idle = new Map();
  let retainKind;

  async function acquire(kind, build, defer) {
    const host = document.getElementById('cesiumContainer');
    let entry = idle.get(kind);
    idle.delete(kind);
    if (entry?.lost) {
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
        entry = { container, scene, dispose, lost: false };
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
      host.prepend(entry.container);
      if (entry.scene.viewer)
        entry.scene.viewer.useDefaultRenderLoop = !document.hidden;
      else entry.scene.setRenderLoop(true);
      entry.scene.engine.render.request('engine-resume');
    }
    const { viewer, engine } = entry.scene;
    defer(() => {
      const keep = retainKind === kind && !entry.lost;
      retainKind = null;
      if (!keep) return entry.dispose();
      uninstallRenderGovernor(viewer ?? engine);
      engine.camera.cancelFlight();
      if (viewer) {
        releaseCameraVerbs(viewer);
        viewer.useDefaultRenderLoop = false;
      } else {
        engine.render.setContinuous(false);
        entry.scene.setRenderLoop(false);
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
