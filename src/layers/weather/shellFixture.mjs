import * as Cesium from 'cesium';

/** Test double for the Cesium classes a weather shell constructs. */
export function createShellCesium({ maximumTextureSize = 0 } = {}) {
  const templates = new Map();
  const created = { materials: [], primitives: [], appearances: [] };
  class Material {
    constructor(options) {
      const template = templates.get(options.fabric.type);
      this.options = options;
      this.uniforms = {
        ...template.fabric.uniforms,
        imageDimensions: { type: 'ivec3', x: 1, y: 1 },
        detailDimensions: { type: 'ivec3', x: 1, y: 1 },
      };
      this.destroyed = false;
      created.materials.push(this);
    }
    isDestroyed() {
      return this.destroyed;
    }
    destroy() {
      this.destroyed = true;
    }
  }
  Material.DefaultImageId = Cesium.Material.DefaultImageId;
  Material._materialCache = {
    getMaterial: (type) => templates.get(type),
    addMaterial: (type, template) => templates.set(type, template),
  };
  class Primitive {
    constructor(options) {
      this.options = options;
      this.appearance = options.appearance;
      this.show = options.show ?? true;
      this.ready = false;
      this.destroyed = false;
      created.primitives.push(this);
    }
    isDestroyed() {
      return this.destroyed;
    }
    destroy() {
      this.destroyed = true;
    }
  }
  class EllipsoidSurfaceAppearance {
    constructor(options) {
      this.options = options;
      this.material = options.material;
      created.appearances.push(this);
    }
  }
  EllipsoidSurfaceAppearance.VERTEX_FORMAT =
    Cesium.EllipsoidSurfaceAppearance.VERTEX_FORMAT;
  class RectangleGeometry {
    constructor(options) {
      this.options = options;
    }
  }
  class GeometryInstance {
    constructor(options) {
      this.geometry = options.geometry;
    }
  }
  return {
    Material,
    Primitive,
    EllipsoidSurfaceAppearance,
    RectangleGeometry,
    GeometryInstance,
    BlendingState: Cesium.BlendingState,
    Cartesian4: Cesium.Cartesian4,
    Math: Cesium.Math,
    Rectangle: Cesium.Rectangle,
    ContextLimits: { maximumTextureSize },
    created,
    templates,
  };
}

/** A scene with an ordered primitive collection that destroys on remove. */
export function createShellScene() {
  const items = [];
  const listeners = new Set();
  let renders = 0;
  return {
    primitives: {
      items,
      add(primitive) {
        items.push(primitive);
        return primitive;
      },
      remove(primitive) {
        const index = items.indexOf(primitive);
        if (index < 0) return false;
        items.splice(index, 1);
        primitive.destroy();
        return true;
      },
      contains: (primitive) => items.includes(primitive),
      get: (index) => items[index],
      get length() {
        return items.length;
      },
      lowerToBottom(primitive) {
        const index = items.indexOf(primitive);
        if (index >= 0) items.unshift(...items.splice(index, 1));
      },
      isDestroyed: () => false,
    },
    postRender: {
      addEventListener(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      emit() {
        for (const listener of [...listeners]) listener();
      },
      get size() {
        return listeners.size;
      },
    },
    requestRender() {
      renders++;
    },
    get renders() {
      return renders;
    },
  };
}

/** Render: finish asynchronous geometry, upload each shown material's images.
 * An image uniform back at the default binds Cesium's 1×1 texture. */
export function renderShells(cesium, scene, count = 4) {
  for (let i = 0; i < count; i++) {
    for (const primitive of cesium.created.primitives) {
      if (primitive.destroyed || !primitive.show) continue;
      primitive.ready = true;
      const { uniforms } = primitive.appearance.material;
      for (const name of ['image', 'detail']) {
        const dimensions = uniforms[`${name}Dimensions`];
        if (!dimensions) continue;
        const bound =
          typeof uniforms[name] === 'object'
            ? uniforms[name]
            : { width: 1, height: 1 };
        dimensions.x = bound.width;
        dimensions.y = bound.height;
      }
    }
    scene.postRender.emit();
  }
}
