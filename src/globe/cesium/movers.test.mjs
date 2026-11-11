import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import * as geo from '../../geo/index.js';
import { createCesiumMovers } from './movers.js';
import { createFakeViewer } from './testing/fakeViewer.mjs';

// Cesium's own collections, billboards and points (they draw nothing
// without a renderer, but hold what the engine writes). What needs the
// network or a DOM is faked: the glTF load and the atlas crop.
function setup({ loadModel, cropCells } = {}) {
  const viewer = createFakeViewer();
  viewer.scene.frameState.mode = Cesium.SceneMode.SCENE3D;
  const requests = [];
  const crops = [];
  const loads = [];
  const factories = {
    cropCells:
      cropCells ??
      (async (atlas, keys) => {
        crops.push({ atlas, keys });
        return new Map(keys.map((key) => [key, { width: 8, height: 8, key }]));
      }),
    loadModel:
      loadModel ??
      (async (options) => {
        loads.push(options);
        return fakeModel(options);
      }),
  };
  const part = createCesiumMovers(viewer, {
    factories,
    requestRender: (reason) => requests.push(reason),
  });
  const root = () => viewer.primitiveList[0];
  return { viewer, requests, crops, loads, root, ...part };
}

// What the engine reads and writes of a Cesium Model: its own model matrix
// (kept as given), a colour it copies.
function fakeModel(options) {
  let color;
  return {
    options,
    ready: false,
    show: true,
    modelMatrix: Cesium.Matrix4.clone(Cesium.Matrix4.IDENTITY),
    get color() {
      return color;
    },
    set color(value) {
      color = Cesium.Color.clone(value);
    },
    isDestroyed: () => false,
    destroy() {
      this.destroyed = true;
    },
  };
}

const at = (lon, lat, height = 0) =>
  geo.cartesian3.fromDegrees(lon, lat, height);
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const atlas = {
  canvas: { width: 64, height: 32 },
  cells: { jet: [0, 0, 0.5, 1], heli: [0.5, 0, 1, 1] },
};
const items = (collection) =>
  Array.from({ length: collection.length }, (_, index) =>
    collection.get(index),
  );

test('creating the movers changes nothing; the first set adds one root collection', () => {
  const { viewer, movers, root, destroy } = setup();
  assert.equal(viewer.scene.primitives.length, 0);
  const set = movers.createSet({
    id: 'a',
    kind: 'point',
    capacity: 2,
    point: { sizePx: 4 },
  });
  assert.equal(viewer.scene.primitives.length, 1);
  assert.ok(root() instanceof Cesium.PrimitiveCollection);
  const [collection] = items(root());
  assert.ok(collection instanceof Cesium.PointPrimitiveCollection);
  set.destroy();
  assert.equal(root().length, 0);
  assert.equal(collection.isDestroyed(), true, 'a destroyed set is released');
  destroy();
  assert.equal(viewer.scene.primitives.length, 0);
});

test('sprites are billboards with the set style once the atlas cells are ready', async () => {
  const { movers, root, requests, crops } = setup();
  const set = movers.createSet({
    id: 'flights',
    kind: 'sprite',
    capacity: 3,
    depthTest: 'always',
    sprite: { atlas, sizePx: 20, scaleByDistance: [1e3, 1, 1e6, 0.5] },
  });
  const [collection] = items(root());
  assert.ok(collection instanceof Cesium.BillboardCollection);
  assert.deepEqual(crops[0].keys, ['jet', 'heli']);
  assert.equal(crops[0].atlas, atlas);
  assert.equal(set.ready(), false, 'not ready before the atlas');
  set.set(0, {
    position: at(1, 2),
    rotation: 0.25,
    cell: 'heli',
    pickId: 'x1',
  });
  set.set(1, {
    position: at(3, 4),
    color: [1, 0, 0, 0.5],
    scale: 2,
    show: false,
  });
  set.setCount(2);
  set.commit();
  assert.equal(collection.length, 0, 'waits for the atlas');
  await settle();
  assert.equal(set.ready(), true);
  assert.equal(collection.length, 2);
  const [first, second] = items(collection);
  assert.ok(first instanceof Cesium.Billboard);
  assert.ok(Cesium.Cartesian3.equalsEpsilon(first.position, at(1, 2), 0, 1e-6));
  assert.equal(first.width, 20);
  assert.equal(first.height, 20);
  assert.equal(first.rotation, 0.25);
  assert.equal(first.id, 'x1');
  assert.equal(first.disableDepthTestDistance, Number.POSITIVE_INFINITY);
  assert.ok(
    Cesium.NearFarScalar.equals(
      first.scaleByDistance,
      new Cesium.NearFarScalar(1e3, 1, 1e6, 0.5),
    ),
  );
  assert.equal(first.image, 'flights:heli', 'the cell image, by set and key');
  assert.equal(first.show, true);
  assert.equal(second.image, 'flights:jet', 'the first cell by default');
  assert.equal(second.show, false);
  assert.equal(second.scale, 2);
  assert.ok(Cesium.Color.equals(second.color, new Cesium.Color(1, 0, 0, 0.5)));
  assert.ok(requests.includes('movers'));
  // The same cell is not sent again; a new one is.
  const sent = [];
  const setImage = first.setImage;
  first.setImage = (id, image) => {
    sent.push(id);
    setImage.call(first, id, image);
  };
  set.set(0, { cell: 'heli' });
  set.commit();
  assert.deepEqual(sent, []);
  set.set(0, { cell: 'jet' });
  set.commit();
  assert.deepEqual(sent, ['flights:jet']);
  // Lowering the count hides the instances past it.
  set.set(1, { show: true });
  set.commit();
  assert.equal(second.show, true);
  set.setCount(1);
  set.commit();
  assert.equal(second.show, false);
});

test('a sprite set destroyed before its atlas arrives draws nothing', async () => {
  const { movers, root } = setup();
  const set = movers.createSet({
    id: 'early',
    kind: 'sprite',
    capacity: 1,
    sprite: { atlas, sizePx: 8 },
  });
  const [collection] = items(root());
  set.set(0, { position: at(0, 0) });
  set.setCount(1);
  set.commit();
  set.destroy();
  await settle();
  assert.equal(collection.isDestroyed(), true);
  assert.equal(root().length, 0);
});

test('points take the size, scale, outline, translucency and depth test of the set', () => {
  const { movers, root } = setup();
  const set = movers.createSet({
    id: 'sats',
    kind: 'point',
    capacity: 2,
    depthTest: { disableWithinM: 5000 },
    point: {
      sizePx: 4,
      outlinePx: 1,
      outlineColor: [1, 1, 1, 0.5],
      scaleByDistance: [1e3, 2, 1e7, 0.5],
      translucencyByDistance: [1e6, 1, 1e8, 0],
    },
  });
  set.set(0, {
    position: at(5, 6),
    scale: 1.5,
    color: [0, 1, 0, 1],
    pickId: 25544,
  });
  set.setCount(1);
  set.commit();
  const [collection] = items(root());
  const [point] = items(collection);
  assert.ok(point instanceof Cesium.PointPrimitive);
  assert.equal(point.pixelSize, 6, 'sizePx × scale');
  assert.equal(point.outlineWidth, 1);
  assert.ok(
    Cesium.Color.equals(point.outlineColor, new Cesium.Color(1, 1, 1, 0.5)),
  );
  assert.ok(
    Cesium.NearFarScalar.equals(
      point.scaleByDistance,
      new Cesium.NearFarScalar(1e3, 2, 1e7, 0.5),
    ),
  );
  assert.ok(
    Cesium.NearFarScalar.equals(
      point.translucencyByDistance,
      new Cesium.NearFarScalar(1e6, 1, 1e8, 0),
    ),
  );
  assert.equal(point.disableDepthTestDistance, 5000);
  assert.equal(point.id, 25544);
  assert.ok(Cesium.Color.equals(point.color, new Cesium.Color(0, 1, 0, 1)));
  set.set(0, { outlineColor: [0.5, 0, 1, 0.25] });
  set.commit();
  assert.deepEqual(
    Cesium.Color.pack(point.outlineColor, []),
    [0.5, 0, 1, 0.25],
  );
  assert.ok(Cesium.Color.equals(point.color, new Cesium.Color(0, 1, 0, 1)));
  assert.equal(point.outlineWidth, 1);
  assert.throws(
    () => set.set(0, { scale: 9, outlineColor: [1, 0, 0, 2] }),
    TypeError,
  );
  set.commit();
  assert.equal(
    point.pixelSize,
    6,
    'an invalid outline update leaves the point unchanged',
  );
  // 'normal' keeps Cesium's depth test.
  const normal = movers.createSet({
    id: 'normal',
    kind: 'point',
    capacity: 1,
    point: { sizePx: 2 },
  });
  normal.set(0, { position: at(0, 0) });
  normal.setCount(1);
  normal.commit();
  const [, normalCollection] = items(root());
  assert.equal(items(normalCollection)[0].disableDepthTestDistance, 0);
  assert.equal(items(normalCollection)[0].outlineWidth, 0);
});

test('sets are ordered in the root by their order', () => {
  const { movers, root } = setup();
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
  const middle = make('middle', 0);
  make('middle-later', 0);
  assert.deepEqual(
    items(root()).map((collection) => collection.gevMoverSet),
    ['bottom', 'middle', 'middle-later', 'top'],
  );
  middle.destroy();
  make('again', 0);
  assert.deepEqual(
    items(root()).map((collection) => collection.gevMoverSet),
    ['bottom', 'middle-later', 'again', 'top'],
  );
});

test('models load per instance with the set options and follow position, orientation and colour', async () => {
  const { movers, root, loads } = setup();
  const make = (id, model, pickable = false) =>
    movers.createSet({ id, kind: 'model', capacity: 2, pickable, model });
  const set = make(
    'models',
    {
      url: '/models/airplane.glb',
      minimumPixelSize: 24,
      colorBlend: { mode: 'mix', amount: 0.4 },
    },
    true,
  );
  const position = at(10, 20, 3000);
  // A quarter turn about z.
  const orientation = { x: 0, y: 0, z: Math.SQRT1_2, w: Math.SQRT1_2 };
  set.set(0, { position, orientation, color: [1, 0.5, 0, 0.8], scale: 3 });
  set.set(1, { position: at(11, 20), pickId: 'second' });
  set.setCount(2);
  set.commit();
  assert.equal(set.ready(), false);
  await settle();
  const [collection] = items(root());
  assert.ok(collection instanceof Cesium.PrimitiveCollection);
  assert.equal(collection.length, 2, 'one model per instance');
  assert.equal(loads.length, 2);
  const [options] = loads;
  assert.equal(options.url, '/models/airplane.glb');
  assert.equal(options.minimumPixelSize, 24);
  assert.equal(options.colorBlendMode, Cesium.ColorBlendMode.MIX);
  assert.equal(options.colorBlendAmount, 0.4);
  assert.equal(options.allowPicking, true);
  assert.equal(options.customShader, undefined, 'lit by default');
  assert.equal(options.asynchronous, false, 'built at once');
  // The glTF's own axes: no Cesium axis correction (Y_UP_TO_Z_UP ×
  // Z_UP_TO_X_UP), so an orientation draws the same on every engine.
  assert.equal(options.upAxis, Cesium.Axis.Z);
  assert.equal(options.forwardAxis, Cesium.Axis.X);
  assert.ok(
    Cesium.Matrix4.equals(
      Cesium.ModelUtility.getAxisCorrectionMatrix(
        options.upAxis,
        options.forwardAxis,
        new Cesium.Matrix4(),
      ),
      Cesium.Matrix4.IDENTITY,
    ),
  );
  assert.deepEqual(options.environmentMapOptions, { enabled: false });
  const [first, second] = items(collection);
  assert.notEqual(first.modelMatrix, second.modelMatrix);
  const translation = Cesium.Matrix4.getTranslation(
    first.modelMatrix,
    new Cesium.Cartesian3(),
  );
  assert.ok(Cesium.Cartesian3.equalsEpsilon(translation, position, 0, 1e-6));
  // The model's x axis turned onto Earth-fixed y.
  assert.ok(Math.abs(first.modelMatrix[1] - 1) < 1e-12);
  assert.ok(Math.abs(first.modelMatrix[0]) < 1e-12);
  assert.equal(first.scale, 3);
  assert.ok(first.color.equalsEpsilon(new Cesium.Color(1, 0.5, 0, 0.8), 1e-6));
  assert.equal(second.id, 'second');
  assert.equal(set.ready(), false, 'loaded models not yet ready');
  first.ready = true;
  assert.equal(set.ready(0), true, 'an instance is ready with its model');
  assert.equal(set.ready(1), false);
  assert.equal(set.ready(), false);
  second.ready = true;
  assert.equal(set.ready(), true);
  assert.equal(set.ready(2), false, 'past the count');
  // Shrinking hides the instance past the count; a later write moves it.
  set.setCount(1);
  set.commit();
  assert.equal(second.show, false);
  set.set(0, { show: false });
  set.commit();
  assert.equal(first.show, false);
  set.destroy();
  assert.equal(collection.isDestroyed(), true);
  assert.equal(first.destroyed, true, 'the models go with the set');
});

test('model colour blends and unlit become Cesium model options', async () => {
  const { movers, loads } = setup();
  const make = (id, model) => {
    const set = movers.createSet({ id, kind: 'model', capacity: 1, model });
    set.set(0, { position: at(0, 0) });
    set.setCount(1);
    set.commit();
  };
  make('plain', { url: '/a.glb' });
  make('replace', { url: '/a.glb', colorBlend: { mode: 'replace' } });
  make('unlit', { url: '/a.glb', unlit: true });
  await settle();
  const [plain, replace, unlit] = loads;
  // Without colorBlend the colour sets only the alpha.
  assert.equal(plain.colorBlendMode, Cesium.ColorBlendMode.MIX);
  assert.equal(plain.colorBlendAmount, 0);
  assert.equal(plain.allowPicking, false);
  assert.equal(plain.minimumPixelSize, 0);
  assert.equal(replace.colorBlendMode, Cesium.ColorBlendMode.REPLACE);
  assert.ok(unlit.customShader instanceof Cesium.CustomShader);
  assert.equal(unlit.customShader.lightingModel, Cesium.LightingModel.UNLIT);
});

test('a model that loads after its set is destroyed is released', async () => {
  let finish;
  const pending = new Promise((resolve) => (finish = resolve));
  const { movers, root } = setup({ loadModel: () => pending });
  const set = movers.createSet({
    id: 'late',
    kind: 'model',
    capacity: 1,
    model: { url: '/a.glb' },
  });
  set.set(0, { position: at(0, 0) });
  set.setCount(1);
  set.commit();
  set.destroy();
  const model = fakeModel({});
  finish(model);
  await settle();
  assert.equal(model.destroyed, true);
  assert.equal(root().length, 0);
});

test('failed model attempts stop at three and a replacement gets a fresh budget', async (t) => {
  t.mock.method(console, 'warn', () => {});
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let loads = 0;
  const { movers } = setup({
    loadModel: async () => {
      loads++;
      throw new Error('503');
    },
  });
  const set = movers.createSet({
    id: 'broken',
    kind: 'model',
    capacity: 1,
    model: { url: '/a.glb' },
  });
  set.set(0, { position: at(0, 0), pickId: 'a' });
  set.setCount(1);
  set.commit();
  assert.equal(set.failed(), false);
  await new Promise(setImmediate);
  assert.equal(set.failed(0), true);
  t.mock.timers.tick(1499);
  assert.equal(loads, 1);
  for (const delay of [1, 1500]) {
    t.mock.timers.tick(delay);
    await new Promise(setImmediate);
  }
  t.mock.timers.tick(10000);
  assert.equal(loads, 3);
  assert.equal(set.failed(), true);
  assert.equal(set.ready(), false);
  set.set(0, { pickId: 'b' });
  set.commit();
  await new Promise(setImmediate);
  assert.equal(loads, 4);
  set.destroy();
  t.mock.timers.tick(10000);
  assert.equal(loads, 4);
  assert.equal(set.failed(), false);
});

test('a failed instance retries without reloading its healthy neighbour', async (t) => {
  t.mock.method(console, 'warn', () => {});
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let loads = 0;
  let finish;
  const { movers, root } = setup({
    loadModel: async (options) => {
      loads++;
      if (loads === 1) throw new Error('503');
      if (loads === 3) await new Promise((resolve) => (finish = resolve));
      return { ...fakeModel(options), ready: true };
    },
  });
  const set = movers.createSet({
    id: 'fleet',
    kind: 'model',
    capacity: 2,
    retryAfterMs: 20,
    model: { url: '/a.glb' },
  });
  t.after(() => set.destroy());
  set.set(0, { position: at(0, 0), pickId: 'a' });
  set.set(1, { position: at(1, 0), pickId: 'b' });
  set.setCount(2);
  set.commit();
  await new Promise(setImmediate);
  const [collection] = items(root());
  const [healthy] = items(collection);
  assert.equal(set.failed(0), true);
  assert.equal(set.ready(1), true);
  t.mock.timers.tick(20);
  assert.equal(
    set.failed(0),
    true,
    'failure stays visible while retry is pending',
  );
  set.set(0, { position: at(2, 0), show: false });
  set.commit();
  finish();
  await new Promise(setImmediate);
  assert.equal(loads, 3);
  assert.equal(set.ready(), true);
  assert.equal(set.failed(), false);
  assert.equal(collection.get(0), healthy);
  assert.equal(collection.get(1).show, false);
  assert.equal(collection.get(1).modelMatrix[12], at(2, 0).x);
  set.set(0, { pickId: 'c' });
  set.commit();
  await new Promise(setImmediate);
  assert.equal(loads, 4, 'a healthy index reloads for its new identity');
});

test('atlas retries apply the latest instances and cancel on destruction', async (t) => {
  t.mock.method(console, 'warn', () => {});
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let loads = 0;
  const { movers, root } = setup({
    cropCells: async (atlas, keys) => {
      if (++loads < 3) throw new Error('503');
      return new Map(keys.map((key) => [key, { width: 8, height: 8 }]));
    },
  });
  const set = movers.createSet({
    id: 'sprites',
    kind: 'sprite',
    capacity: 1,
    retryAfterMs: 20,
    sprite: { atlas, sizePx: 8 },
  });
  set.setCount(1);
  set.commit();
  await new Promise(setImmediate);
  assert.equal(set.failed(), true);
  for (let i = 0; i < 2; i++) {
    t.mock.timers.tick(20);
    await new Promise(setImmediate);
  }
  assert.equal(set.ready(), true);
  assert.equal(set.failed(), false);
  assert.equal(root().get(0).length, 1);
  set.destroy();
  const cancelled = movers.createSet({
    id: 'cancelled',
    kind: 'sprite',
    capacity: 1,
    sprite: { atlas, sizePx: 8 },
  });
  cancelled.destroy();
  await new Promise(setImmediate);
  t.mock.timers.tick(10000);
  assert.equal(loads, 4);
});

// A layer removes an instance by moving its last one into the freed index
// (src/layers/shared/render/moverBank.js).
test('an instance moved into a failed index loads its own model', async (t) => {
  t.mock.method(console, 'warn', () => {});
  let loads = 0;
  const { movers } = setup({
    loadModel: async (options) => {
      if (loads++ === 0) throw new Error('503');
      return fakeModel(options);
    },
  });
  const set = movers.createSet({
    id: 'fleet',
    kind: 'model',
    capacity: 2,
    model: { url: '/a.glb' },
  });
  set.set(0, { position: at(0, 0), pickId: 'a' });
  set.set(1, { position: at(1, 0), pickId: 'b' });
  set.setCount(2);
  set.commit();
  await settle();
  assert.equal(set.failed(0), true);
  assert.equal(set.failed(1), false);
  // 'a' is removed: 'b' moves into index 0.
  set.set(0, { position: at(1, 0), pickId: 'b' });
  set.setCount(1);
  assert.equal(set.failed(0), false, "'b' does not take the failure of 'a'");
  assert.equal(set.failed(), false);
  set.commit();
  await settle();
  assert.equal(loads, 3, 'index 0 loads again for its new instance');
  assert.equal(set.failed(0), false);
  set.destroy();
});

test('identify names the set, instance and pickId of a picked billboard or point', async () => {
  const { movers, root, identify, viewer } = setup();
  // The fake camera is over (0°, ~1°), 7000 km from the centre.
  viewer.camera.positionWC = Cesium.Cartesian3.fromDegrees(0, 0, 7e5);
  const set = movers.createSet({
    id: 'sats',
    kind: 'point',
    capacity: 3,
    point: { sizePx: 4 },
  });
  set.set(0, { position: at(0, 1) });
  set.set(1, { position: at(1, 0), pickId: 25544 });
  set.set(2, { position: at(180, 0), pickId: 'far' });
  set.setCount(3);
  set.commit();
  const [, second, third] = items(items(root())[0]);
  assert.deepEqual(identify({ primitive: second, id: 'stale' }), {
    owner: 'sats',
    instance: 1,
    id: 25544,
    pickable: false,
    visible: true,
  });
  assert.equal(
    identify({ primitive: third }).visible,
    false,
    'behind the horizon',
  );
  // The pickId the layer writes now, not the one Cesium holds.
  set.set(1, { pickId: 'renamed' });
  assert.equal(identify({ primitive: second }).id, 'renamed');
  // An instance past the count is not identified.
  set.setCount(1);
  set.commit();
  assert.equal(identify({ primitive: second }), null);
  assert.equal(identify({ primitive: {}, id: 'x' }), null);
  assert.equal(identify(undefined), null);
  const sprites = movers.createSet({
    id: 'flights',
    kind: 'sprite',
    capacity: 1,
    pickable: true,
    sprite: { atlas, sizePx: 8 },
  });
  sprites.set(0, { position: at(0, 0.5), pickId: 'ae01ce' });
  sprites.setCount(1);
  sprites.commit();
  await settle();
  const [billboard] = items(items(root())[1]);
  assert.deepEqual(identify({ primitive: billboard }), {
    owner: 'flights',
    instance: 0,
    id: 'ae01ce',
    pickable: true,
    visible: true,
  });
  set.destroy();
  sprites.destroy();
  assert.equal(identify({ primitive: billboard }), null);
});

test('primitiveOf maps a live set of this engine to its collection', () => {
  const { movers, root, primitiveOf } = setup();
  const set = movers.createSet({
    id: 'a',
    kind: 'point',
    capacity: 1,
    point: { sizePx: 2 },
  });
  assert.equal(primitiveOf(set), items(root())[0]);
  assert.equal(primitiveOf({ id: 'a' }), null, 'a look-alike is not the set');
  assert.equal(primitiveOf({ primitive: 1 }), null);
  set.destroy();
  assert.equal(primitiveOf(set), null);
});
