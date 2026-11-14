import { msg } from '../../i18n/marker.js';

/** Two independently managed data rows share one camera viewer and media owner. */
export function createCameraCategories(camera) {
  const enabled = { general: false, penndot: false };
  const initialized = new Set();
  let initialization = null;
  let generation = 0;
  let coreLive = false;
  const anyEnabled = () => enabled.general || enabled.penndot;
  camera.setCameraCategoryEnabled('general', false);
  camera.setCameraCategoryEnabled('penndot', false);

  const facet = (category, descriptor) => ({
    ...camera,
    ...descriptor,
    async init(viewer) {
      initialized.add(category);
      if (!initialization) {
        if (coreLive) camera.destroy?.(viewer);
        coreLive = true;
        const epoch = ++generation;
        initialization = Promise.resolve()
          .then(() => {
            if (epoch !== generation)
              throw new DOMException(
                'Camera initialization cancelled',
                'AbortError',
              );
            return camera.init(viewer);
          })
          .catch((error) => {
            if (epoch === generation) initialization = null;
            throw error;
          });
      }
      try {
        await initialization;
      } catch (error) {
        initialized.delete(category);
        throw error;
      }
    },
    enable() {
      const wasEnabled = anyEnabled();
      enabled[category] = true;
      camera.setCameraCategoryEnabled(category, true);
      if (!wasEnabled) camera.enable();
    },
    disable() {
      enabled[category] = false;
      camera.setCameraCategoryEnabled(category, false);
      if (!anyEnabled()) camera.disable();
    },
    update() {
      // The regular camera row owns polling while both categories are on.
      if (enabled[category] && (category === 'general' || !enabled.general))
        return camera.update();
    },
    destroy(viewer) {
      enabled[category] = false;
      initialized.delete(category);
      camera.setCameraCategoryEnabled(category, false);
      if (!anyEnabled()) camera.disable();
      if (!initialized.size && coreLive) {
        generation++;
        camera.destroy(viewer);
        coreLive = false;
        initialization = null;
      }
    },
    getStats() {
      const stats = camera.getStats();
      return { ...stats, count: stats.categoryCounts?.[category] || 0 };
    },
    getDetectableObjects(options = {}) {
      if (!enabled[category]) return [];
      return camera.getDetectableObjects({ ...options, category });
    },
  });
  return {
    general: facet('general', {}),
    penndot: facet('penndot', {
      id: 'penndot-traffic-cams',
      name: msg('PennDOT Traffic Cams'),
      source: 'PennDOT / 511PA',
    }),
  };
}
