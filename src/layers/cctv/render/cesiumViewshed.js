import * as Cesium from 'cesium';
import { frustumVolumeGeometryData } from '../../../data/cctvViewshed.js';

/**
 * Builds the translucent frustum-volume primitive for one camera.
 * Synchronous (6 triangles — cheaper than the async geometry pipeline's
 * bookkeeping), unlit flat color, both faces visible (the viewer is routinely
 * inside or behind a cone), never pickable (clicks fall through to the
 * billboard/wireframe/plane, whose pick semantics are established).
 * @param {Object} positions - frustumCartesians shape (see frustumVolumeGeometryData).
 * @param {Cesium.Color} color - Per-camera fill color (already alpha'd).
 * @returns {Cesium.Primitive}
 */
export function createFrustumVolumePrimitive(positions, color) {
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
        color: Cesium.ColorGeometryInstanceAttribute.fromColor(color),
      },
    }),
    appearance: new Cesium.PerInstanceColorAppearance({
      flat: true,
      translucent: true,
      renderState: {
        cull: { enabled: false },
      },
    }),
    asynchronous: false,
    allowPicking: false,
  });
}
