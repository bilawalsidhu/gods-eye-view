// CCTV's live monitor quad and translucent viewshed triangles.
import * as geo from '../../../geo/index.js';
import { frustumVolumeGeometryData } from '../../../data/cctvViewshed.js';
import { PLANE_IMAGE_ALPHA } from './style.js';

function planeGeometry(shape, positions, orientation) {
  const rotation = geo.matrix3.fromQuaternion(
    orientation,
    geo.matrix3.create(),
  );
  const flat = [];
  for (const [x, y] of [
    [-1, 1],
    [1, 1],
    [-1, -1],
    [1, -1],
  ]) {
    const p = geo.matrix3.multiplyByVector(
      rotation,
      { x: x * shape.halfW, y: y * shape.halfH, z: 0 },
      geo.cartesian3.create(),
    );
    geo.cartesian3.add(p, positions.capCenter, p);
    flat.push(p.x, p.y, p.z);
  }
  return {
    positions: flat,
    indices: [0, 2, 1, 2, 3, 1],
    uv: [0, 1, 1, 1, 0, 0, 1, 0],
  };
}

export function createCctvMeshes(engine) {
  const materials = new Set();
  const planes = new Set();
  const volumes = new Set();
  let destroyed = false;
  let volumeId = 0;
  const alive = () => {
    if (destroyed) throw new Error('CCTV meshes are destroyed');
  };
  const appearance = (material) => ({
    image: material.image,
    color: [1, 1, 1, material.image ? PLANE_IMAGE_ALPHA : 1],
  });
  return {
    createMaterial(image) {
      alive();
      const material = {
        image: image ?? null,
        disposed: false,
        setImage(next) {
          if (material.disposed) return;
          material.image = next;
          for (const plane of planes)
            if (plane.material === material)
              plane.mesh.update(appearance(material));
        },
        dispose() {
          if (material.disposed) return;
          material.disposed = true;
          materials.delete(material);
        },
      };
      materials.add(material);
      return material;
    },
    createPlane(cameraId, material, shape, positions, orientation) {
      alive();
      if (!materials.has(material))
        throw new Error('CCTV plane material is not owned');
      const id = `cctv-${cameraId}-plane`;
      const mesh = engine.meshes.createMesh({
        id,
        pickId: id,
        show: false,
        ...planeGeometry(shape, positions, orientation),
        ...appearance(material),
      });
      const plane = {
        id,
        cameraId,
        material,
        shape,
        positions,
        orientation,
        mesh,
        destroyed: false,
        get show() {
          return mesh.show();
        },
        set show(value) {
          mesh.show(value);
        },
        destroy() {
          if (plane.destroyed) return;
          plane.destroyed = true;
          planes.delete(plane);
          mesh.destroy();
        },
      };
      planes.add(plane);
      return plane;
    },
    updatePlane(plane, shape, positions, orientation) {
      if (!planes.has(plane)) return;
      plane.mesh.update(planeGeometry(shape, positions, orientation));
      Object.assign(plane, { shape, positions, orientation });
    },
    createVolume(positions, tint) {
      alive();
      const mesh = engine.meshes.createMesh({
        id: `cctv-volume-${++volumeId}`,
        ...frustumVolumeGeometryData(positions),
        color: tint.rgba(),
      });
      const volume = {
        positions,
        tint,
        mesh,
        destroyed: false,
        destroy() {
          if (volume.destroyed) return;
          volume.destroyed = true;
          volumes.delete(volume);
          mesh.destroy();
        },
      };
      volumes.add(volume);
      return volume;
    },
    planeFromPick(picked) {
      return (
        [...planes].find(
          (plane) =>
            plane.show &&
            plane.id === picked?.id &&
            (picked.owner == null || picked.owner === plane.id),
        ) ?? null
      );
    },
    drawnBy: (handle) => handle?.mesh,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      for (const plane of [...planes]) plane.destroy();
      for (const volume of [...volumes]) volume.destroy();
      for (const material of [...materials]) material.dispose();
    },
  };
}
