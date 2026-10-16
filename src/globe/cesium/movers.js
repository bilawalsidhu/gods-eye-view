// engine.movers on Cesium: one primitive per set inside one engine-owned
// PrimitiveCollection (added to the scene with the first set, in `order`):
// sprites are a BillboardCollection (screen-aligned, rotation in screen
// space, an image per atlas cell), points a PointPrimitiveCollection,
// models one Model per instance in a PrimitiveCollection. commit() writes
// the changed instances and requests a render; nothing else renders.

import * as Cesium from 'cesium';
import { createMoverRegistry } from '../movers.js';

const scratchPosition = new Cesium.Cartesian3();
const scratchColor = new Cesium.Color();
const scratchQuaternion = new Cesium.Quaternion();
const scratchRotation = new Cesium.Matrix3();
// Model.modelMatrix and Model.color copy what they are given.
const scratchModelMatrix = new Cesium.Matrix4();

/** The atlas cells as canvases, by key (a DOM canvas or image source). */
async function cropAtlasCells(atlas, keys) {
  let image = atlas.canvas;
  if (!image) {
    image = new Image();
    image.crossOrigin = 'anonymous';
    image.src = atlas.url;
    await image.decode();
  }
  const width = image.width;
  const height = image.height;
  const cells = new Map();
  for (const key of keys) {
    const [u0, v0, u1, v1] = atlas.cells[key];
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round((u1 - u0) * width));
    canvas.height = Math.max(1, Math.round((v1 - v0) * height));
    canvas
      .getContext('2d')
      .drawImage(
        image,
        u0 * width,
        v0 * height,
        canvas.width,
        canvas.height,
        0,
        0,
        canvas.width,
        canvas.height,
      );
    cells.set(key, canvas);
  }
  return cells;
}

const DEFAULT_FACTORIES = {
  billboards: (scene) => new Cesium.BillboardCollection({ scene }),
  points: () => new Cesium.PointPrimitiveCollection(),
  models: () => new Cesium.PrimitiveCollection({ destroyPrimitives: true }),
  loadModel: (options) => Cesium.Model.fromGltfAsync(options),
  cropCells: cropAtlasCells,
};

const depthTestDistance = (depthTest) =>
  depthTest === 'always'
    ? Number.POSITIVE_INFINITY
    : depthTest === 'normal'
      ? 0
      : depthTest.disableWithinM;

const nearFar = (value) =>
  value ? new Cesium.NearFarScalar(...value) : undefined;

function readPosition(store, index) {
  const { positions } = store;
  return Cesium.Cartesian3.fromElements(
    positions[index * 3],
    positions[index * 3 + 1],
    positions[index * 3 + 2],
    scratchPosition,
  );
}

function readColor(store, index) {
  const { colors } = store;
  scratchColor.red = colors[index * 4];
  scratchColor.green = colors[index * 4 + 1];
  scratchColor.blue = colors[index * 4 + 2];
  scratchColor.alpha = colors[index * 4 + 3];
  return scratchColor;
}

function spritePart(scene, options, store, factories, requestRender, owners) {
  const collection = factories.billboards(scene);
  const { sprite, depthTest, id } = options;
  const style = {
    width: sprite.sizePx,
    height: sprite.sizePx,
    scaleByDistance: nearFar(sprite.scaleByDistance),
    disableDepthTestDistance: depthTestDistance(depthTest),
  };
  const billboards = [];
  const shownCell = [];
  let cells = null;
  let destroyed = false;
  const apply = (from, to) => {
    for (let index = from; index < to; index++) {
      let billboard = billboards[index];
      if (index >= store.count) {
        if (billboard) billboard.show = false;
        continue;
      }
      if (!billboard) {
        billboard = collection.add({ ...style });
        billboards[index] = billboard;
        owners.set(billboard, { owner: id, instance: index });
        shownCell[index] = -1;
      }
      billboard.position = readPosition(store, index);
      billboard.rotation = store.rotations[index];
      billboard.scale = store.scales[index];
      billboard.color = readColor(store, index);
      billboard.show = store.shows[index] === 1;
      billboard.id = store.pickIds[index];
      const cell = store.cells[index];
      if (shownCell[index] !== cell) {
        const key = store.cellKeys[cell];
        billboard.setImage(`${id}:${key}`, cells.get(key));
        shownCell[index] = cell;
      }
    }
  };
  // Instances wait for the atlas; then everything drawn so far is applied.
  factories
    .cropCells(sprite.atlas, store.cellKeys)
    .then((ready) => {
      if (destroyed) return;
      cells = ready;
      apply(0, Math.max(store.count, billboards.length));
      requestRender('movers');
    })
    .catch((error) => console.warn(`[movers] ${id}: atlas failed`, error));
  return {
    primitive: collection,
    ready: () => cells !== null,
    commit(range) {
      if (cells && range) apply(range.from, range.to);
      requestRender('movers');
    },
    destroy() {
      destroyed = true;
      billboards.length = 0;
      shownCell.length = 0;
      cells = null;
    },
  };
}

function pointPart(options, store, factories, requestRender, owners) {
  const collection = factories.points();
  const { point, depthTest } = options;
  const style = {
    outlineWidth: point.outlinePx,
    outlineColor: Cesium.Color.BLACK,
    scaleByDistance: nearFar(point.scaleByDistance),
    disableDepthTestDistance: depthTestDistance(depthTest),
  };
  const points = [];
  return {
    primitive: collection,
    commit(range) {
      if (range)
        for (let index = range.from; index < range.to; index++) {
          let item = points[index];
          if (index >= store.count) {
            if (item) item.show = false;
            continue;
          }
          if (!item) {
            item = collection.add({ ...style });
            points[index] = item;
            owners.set(item, { owner: options.id, instance: index });
          }
          item.position = readPosition(store, index);
          item.pixelSize = point.sizePx * store.scales[index];
          item.color = readColor(store, index);
          item.show = store.shows[index] === 1;
          item.id = store.pickIds[index];
        }
      requestRender('movers');
    },
    destroy() {
      points.length = 0;
    },
  };
}

function modelPart(options, store, factories, requestRender, owners) {
  const collection = factories.models();
  const { model } = options;
  const blendMode =
    model.colorBlend?.mode === 'replace'
      ? Cesium.ColorBlendMode.REPLACE
      : Cesium.ColorBlendMode.MIX;
  const models = [];
  const loading = [];
  let destroyed = false;
  const place = (item, index) => {
    const { orientations } = store;
    scratchQuaternion.x = orientations[index * 4];
    scratchQuaternion.y = orientations[index * 4 + 1];
    scratchQuaternion.z = orientations[index * 4 + 2];
    scratchQuaternion.w = orientations[index * 4 + 3];
    item.modelMatrix = Cesium.Matrix4.fromRotationTranslation(
      Cesium.Matrix3.fromQuaternion(scratchQuaternion, scratchRotation),
      readPosition(store, index),
      scratchModelMatrix,
    );
    item.scale = store.scales[index];
    item.show = index < store.count && store.shows[index] === 1;
    item.id = store.pickIds[index];
    if (model.colorBlend) item.color = readColor(store, index);
  };
  const ensure = (index) => {
    if (models[index] || loading[index]) return;
    loading[index] = true;
    factories
      .loadModel({
        url: model.url,
        minimumPixelSize: model.minimumPixelSize,
        maximumScale: Number.isFinite(model.maximumScale)
          ? model.maximumScale
          : undefined,
        colorBlendMode: blendMode,
        colorBlendAmount: model.colorBlend?.amount ?? 0.5,
        ...(model.unlit
          ? {
              customShader: new Cesium.CustomShader({
                lightingModel: Cesium.LightingModel.UNLIT,
              }),
            }
          : {}),
      })
      .then((item) => {
        if (destroyed) {
          item.destroy?.();
          return;
        }
        models[index] = item;
        owners.set(item, { owner: options.id, instance: index });
        place(item, index);
        collection.add(item);
        requestRender('movers');
      })
      .catch((error) =>
        console.warn(`[movers] ${options.id}: model failed`, error),
      );
  };
  return {
    primitive: collection,
    ready() {
      for (let index = 0; index < store.count; index++)
        if (!models[index]?.ready) return false;
      return true;
    },
    commit(range) {
      if (range)
        for (let index = range.from; index < range.to; index++) {
          if (index < store.count) ensure(index);
          if (models[index]) place(models[index], index);
        }
      requestRender('movers');
    },
    destroy() {
      destroyed = true;
      models.length = 0;
      loading.length = 0;
    },
  };
}

/**
 * @param {Cesium.Viewer} viewer
 * @param {{ requestRender?: (reason: string) => void, factories?: object }} [options]
 *   `factories` (collections, model loading, atlas cropping) is a test seam.
 * @returns {{ movers: import('../contract.js').GlobeMovers, destroy: () => void }}
 */
export function createCesiumMovers(
  viewer,
  { requestRender = () => viewer.scene.requestRender(), factories = {} } = {},
) {
  const make = { ...DEFAULT_FACTORIES, ...factories };
  const { scene } = viewer;
  let root = null;
  const ordered = [];
  // Billboard, point or model → its set and instance, for picks.
  const owners = new WeakMap();
  const rootCollection = () => {
    if (!root) {
      root = new Cesium.PrimitiveCollection({ destroyPrimitives: true });
      scene.primitives.add(root);
    }
    return root;
  };
  const registry = createMoverRegistry((options, store) => {
    const part =
      options.kind === 'sprite'
        ? spritePart(scene, options, store, make, requestRender, owners)
        : options.kind === 'point'
          ? pointPart(options, store, make, requestRender, owners)
          : modelPart(options, store, make, requestRender, owners);
    const { primitive } = part;
    primitive.gevMoverSet = options.id;
    // Later (higher) order draws later: after every set of lower or equal order.
    const at = ordered.filter((entry) => entry.order <= options.order).length;
    ordered.splice(at, 0, { order: options.order, primitive });
    rootCollection().add(primitive, at);
    return {
      primitive,
      ready: part.ready,
      commit: () => part.commit(store.dirty()),
      destroy() {
        part.destroy();
        ordered.splice(
          ordered.findIndex((entry) => entry.primitive === primitive),
          1,
        );
        root.remove(primitive);
        requestRender('movers');
      },
    };
  });
  return {
    movers: registry.movers,
    /** Where an instance of a set is (a geo Cartesian3), or null. */
    instancePosition(owner, instance) {
      const entry = registry.sets.get(owner);
      if (!entry || !(instance < entry.store.count)) return null;
      const view = entry.store.positionsView();
      const at = 3 * instance;
      return { x: view[at], y: view[at + 1], z: view[at + 2] };
    },
    /** The primitive drawing a live mover set of this engine, or null. */
    primitiveOf(set) {
      const entry = set?.id ? registry.sets.get(set.id) : null;
      return entry && entry.set === set ? entry.part.primitive : null;
    },
    /** The set and instance a Cesium pick result belongs to, or null. */
    identify(picked) {
      const known = picked?.primitive ? owners.get(picked.primitive) : null;
      const entry = known && registry.sets.get(known.owner);
      return entry ? { ...known, pickable: entry.options.pickable } : null;
    },
    destroy() {
      registry.destroyAll();
      if (root) {
        scene.primitives.remove(root);
        root = null;
      }
    },
  };
}
