// engine.movers on Cesium: one primitive per set inside one engine-owned
// PrimitiveCollection (added to the scene with the first set, in `order`):
// sprites are a BillboardCollection (screen-aligned, rotation in screen
// space, an image per atlas cell cropped from the set's atlas), points a
// PointPrimitiveCollection, models one Model per instance in a
// PrimitiveCollection (the glTF's own axes, no axis correction, lit without
// Cesium's dynamic environment map). commit() writes the changed instances
// and requests a render; nothing else renders. Picks resolve through
// identify(): the billboard, point or model a Cesium pick names → its set,
// instance and the pickId the layer gave it.

import * as Cesium from 'cesium';
import { horizonVisible } from '../cameraMath.js';
import { createMoverRegistry, createMoverRetry } from '../movers.js';

let scratchPosition;
let scratchColor;
let scratchQuaternion;
let scratchRotation;

/**
 * The atlas cells as canvases, by key. The atlas is a canvas or an image URL;
 * cells are [u0, v0, u1, v1] in 0..1 with v down from the image top.
 */
async function cropAtlasCells(atlas, keys) {
  let image = atlas.canvas;
  if (!image) {
    image = new Image();
    image.crossOrigin = 'anonymous';
    image.src = atlas.url;
    await image.decode();
  }
  const { width, height } = image;
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

/** Cesium's disableDepthTestDistance for a set's depthTest. */
export const depthTestDistance = (depthTest) =>
  depthTest === 'always'
    ? Number.POSITIVE_INFINITY
    : depthTest === 'normal'
      ? 0
      : depthTest.disableWithinM;

const nearFar = (value) =>
  value ? new Cesium.NearFarScalar(...value) : undefined;

/**
 * A model set's colour blend as Cesium Model options. Without colorBlend the
 * instance colour only sets the alpha (MIX by 0), as on Navara.
 */
function modelBlend(colorBlend) {
  if (!colorBlend)
    return { colorBlendMode: Cesium.ColorBlendMode.MIX, colorBlendAmount: 0 };
  return colorBlend.mode === 'replace'
    ? { colorBlendMode: Cesium.ColorBlendMode.REPLACE, colorBlendAmount: 1 }
    : {
        colorBlendMode: Cesium.ColorBlendMode.MIX,
        colorBlendAmount: colorBlend.amount,
      };
}

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

function spritePart(scene, options, store, ports) {
  const { factories, requestRender, owners } = ports;
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
        // One image per cell in the collection's texture atlas.
        billboard.setImage(`${id}:${key}`, cells.get(key));
        shownCell[index] = cell;
      }
    }
  };
  // Instances wait for the atlas; then everything written so far is applied.
  const retry = createMoverRetry(options.retryAfterMs, () => {
    factories
      .cropCells(sprite.atlas, store.cellKeys)
      .then((ready) => {
        if (destroyed) return;
        cells = ready;
        retry.succeed();
        apply(0, Math.max(store.count, billboards.length));
        requestRender('movers');
      })
      .catch((error) => {
        if (destroyed) return;
        retry.fail();
        console.warn(`[movers] ${id}: atlas failed`, error);
      });
  });
  retry.start();
  return {
    primitive: collection,
    ready: () => cells !== null,
    failed: retry.failed,
    commit(range) {
      if (cells && range) apply(range.from, range.to);
      requestRender('movers');
    },
    destroy() {
      destroyed = true;
      retry.destroy();
      billboards.length = 0;
      shownCell.length = 0;
      cells = null;
    },
  };
}

function pointPart(options, store, { factories, requestRender, owners }) {
  const collection = factories.points();
  const { point, depthTest } = options;
  // pixelSize is the filled diameter; Cesium adds outlineWidth on each side.
  const style = {
    outlineWidth: point.outlinePx,
    outlineColor: new Cesium.Color(...point.outlineColor),
    scaleByDistance: nearFar(point.scaleByDistance),
    translucencyByDistance: nearFar(point.translucencyByDistance),
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
          item.outlineColor = Cesium.Color.unpack(
            store.outlineColors,
            index * 4,
          );
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

function modelPart(options, store, { factories, requestRender, owners }) {
  const collection = factories.models();
  const { model, pickable } = options;
  const models = [];
  const loads = [];
  const current = (index) =>
    loads[index]?.pickId === store.pickIds[index] ? loads[index] : null;
  let destroyed = false;
  const place = (item, index) => {
    const { orientations } = store;
    scratchQuaternion.x = orientations[index * 4];
    scratchQuaternion.y = orientations[index * 4 + 1];
    scratchQuaternion.z = orientations[index * 4 + 2];
    scratchQuaternion.w = orientations[index * 4 + 3];
    // Written in place: Model keeps the matrix it is given (and notices a
    // change on its next update); Model.color copies.
    Cesium.Matrix4.fromRotationTranslation(
      Cesium.Matrix3.fromQuaternion(scratchQuaternion, scratchRotation),
      readPosition(store, index),
      item.modelMatrix,
    );
    item.scale = store.scales[index];
    item.show = index < store.count && store.shows[index] === 1;
    item.id = store.pickIds[index];
    item.color = readColor(store, index);
  };
  const ensure = (index) => {
    if (current(index)) return;
    loads[index]?.retry.destroy();
    if (models[index]) collection.remove(models[index]);
    models[index] = null;
    const entry = { pickId: store.pickIds[index], retry: null };
    loads[index] = entry;
    const live = () => !destroyed && current(index) === entry;
    entry.retry = createMoverRetry(options.retryAfterMs, () => {
      if (!live()) return;
      factories
        .loadModel({
          url: model.url,
          // Resources built at once, not spread over frames behind tile jobs.
          asynchronous: false,
          // The instance orientation turns the glTF's own axes (the contract's
          // model frame), as Navara draws them.
          upAxis: Cesium.Axis.Z,
          forwardAxis: Cesium.Axis.X,
          // Navara has no environment map; Cesium's renders the sky around
          // each model and reads it back from the GPU.
          environmentMapOptions: { enabled: false },
          minimumPixelSize: model.minimumPixelSize,
          ...modelBlend(model.colorBlend),
          allowPicking: pickable,
          ...(model.unlit
            ? {
                customShader: new Cesium.CustomShader({
                  lightingModel: Cesium.LightingModel.UNLIT,
                }),
              }
            : {}),
        })
        .then((item) => {
          if (!live()) {
            item.destroy?.();
            return;
          }
          models[index] = item;
          entry.retry.succeed();
          owners.set(item, { owner: options.id, instance: index });
          place(item, index);
          collection.add(item);
          requestRender('movers');
        })
        .catch((error) => {
          if (!live()) return;
          entry.retry.fail();
          console.warn(`[movers] ${options.id}: model failed`, error);
        });
    });
    entry.retry.start();
  };
  return {
    primitive: collection,
    // Every drawn instance's model has loaded (with an index, that one's).
    ready(index) {
      if (index !== undefined)
        return Boolean(current(index)) && models[index]?.ready === true;
      for (let at = 0; at < store.count; at++)
        if (!current(at) || !models[at]?.ready) return false;
      return true;
    },
    failed(index) {
      if (index !== undefined) return current(index)?.retry.failed() === true;
      for (let at = 0; at < store.count; at++)
        if (current(at)?.retry.failed()) return true;
      return false;
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
      for (const entry of loads) entry?.retry.destroy();
      models.length = 0;
      loads.length = 0;
    },
  };
}

/**
 * @param {Cesium.Viewer} viewer
 * @param {{ requestRender?: (reason: string) => void, factories?: object }} [options]
 *   `factories` (collections, model loading, atlas cropping) is a test seam.
 * @returns {{ movers: import('../contract.js').GlobeMovers,
 *   identify: (picked: object) => ({ owner: string, instance: number, id: any, pickable: boolean, visible: boolean } | null),
 *   primitiveOf: (set: object) => (object | null), destroy: () => void }}
 */
export function createCesiumMovers(
  viewer,
  { requestRender = () => viewer.scene.requestRender(), factories = {} } = {},
) {
  scratchPosition ??= new Cesium.Cartesian3();
  scratchColor ??= new Cesium.Color();
  scratchQuaternion ??= new Cesium.Quaternion();
  scratchRotation ??= new Cesium.Matrix3();
  const ports = {
    factories: { ...DEFAULT_FACTORIES, ...factories },
    requestRender,
    // Billboard, point or model → its set and instance, for picks.
    owners: new WeakMap(),
  };
  const { scene } = viewer;
  let root = null;
  const ordered = [];
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
        ? spritePart(scene, options, store, ports)
        : options.kind === 'point'
          ? pointPart(options, store, ports)
          : modelPart(options, store, ports);
    const { primitive } = part;
    primitive.gevMoverSet = options.id;
    // Later (higher) order draws later: after every set of lower or equal order.
    const at = ordered.filter((entry) => entry.order <= options.order).length;
    ordered.splice(at, 0, { order: options.order, primitive });
    rootCollection().add(primitive, at);
    return {
      primitive,
      ready: part.ready,
      failed: part.failed,
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
    /** The primitive drawing a live mover set of this engine, or null. */
    primitiveOf(set) {
      const entry = set?.id ? registry.sets.get(set.id) : null;
      return entry && entry.set === set ? entry.part.primitive : null;
    },
    /**
     * The set and instance a Cesium pick result belongs to, with the
     * instance's pickId, whether its set is pickable and whether the
     * instance is in front of the horizon (billboards drawn without a depth
     * test reach Cesium's GPU pick through the globe); null for anything else.
     */
    identify(picked) {
      const known = picked?.primitive
        ? ports.owners.get(picked.primitive)
        : null;
      const entry = known && registry.sets.get(known.owner);
      if (!entry || !(known.instance < entry.store.count)) return null;
      const { store, options } = entry;
      const at = 3 * known.instance;
      const position = {
        x: store.positions[at],
        y: store.positions[at + 1],
        z: store.positions[at + 2],
      };
      return {
        owner: known.owner,
        instance: known.instance,
        id: store.pickIds[known.instance],
        pickable: options.pickable,
        visible: horizonVisible(viewer.camera.positionWC, position),
      };
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
