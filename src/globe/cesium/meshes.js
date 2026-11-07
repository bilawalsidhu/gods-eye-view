import * as Cesium from 'cesium';
import { createMeshRegistry } from '../meshes.js';

/** World triangles with flat colour or a live image, drawn on both sides. */
export function createCesiumMeshes(viewer, { requestRender = () => {} } = {}) {
  let root;
  let removeFrame;
  const owned = new Map();
  const registry = createMeshRegistry((state) => {
    root ??= viewer.scene.primitives.add(new Cesium.PrimitiveCollection());
    let primitive;
    let material;
    removeFrame ??= viewer.scene.postRender.addEventListener(() => {
      for (const { state, backend } of registry.live.values()) {
        if (state.show && !backend.ready()) {
          requestRender('meshes');
          break;
        }
      }
    });
    function build(next) {
      const attributes = {
        position: new Cesium.GeometryAttribute({
          componentDatatype: Cesium.ComponentDatatype.DOUBLE,
          componentsPerAttribute: 3,
          values: next.positions,
        }),
      };
      if (next.uv)
        attributes.st = new Cesium.GeometryAttribute({
          componentDatatype: Cesium.ComponentDatatype.FLOAT,
          componentsPerAttribute: 2,
          values: next.uv,
        });
      const geometry = new Cesium.Geometry({
        attributes,
        indices: next.indices,
        primitiveType: Cesium.PrimitiveType.TRIANGLES,
        boundingSphere: Cesium.BoundingSphere.fromVertices(next.positions),
      });
      Cesium.GeometryPipeline.computeNormal(geometry);
      const color = new Cesium.Color(...next.color);
      const nextMaterial = next.image
        ? Cesium.Material.fromType('Image', {
            image: next.image,
            color,
            transparent: true,
          })
        : Cesium.Material.fromType('Color', { color });
      const nextPrimitive = new Cesium.Primitive({
        geometryInstances: new Cesium.GeometryInstance({
          geometry,
          id: next.pickId,
        }),
        appearance: new Cesium.MaterialAppearance({
          material: nextMaterial,
          materialSupport: next.image
            ? Cesium.MaterialAppearance.MaterialSupport.TEXTURED
            : Cesium.MaterialAppearance.MaterialSupport.BASIC,
          flat: true,
          faceForward: true,
          translucent: true,
          renderState: {
            cull: { enabled: false },
            depthTest: { enabled: next.depthTest !== 'always' },
            depthMask: false,
          },
        }),
        asynchronous: false,
        allowPicking: next.pickId != null,
        show: next.show,
      });
      nextPrimitive.gevMesh = next.id;
      root.add(nextPrimitive);
      if (primitive) {
        owned.delete(primitive);
        root.remove(primitive);
      }
      if (material && !material.isDestroyed()) material.destroy();
      primitive = nextPrimitive;
      material = nextMaterial;
      owned.set(primitive, state);
    }
    build(state);
    return {
      primitive: () => primitive,
      ready: () =>
        primitive.ready &&
        material._loadedImages.length === 0 &&
        (!state.image ||
          (material._textures.image &&
            material._textures.image !== material._defaultTexture &&
            (state.image.tagName === 'VIDEO' ||
              material._texturePaths.image === state.image))),
      update(next, patch) {
        if (
          ['positions', 'indices', 'uv', 'depthTest', 'pickId'].some(
            (key) => key in patch,
          ) ||
          Boolean(next.image) !== Boolean(state.image)
        )
          build(next);
        else {
          primitive.show = next.show;
          material.uniforms.color = new Cesium.Color(...next.color);
          if (next.image) {
            material.uniforms.image = next.image;
            if ('image' in patch) material._texturePaths.image = undefined;
          }
        }
      },
      destroy() {
        owned.delete(primitive);
        root.remove(primitive);
        if (!material.isDestroyed()) material.destroy();
        if (!registry.live.size) {
          removeFrame?.();
          removeFrame = null;
        }
      },
    };
  }, requestRender);
  return {
    meshes: registry.meshes,
    identify(picked) {
      const state = owned.get(picked?.primitive);
      return state
        ? {
            id: state.pickId,
            owner: state.id,
            visible: state.show,
            pickable: state.pickId != null,
          }
        : null;
    },
    primitiveOf(handle) {
      const entry = registry.live.get(handle?.id);
      return entry?.handle === handle ? entry.backend.primitive() : null;
    },
    destroy() {
      registry.destroy();
      removeFrame?.();
      removeFrame = null;
      if (root) viewer.scene.primitives.remove(root);
      root = null;
    },
  };
}
