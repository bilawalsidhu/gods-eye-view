// GlobePicker on a Cesium scene. Pick results keep Cesium's `id`,
// `primitive` and `content` (3D tile content, read by surface-pick checks);
// the untouched Cesium result rides along as `object` for Cesium-only callers.

import { toCesium2, toGeo3 } from './convert.js';

/**
 * @param {Cesium.Viewer} viewer
 * @param {{ identify?: (picked: object) => ({ owner: string, instance?: number } | null) }} [options]
 *   `identify` names the mover set or line (and instance) a pick belongs to.
 * @returns {{ picker: object, destroy: () => void }}
 */
export function createCesiumPicker(viewer, { identify = () => null } = {}) {
  const normalise = (picked) => {
    if (picked == null) return undefined;
    const known = identify(picked);
    // A mover set created with pickable: false is not picked (Cesium's GPU
    // pick sees every primitive; Navara's only the pickable ones).
    if (known?.pickable === false) return undefined;
    return {
      id: picked.id,
      primitive: picked.primitive,
      content: picked.content,
      object: picked,
      ...(known
        ? {
            owner: known.owner,
            ...(known.instance !== undefined
              ? { instance: known.instance }
              : {}),
          }
        : {}),
    };
  };
  const { scene } = viewer;
  const picker = {
    pick(screen, width, height) {
      return normalise(scene.pick(toCesium2(screen), width, height));
    },
    drillPick(screen, limit, width, height) {
      return scene
        .drillPick(toCesium2(screen), limit, width, height)
        .map(normalise)
        .filter(Boolean);
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
    pickGlobe(screen) {
      if (!scene.globe) return undefined;
      try {
        const camera = viewer.camera ?? scene.camera;
        const ray = camera.getPickRay(toCesium2(screen));
        return ray ? toGeo3(scene.globe.pick(ray, scene)) : undefined;
      } catch {
        return undefined;
      }
    },
  };
  return { picker, destroy() {} };
}
