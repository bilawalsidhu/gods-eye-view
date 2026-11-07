// The CCTV meshes the globe contract has no primitive for yet, behind one
// seam: the monitor plane (a quad textured with a live canvas or video) and
// the viewshed volume (the frustum pyramid in a flat translucent colour,
// both faces, not pickable). Movers draw a glTF per instance at a uniform
// scale and lines draw strips, so neither carries a texture that changes
// every frame or a pyramid whose corners move independently.
//
// This is the only CCTV module that reads engine.extensions. Each engine
// draws through its own backend: render/cesiumMeshes.js (Cesium entities and
// primitives) and render/navaraMeshes.js (three meshes in Navara's view),
// which the Navara mode loads and passes in, as Navara modules reach the app
// only through its import(). The handles here keep what the layer asked
// for, so an engine with no backend (the fake engine) draws nothing and
// still answers. The plane's outline is an engine line, drawn by the display.

import { createCctvCesiumMeshes } from './cesiumMeshes.js';

/**
 * @param {import('../../../globe/contract.js').GlobeEngine} engine
 * @param {{ navaraMeshes?: (engine: object, navara: object) => object }} [options]
 *   The Navara backend's factory (render/navaraMeshes.js).
 */
export function createCctvMeshes(engine, { navaraMeshes } = {}) {
  const cesium = engine.extensions?.cesium;
  const navara = engine.extensions?.navara;
  const materials = new Set();
  const planes = new Set();
  const volumes = new Set();
  const planeByNative = new Map();
  const backend = cesium
    ? createCctvCesiumMeshes(cesium)
    : navara && navaraMeshes
      ? navaraMeshes(engine, navara)
      : null;
  let destroyed = false;

  const alive = () => {
    if (destroyed) throw new Error('CCTV meshes are destroyed');
  };

  return {
    /** A plane material showing `image` (a canvas or video), or plain white. */
    createMaterial(image) {
      alive();
      const material = {
        image: image ?? null,
        native: null,
        disposed: false,
        setImage(next) {
          if (material.disposed) return;
          material.image = next;
          material.native?.setImage(next);
        },
        dispose() {
          if (material.disposed) return;
          material.disposed = true;
          materials.delete(material);
          material.native?.dispose();
          material.native = null;
        },
      };
      material.native = backend?.createMaterial(material.image) ?? null;
      materials.add(material);
      return material;
    },
    /**
     * The monitor plane, hidden: `shape` { halfW, halfH } metres, centred on
     * positions.capCenter, its local +Z along `orientation`'s normal.
     */
    createPlane(cameraId, material, shape, positions, orientation) {
      alive();
      if (!materials.has(material))
        throw new Error('CCTV plane material is not owned');
      const plane = {
        id: `cctv-${cameraId}-plane`,
        cameraId,
        material,
        shape,
        positions,
        orientation,
        visible: false,
        native: null,
        destroyed: false,
        get show() {
          return !plane.destroyed && plane.visible;
        },
        set show(value) {
          if (plane.destroyed) return;
          plane.visible = Boolean(value);
          if (plane.native) plane.native.show = plane.visible;
        },
        destroy() {
          if (plane.destroyed) return;
          plane.destroyed = true;
          planes.delete(plane);
          if (plane.native) {
            planeByNative.delete(plane.native);
            plane.native.destroy();
            plane.native = null;
          }
        },
      };
      if (backend) {
        plane.native = backend.createPlane(
          cameraId,
          material.native,
          shape,
          positions,
          orientation,
        );
        planeByNative.set(plane.native, plane);
      }
      planes.add(plane);
      return plane;
    },
    updatePlane(plane, shape, positions, orientation) {
      if (!planes.has(plane)) return;
      Object.assign(plane, { shape, positions, orientation });
      if (plane.native)
        backend.updatePlane(plane.native, shape, positions, orientation);
    },
    /** The viewshed volume over positions { mount, tl, tr, br, bl }. */
    createVolume(positions, tint) {
      alive();
      const volume = {
        positions,
        tint,
        native: null,
        destroyed: false,
        destroy() {
          if (volume.destroyed) return;
          volume.destroyed = true;
          volumes.delete(volume);
          volume.native?.destroy();
          volume.native = null;
        },
      };
      volume.native = backend?.createVolume(positions, tint) ?? null;
      volumes.add(volume);
      return volume;
    },
    /** The live, shown plane an engine pick result names, or null. */
    planeFromPick(picked) {
      if (!backend || !picked) return null;
      const plane = planeByNative.get(backend.planeFromPick(picked));
      return plane?.show ? plane : null;
    },
    /** What draws a plane or volume, for an engine `exclude` list. */
    drawnBy(handle) {
      return backend && handle?.native
        ? backend.drawnBy(handle.native)
        : undefined;
    },
    /**
     * The first scene object along a ray within `far` metres, skipping
     * `exclude` (pick ids and drawn objects), on an engine without
     * surface.raycast; undefined where the backend has no ray pick.
     */
    obstructionRay(origin, direction, far, exclude) {
      return backend?.obstructionRay?.(origin, direction, far, exclude);
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      for (const plane of [...planes]) plane.destroy();
      for (const volume of [...volumes]) volume.destroy();
      for (const material of [...materials]) material.dispose();
      backend?.destroy();
    },
  };
}
