// GlobePicker on a Cesium scene. Pick results keep Cesium's `id`,
// `primitive` and `content` (3D tile content, read by surface-pick checks);
// the untouched Cesium result rides along as `object` for Cesium-only callers.
// A pick of an engine mover or line (`identify`) names its owner and
// instance and returns the pickId the layer gave it as `id`, as on Navara.

import { toCesium2, toGeo3 } from './convert.js';

/**
 * @param {Cesium.Viewer} viewer
 * @param {{
 *   identify?: (picked: object) => ({ owner: string, instance?: number, id: any, pickable?: boolean, visible?: boolean } | null),
 * }} [options]
 *   `identify` names the mover set or line (and instance) a pick belongs to,
 *   with its pickId; `pickable: false` (a set made without pickable) and
 *   `visible: false` (an instance behind the horizon, which Cesium's GPU
 *   pick sees through the globe when drawn without a depth test) drop it.
 * @returns {{ picker: object, destroy: () => void }}
 */
export function createCesiumPicker(viewer, { identify = () => null } = {}) {
  const normalise = (picked) => {
    if (picked == null) return undefined;
    // The follow camera's proxy entity (follow.js) is not an object.
    if (picked.id?.gevFollowProxy) return undefined;
    const known = identify(picked);
    if (known && (known.pickable === false || known.visible === false))
      return undefined;
    return {
      id: known ? known.id : picked.id,
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
  const drill = (screen, limit, width, height) =>
    scene
      .drillPick(toCesium2(screen), limit, width, height)
      .map(normalise)
      .filter(Boolean);
  const picker = {
    pick(screen, width, height) {
      const top = scene.pick(toCesium2(screen), width, height);
      if (top == null) return undefined;
      const picked = normalise(top);
      if (picked) return picked;
      // The top result is filtered (the follow proxy, an unpickable or
      // hidden mover): what lies under it, the first with an id (an
      // object), else the first kept (map tiles).
      const under = drill(screen, undefined, width, height);
      return under.find((entry) => entry.id !== undefined) ?? under[0];
    },
    drillPick(screen, limit, width, height) {
      return drill(screen, limit, width, height);
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
        const ray = viewer.camera.getPickRay(toCesium2(screen));
        return ray ? toGeo3(scene.globe.pick(ray, scene)) : undefined;
      } catch {
        return undefined;
      }
    },
  };
  return { picker, destroy() {} };
}
