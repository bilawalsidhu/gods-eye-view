import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { createCesiumMovers } from './movers.js';
import { createFakeViewer } from './testing/fakeViewer.mjs';

// Collections that keep what the engine gives them (Cesium's own need a
// WebGL scene to add billboards).
function fakeFactories() {
  const made = [];
  const collection = (kind) => {
    const items = [];
    const value = {
      kind,
      items,
      show: true,
      add(options) {
        // Cesium's billboards and points copy positions and colours.
        let position;
        let color;
        const item = {
          ...options,
          get position() {
            return position;
          },
          set position(value) {
            position = Cesium.Cartesian3.clone(value);
          },
          get color() {
            return color;
          },
          set color(value) {
            color = Cesium.Color.clone(value);
          },
          images: [],
          setImage(id, image) {
            this.images.push(id);
            this.image = image;
          },
        };
        items.push(item);
        return item;
      },
      remove(item) {
        items.splice(items.indexOf(item), 1);
        return true;
      },
      get length() {
        return items.length;
      },
      isDestroyed: () => false,
      destroy() {
        value.destroyed = true;
      },
    };
    made.push(value);
    return value;
  };
  return {
    made,
    factories: {
      billboards: () => collection('billboards'),
      points: () => collection('points'),
      models: () => collection('models'),
      loadModel: async (options) => ({ ...options, loaded: true }),
      cropCells: async (atlas, keys) =>
        new Map(keys.map((key) => [key, { cell: key }])),
    },
  };
}

const atlas = {
  canvas: { width: 64, height: 32 },
  cells: { jet: [0, 0, 0.5, 1], heli: [0.5, 0, 1, 1] },
};
const at = (x) => ({ x, y: 0, z: 6_400_000 });
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test('creating the movers changes nothing; the first set adds one root collection', () => {
  const viewer = createFakeViewer();
  const { factories } = fakeFactories();
  const { movers, destroy } = createCesiumMovers(viewer, { factories });
  assert.equal(viewer.scene.primitives.length, 0);
  movers.createSet({
    id: 'a',
    kind: 'point',
    capacity: 2,
    point: { sizePx: 4 },
  });
  assert.equal(viewer.scene.primitives.length, 1);
  destroy();
  assert.equal(viewer.scene.primitives.length, 0);
});

test('sprites become billboards with the set style once the atlas cells are ready', async () => {
  const viewer = createFakeViewer();
  const { factories, made } = fakeFactories();
  const requests = [];
  const { movers } = createCesiumMovers(viewer, {
    factories,
    requestRender: (reason) => requests.push(reason),
  });
  const set = movers.createSet({
    id: 'flights',
    kind: 'sprite',
    capacity: 3,
    depthTest: 'always',
    sprite: { atlas, sizePx: 20, scaleByDistance: [1e3, 1, 1e6, 0.5] },
  });
  set.set(0, { position: at(1), rotation: 0.25, cell: 'heli', pickId: 'x1' });
  set.set(1, { position: at(2), color: [1, 0, 0, 0.5], scale: 2, show: false });
  set.setCount(2);
  set.commit();
  const billboards = made.find(
    (collection) => collection.kind === 'billboards',
  );
  assert.equal(billboards.items.length, 0, 'waits for the atlas');
  await settle();
  assert.equal(billboards.items.length, 2);
  const [first, second] = billboards.items;
  assert.ok(first.position instanceof Cesium.Cartesian3);
  assert.equal(first.position.x, 1);
  assert.equal(first.width, 20);
  assert.equal(first.height, 20);
  assert.equal(first.rotation, 0.25);
  assert.equal(first.id, 'x1');
  assert.equal(first.disableDepthTestDistance, Number.POSITIVE_INFINITY);
  assert.ok(first.scaleByDistance instanceof Cesium.NearFarScalar);
  assert.deepEqual(first.images, ['flights:heli']);
  assert.equal(first.show, true);
  assert.equal(second.show, false);
  assert.equal(second.scale, 2);
  assert.ok(Cesium.Color.equals(second.color, new Cesium.Color(1, 0, 0, 0.5)));
  assert.ok(requests.length >= 1);
  // Lowering the count hides the instances past it.
  set.setCount(1);
  set.commit();
  assert.equal(second.show, false);
  set.set(0, { cell: 'heli' });
  set.commit();
  assert.deepEqual(
    first.images,
    ['flights:heli'],
    'the same cell is not re-sent',
  );
});

test('points take the size, outline and depth test of the set', () => {
  const viewer = createFakeViewer();
  const { factories, made } = fakeFactories();
  const { movers } = createCesiumMovers(viewer, { factories });
  const set = movers.createSet({
    id: 'sats',
    kind: 'point',
    capacity: 2,
    depthTest: { disableWithinM: 5000 },
    point: { sizePx: 4, outlinePx: 1 },
  });
  set.set(0, { position: at(3), scale: 1.5, color: [0, 1, 0, 1] });
  set.setCount(1);
  set.commit();
  const [point] = made.find((c) => c.kind === 'points').items;
  assert.equal(point.pixelSize, 6);
  assert.equal(point.outlineWidth, 1);
  assert.equal(point.disableDepthTestDistance, 5000);
  assert.ok(Cesium.Color.equals(point.color, new Cesium.Color(0, 1, 0, 1)));
});

test('sets are ordered in the root by their order', () => {
  const viewer = createFakeViewer();
  const { factories } = fakeFactories();
  const { movers } = createCesiumMovers(viewer, { factories });
  const make = (id, order) =>
    movers.createSet({
      id,
      kind: 'point',
      capacity: 1,
      order,
      point: { sizePx: 2 },
    });
  make('top', 5);
  make('bottom', -1);
  make('middle', 0);
  const root = viewer.scene.primitives.get(0);
  assert.deepEqual(
    [0, 1, 2].map((index) => root.get(index).gevMoverSet),
    ['bottom', 'middle', 'top'],
  );
});

test('models load per instance and follow position and orientation', async () => {
  const viewer = createFakeViewer();
  const { factories, made } = fakeFactories();
  const { movers } = createCesiumMovers(viewer, { factories });
  const set = movers.createSet({
    id: 'models',
    kind: 'model',
    capacity: 2,
    model: {
      url: '/models/airplane.glb',
      minimumPixelSize: 24,
      colorBlend: { mode: 'mix', amount: 0.4 },
    },
  });
  set.set(0, {
    position: at(4),
    orientation: { x: 0, y: 0, z: 0, w: 1 },
    color: [1, 0.5, 0, 1],
  });
  set.setCount(1);
  set.commit();
  await settle();
  const models = made.find((c) => c.kind === 'models');
  assert.equal(models.items.length, 1);
  const [model] = models.items;
  assert.equal(model.url, '/models/airplane.glb');
  assert.equal(model.minimumPixelSize, 24);
  assert.equal(model.colorBlendMode, Cesium.ColorBlendMode.MIX);
  assert.equal(model.colorBlendAmount, 0.4);
  assert.equal(model.modelMatrix[12], 4);
  set.destroy();
  assert.equal(models.destroyed, true);
});
