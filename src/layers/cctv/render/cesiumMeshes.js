// The CCTV meshes on Cesium (behind render/meshes.js): the monitor plane is
// a plane Entity with an image material, the viewshed volume a synchronous
// Primitive of six triangles in a flat translucent colour, both faces drawn,
// never picked. The activation probe's ray pick lives here too, while the
// Cesium engine has no surface.raycast.

import * as Cesium from 'cesium';
import { frustumVolumeGeometryData } from '../../../data/cctvViewshed.js';
import { PLANE_IMAGE_ALPHA } from './style.js';

const toColor = (tint) => new Cesium.Color(...tint.rgba());

/** The frustum volume's Primitive over positions { mount, tl, tr, br, bl }. */
export function createFrustumVolumePrimitive(positions, tint) {
  const { positions: flat, indices } = frustumVolumeGeometryData(positions);
  const geometry = new Cesium.Geometry({
    attributes: {
      position: new Cesium.GeometryAttribute({
        componentDatatype: Cesium.ComponentDatatype.DOUBLE,
        componentsPerAttribute: 3,
        values: flat,
      }),
    },
    indices,
    primitiveType: Cesium.PrimitiveType.TRIANGLES,
    boundingSphere: Cesium.BoundingSphere.fromVertices(Array.from(flat)),
  });
  return new Cesium.Primitive({
    geometryInstances: new Cesium.GeometryInstance({
      geometry,
      attributes: {
        color: Cesium.ColorGeometryInstanceAttribute.fromColor(toColor(tint)),
      },
    }),
    appearance: new Cesium.PerInstanceColorAppearance({
      flat: true,
      translucent: true,
      // The camera is routinely inside or behind a cone.
      renderState: { cull: { enabled: false } },
    }),
    asynchronous: false,
    // Clicks fall through to the markers, wedges and plane.
    allowPicking: false,
  });
}

/**
 * @param {{ viewer: Cesium.Viewer }} cesium The engine's Cesium extension.
 */
export function createCctvCesiumMeshes({ viewer: { entities, scene } }) {
  const planes = new Map();
  const volumes = new Set();
  const dimensions = (shape) =>
    new Cesium.Cartesian2(shape.halfW * 2, shape.halfH * 2);
  return {
    createMaterial(image) {
      const property = image
        ? new Cesium.ImageMaterialProperty({
            image,
            transparent: true,
            color: Cesium.Color.WHITE.withAlpha(PLANE_IMAGE_ALPHA),
          })
        : new Cesium.ColorMaterialProperty(Cesium.Color.WHITE);
      return {
        property,
        setImage(next) {
          property.image = next;
        },
        dispose() {},
      };
    },
    createPlane(cameraId, material, shape, positions, orientation) {
      const entity = entities.add({
        id: `cctv-${cameraId}-plane`,
        show: false,
        position: positions.capCenter,
        orientation: Cesium.Quaternion.clone(orientation),
        plane: {
          plane: new Cesium.Plane(Cesium.Cartesian3.UNIT_Z, 0.0),
          dimensions: dimensions(shape),
          material: material.property,
        },
      });
      const plane = {
        entity,
        get show() {
          return entity.show;
        },
        set show(value) {
          entity.show = value;
        },
        destroy() {
          if (!planes.delete(entity)) return;
          if (entities.getById(entity.id) === entity) entities.remove(entity);
        },
      };
      planes.set(entity, plane);
      return plane;
    },
    updatePlane({ entity }, shape, positions, orientation) {
      entity.position = positions.capCenter;
      entity.orientation = Cesium.Quaternion.clone(orientation);
      if (entity.plane) entity.plane.dimensions = dimensions(shape);
    },
    createVolume(positions, tint) {
      const primitive = createFrustumVolumePrimitive(positions, tint);
      scene.primitives.add(primitive);
      volumes.add(primitive);
      return {
        primitive,
        destroy() {
          if (volumes.delete(primitive)) scene.primitives.remove(primitive);
        },
      };
    },
    // The engine's pick result keeps Cesium's own id: the plane Entity.
    planeFromPick: (picked) => planes.get(picked.id) ?? null,
    drawnBy: (native) => native.entity ?? native.primitive,
    obstructionRay(origin, direction, far, exclude) {
      if (!scene.pickFromRay) return undefined;
      const hit = scene.pickFromRay(new Cesium.Ray(origin, direction), exclude);
      return hit?.position &&
        Cesium.Cartesian3.distance(origin, hit.position) <= far
        ? hit
        : undefined;
    },
    destroy() {
      for (const plane of [...planes.values()]) plane.destroy();
      for (const primitive of volumes) scene.primitives.remove(primitive);
      volumes.clear();
    },
  };
}
