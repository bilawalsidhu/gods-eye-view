import { Matrix4 } from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// Each DrapedMesh needs three stencil draws. Consecutive, equally coloured
// volumes with disjoint XY bounds can share those draws without changing
// translucent overlap order. Keep coordinates local to preserve precision.
// Consumes the input meshes; the returned meshes own the surviving resources.
export function batchInstallationOutlines(meshes) {
  const groups = [];
  for (const mesh of meshes) {
    const group = groups.at(-1);
    let geometry;
    if (
      group &&
      mesh.material.color.equals(group.mesh.material.color) &&
      mesh.material.opacity === group.mesh.material.opacity
    ) {
      const relative = new Matrix4().multiplyMatrices(
        group.inverse,
        mesh.matrix,
      );
      if (Math.hypot(...relative.elements.slice(12, 15)) <= 100_000) {
        geometry = mesh.geometry.clone().applyMatrix4(relative);
        geometry.computeBoundingBox();
        const b = geometry.boundingBox;
        if (
          group.bounds.every(
            (a) =>
              b.min.x > a.max.x ||
              b.max.x < a.min.x ||
              b.min.y > a.max.y ||
              b.max.y < a.min.y,
          )
        ) {
          group.geometries.push(geometry);
          group.bounds.push(b);
          group.mesh.userData.installationIds.push(
            mesh.userData.installationId,
          );
          mesh.geometry.dispose();
          mesh.material.dispose();
          continue;
        }
        geometry.dispose();
      }
    }
    mesh.geometry.computeBoundingBox();
    mesh.userData.installationIds = [mesh.userData.installationId];
    groups.push({
      mesh,
      inverse: mesh.matrix.clone().invert(),
      geometries: [mesh.geometry],
      bounds: [mesh.geometry.boundingBox],
    });
  }
  return groups.map(({ mesh, geometries }) => {
    if (geometries.length > 1) {
      mesh.geometry = mergeGeometries(geometries);
      for (const geometry of geometries) geometry.dispose();
    }
    return mesh;
  });
}
