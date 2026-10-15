// GlobePicker on a Cesium scene. Pick results keep Cesium's `id` and
// `primitive`; the untouched Cesium result rides along as `object` for
// Cesium-only callers.

import { toCesium2, toGeo3 } from './convert.js';

const normalise = (picked) =>
  picked == null
    ? undefined
    : { id: picked.id, primitive: picked.primitive, object: picked };

/**
 * @param {Cesium.Viewer} viewer
 * @returns {{ picker: object, destroy: () => void }}
 */
export function createCesiumPicker(viewer) {
  const { scene } = viewer;
  const picker = {
    pick(screen, width, height) {
      return normalise(scene.pick(toCesium2(screen), width, height));
    },
    drillPick(screen, limit) {
      return scene.drillPick(toCesium2(screen), limit).map(normalise);
    },
    pickPosition(screen) {
      if (!scene.pickPositionSupported) return undefined;
      try {
        // A new Cesium.Cartesian2 per call: Cesium caches by its toString().
        return toGeo3(scene.pickPosition(toCesium2(screen)));
      } catch {
        return undefined;
      }
    },
    get pickPositionSupported() {
      return Boolean(scene.pickPositionSupported);
    },
  };
  return { picker, destroy() {} };
}
