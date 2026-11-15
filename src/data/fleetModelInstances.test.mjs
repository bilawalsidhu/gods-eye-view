// The icon-to-model handoff the Vessels, Transit and Rail layers share
// (fleetModelInstances.js): models only under the DISPLAY 3D toggle and the
// altitude ceiling, at most `cap` of the nearest, each vehicle's icon the
// visual until its model is loaded, ready and placed, and a tinted model
// painted with its route colour.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as Cesium from 'cesium';
import {
  createFleetModel,
  createFleetModelLayer,
  fleetModelMatrix,
  fleetTintShader,
  FLEET_HEADING_OFFSET_DEG,
} from './fleetModelInstances.js';
import {
  loadFleetModelSet,
  transitModelSpec,
  vesselModelSpec,
} from './fleetModels.js';
import { fetchPublicFile } from '../testSupport/fleetGlb.mjs';

const realInfo = console.info;
console.info = () => {};
const set = await loadFleetModelSet({ fetchImpl: fetchPublicFile });
console.info = realInfo;

const POLICY = Object.freeze({
  altitudeCeilingM: 800_000,
  minimumPixelSize: 16,
  cap: 2,
  capAll: 4,
  addM: 5_000,
  addAllM: 20_000,
  keepM: 6_000,
  keepAllM: 24_000,
  intervalMs: 80,
});

const CENTRE = Cesium.Cartesian3.fromDegrees(-122.4, 37.8, 0);

function fakeViewer(height = 1_000) {
  const primitives = [];
  const position = Cesium.Cartesian3.fromDegrees(-122.4, 37.8, height);
  const up = Cesium.Ellipsoid.WGS84.geodeticSurfaceNormal(
    position,
    new Cesium.Cartesian3(),
  );
  const camera = {
    positionWC: position,
    positionCartographic: { height },
    directionWC: Cesium.Cartesian3.negate(up, new Cesium.Cartesian3()),
    upWC: Cesium.Cartesian3.UNIT_Z,
    frustum: {
      computeCullingVolume: () => ({
        computeVisibility: () => Cesium.Intersect.INSIDE,
      }),
    },
  };
  return {
    camera,
    scene: {
      primitives: {
        add(p) {
          primitives.push(p);
          return p;
        },
        remove(p) {
          const i = primitives.indexOf(p);
          if (i >= 0) primitives.splice(i, 1);
          return i >= 0;
        },
      },
    },
    primitives,
    isDestroyed: () => false,
  };
}

function fakeModel(options) {
  return {
    ...options,
    ready: false,
    show: true,
    modelMatrix: new Cesium.Matrix4(),
    destroyed: false,
    destroy() {
      this.destroyed = true;
    },
    isDestroyed() {
      return this.destroyed;
    },
    update() {},
  };
}

/** A vehicle `metres` east of the camera's foot. */
function itemAt(metres, spec, extra = {}) {
  const enu = Cesium.Transforms.eastNorthUpToFixedFrame(CENTRE);
  const position = Cesium.Matrix4.multiplyByPoint(
    enu,
    new Cesium.Cartesian3(metres, 0, 0),
    new Cesium.Cartesian3(),
  );
  return { position, headingDeg: 90, spec, tint: null, pickId: null, ...extra };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test('models load from the up-front set, never by URL', async () => {
  const spec = vesselModelSpec(set, { type: '70', length: 200, beam: 32 });
  let options = null;
  await createFleetModel(
    spec,
    { scale: spec.scale },
    {
      set,
      resolveAsset: (url) => `/base${url}`,
      load: async (o) => {
        options = o;
        return {};
      },
    },
  );
  assert.ok(options.gltf instanceof Uint8Array, 'the loaded GLB bytes');
  assert.equal(options.gltf, set.bytes.get(spec.model));
  assert.equal(options.basePath, `/base${spec.url}`);
  assert.equal(options.url, undefined, 'no fetch by URL');
  assert.deepEqual({ ...options.environmentMapOptions }, { enabled: false });
  await assert.rejects(
    createFleetModel({ model: 'missing' }, {}, { set, load: async () => ({}) }),
    /not loaded/,
  );
});

test('the icon stays the visual until the model is ready; only the nearest are drawn', async () => {
  const viewer = fakeViewer();
  const display = { models3d: true, models3dMode: 'proximity' };
  const created = [];
  const layer = createFleetModelLayer({
    viewer,
    display: () => display,
    policy: POLICY,
    createModel: async (spec, options) => {
      const model = fakeModel({ spec, ...options });
      created.push(model);
      return model;
    },
  });
  const spec = transitModelSpec(set, { mode: 'tram' });
  const items = new Map([
    ['near', itemAt(100, spec, { pickId: 'near' })],
    ['mid', itemAt(1_000, spec, { pickId: 'mid' })],
    ['far', itemAt(4_000, spec, { pickId: 'far' })],
  ]);
  layer.frame(items, 0);
  await flush();
  assert.equal(created.length, POLICY.cap, 'the cap holds');
  assert.deepEqual(
    created.map((m) => m.id).sort(),
    ['mid', 'near'],
    'the nearest are modelled',
  );
  assert.equal(created[0].scale, spec.scale, 'drawn life size');
  assert.equal(created[0].minimumPixelSize, POLICY.minimumPixelSize);

  layer.frame(items, 100);
  for (const item of items.values())
    assert.equal(item.modelOwnsVisual, false, 'not ready: the icon draws');
  assert.ok(
    layer.settling > 0,
    'the layer asks for frames while models settle',
  );

  for (const model of created) model.ready = true;
  layer.frame(items, 200);
  assert.equal(items.get('near').modelOwnsVisual, true);
  assert.equal(items.get('mid').modelOwnsVisual, true);
  assert.equal(items.get('far').modelOwnsVisual, false);
  assert.equal(layer.settling, 0);

  // A placed model stands on its item's point, nose along its heading.
  const near = created.find((m) => m.id === 'near');
  const origin = Cesium.Matrix4.getTranslation(
    near.modelMatrix,
    new Cesium.Cartesian3(),
  );
  assert.ok(
    Cesium.Cartesian3.distance(origin, items.get('near').position) < 1e-6,
  );

  // 3D off: every model goes and every icon comes back.
  display.models3d = false;
  layer.frame(items, 300);
  assert.equal(layer.size, 0);
  for (const item of items.values()) assert.equal(item.modelOwnsVisual, false);
  assert.ok(
    created.every((m) => m.destroyed),
    'released models are destroyed',
  );
  layer.destroy();
  assert.equal(viewer.primitives.length, 0);
});

test('models stay off above the altitude ceiling', async () => {
  const viewer = fakeViewer(POLICY.altitudeCeilingM + 1);
  let calls = 0;
  const layer = createFleetModelLayer({
    viewer,
    display: () => ({ models3d: true }),
    policy: POLICY,
    createModel: async (spec, options) => {
      calls += 1;
      return fakeModel(options);
    },
  });
  assert.equal(layer.active(), false);
  layer.frame(new Map([['a', itemAt(0, transitModelSpec(set, {}))]]), 0);
  await flush();
  assert.equal(calls, 0);
  layer.destroy();
});

test('a tinted model is painted with its route colour; an untinted one is not', async () => {
  const viewer = fakeViewer();
  const created = [];
  const layer = createFleetModelLayer({
    viewer,
    display: () => ({ models3d: true }),
    policy: POLICY,
    createModel: async (spec, options) => {
      const model = fakeModel(options);
      created.push(model);
      return model;
    },
  });
  const red = Cesium.Color.RED;
  const tram = transitModelSpec(set, { mode: 'tram' });
  const ship = vesselModelSpec(set, { type: '70', length: 180 });
  assert.equal(tram.tinted, true);
  assert.equal(ship.tinted, false);
  layer.frame(
    new Map([
      ['tram', itemAt(10, tram, { pickId: 'tram', tint: red })],
      ['ship', itemAt(20, ship, { pickId: 'ship', tint: red })],
    ]),
    0,
  );
  await flush();
  const byId = Object.fromEntries(created.map((m) => [m.id, m]));
  assert.equal(byId.tram.customShader, fleetTintShader(red));
  assert.equal(byId.ship.customShader, undefined);
  assert.equal(
    fleetTintShader(red),
    fleetTintShader(Cesium.Color.RED),
    'one shader per colour',
  );
  layer.destroy();
});

test('an elevated vehicle is raised by its type elevation', async () => {
  const viewer = fakeViewer();
  const created = [];
  const layer = createFleetModelLayer({
    viewer,
    display: () => ({ models3d: true }),
    policy: POLICY,
    createModel: async (spec, options) => {
      const model = fakeModel({ ...options, ready: true });
      model.ready = true;
      created.push(model);
      return model;
    },
  });
  const monorail = transitModelSpec(set, { mode: 'monorail' });
  assert.equal(monorail.elevationM, set.types.transit.elevation.monorail);
  const item = itemAt(10, monorail, { pickId: 'm' });
  const items = new Map([['m', item]]);
  layer.frame(items, 0);
  await flush();
  layer.frame(items, 100);
  const origin = Cesium.Matrix4.getTranslation(
    created[0].modelMatrix,
    new Cesium.Cartesian3(),
  );
  const lifted = Cesium.Cartographic.fromCartesian(origin).height;
  const ground = Cesium.Cartographic.fromCartesian(item.position).height;
  assert.ok(Math.abs(lifted - ground - monorail.elevationM) < 1e-3);
  layer.destroy();
});

test('a vessel stretched to its reported beam keeps its length scale on the model', () => {
  const spec = vesselModelSpec(set, { type: '70', length: 200, beam: 60 });
  assert.ok(spec.scaleXYZ[1] > spec.scaleXYZ[0], 'a wide hull for its length');
  const matrix = fleetModelMatrix(
    CENTRE,
    0,
    spec,
    new Cesium.Matrix4(),
    new Cesium.HeadingPitchRoll(),
  );
  const scale = Cesium.Matrix4.getScale(matrix, new Cesium.Cartesian3());
  // Cesium's axis correction puts the beam on local X, the length on local Y.
  assert.ok(Math.abs(scale.x - spec.scaleXYZ[1] / spec.scaleXYZ[0]) < 1e-9);
  assert.ok(Math.abs(scale.y - 1) < 1e-9);
  assert.equal(FLEET_HEADING_OFFSET_DEG, 180, 'fleet models are built nose -X');
});

test('Vessels, Transit and Rail draw fleet models under the shared 3D toggle', () => {
  for (const file of [
    'src/layers/vessels/rendering.js',
    'src/layers/transit/rendering.js',
    'src/layers/rail/rendering.js',
  ]) {
    const source = fs.readFileSync(
      new URL(`../../${file}`, import.meta.url),
      'utf8',
    );
    assert.match(
      source,
      /createFleetModelLayer\(/,
      `${file}: draws fleet models`,
    );
    assert.match(
      source,
      /loadFleetModelSet\(/,
      `${file}: loads the set up front`,
    );
    assert.match(
      source,
      /modelOwnsVisual/,
      `${file}: hands its icon to the model`,
    );
  }
  for (const file of [
    'src/app/layers/aisLiveVessels.js',
    'src/app/layers/transit.js',
    'src/app/layers/rail.js',
  ]) {
    const source = fs.readFileSync(
      new URL(`../../${file}`, import.meta.url),
      'utf8',
    );
    assert.match(
      source,
      /fleet: fleetModelServices\(/,
      `${file}: given the fleet service`,
    );
  }
  const catalog = fs.readFileSync(
    new URL('../app/constructCatalog.js', import.meta.url),
    'utf8',
  );
  assert.equal(
    catalog.match(/displayParams: \(\) => flights\.getParams\(\)/g)?.length,
    4,
    'Local ADS-B, Vessels, Transit and Rail follow the Flights 3D toggle',
  );
});

/** A layer whose models are all ready as soon as they are created. */
function readyLayer({ display, waterline = false } = {}) {
  const viewer = fakeViewer();
  const created = [];
  const layer = createFleetModelLayer({
    viewer,
    display: () => display,
    policy: POLICY,
    waterline,
    createModel: async (spec, options) => {
      const model = fakeModel(options);
      model.ready = true;
      created.push(model);
      return model;
    },
  });
  return { layer, created };
}

test('a model stands on the floor its icon is lifted above', async () => {
  const { layer, created } = readyLayer({ display: { models3d: true } });
  const tram = transitModelSpec(set, { mode: 'tram' });
  const item = itemAt(10, tram, { pickId: 't', groundLiftM: 1.5 });
  const items = new Map([['t', item]]);
  layer.frame(items, 0);
  await flush();
  layer.frame(items, 100);
  const origin = Cesium.Matrix4.getTranslation(
    created[0].modelMatrix,
    new Cesium.Cartesian3(),
  );
  const drop =
    Cesium.Cartographic.fromCartesian(item.position).height -
    Cesium.Cartographic.fromCartesian(origin).height;
  assert.ok(Math.abs(drop - 1.5) < 1e-3, `dropped ${drop} m`);
  layer.destroy();
});

test('under NVG/FLIR models are rebuilt unlit white, and rebuilt again on exit', async () => {
  const display = { models3d: true, irBoost: false };
  const { layer, created } = readyLayer({ display });
  const tram = transitModelSpec(set, { mode: 'tram' });
  const items = new Map([
    ['t', itemAt(10, tram, { pickId: 't', tint: Cesium.Color.RED })],
  ]);
  layer.frame(items, 0);
  await flush();
  assert.equal(created[0].customShader, fleetTintShader(Cesium.Color.RED));
  display.irBoost = true;
  layer.frame(items, 100);
  assert.ok(created[0].destroyed, 'the lit model is released');
  await flush();
  const boosted = created[1];
  assert.equal(boosted.customShader.lightingModel, Cesium.LightingModel.UNLIT);
  assert.ok(Cesium.Color.equals(boosted.color, Cesium.Color.WHITE));
  assert.equal(boosted.colorBlendAmount, 1);
  display.irBoost = false;
  layer.frame(items, 200);
  await flush();
  assert.ok(boosted.destroyed);
  assert.equal(created[2].customShader, fleetTintShader(Cesium.Color.RED));
  layer.destroy();
});

test('a waterline layer clips each model at its origin, keeping the part above', async () => {
  const { layer, created } = readyLayer({
    display: { models3d: true },
    waterline: true,
  });
  const ship = vesselModelSpec(set, { type: '70', length: 200, beam: 32 });
  layer.frame(new Map([['s', itemAt(10, ship, { pickId: 's' })]]), 0);
  await flush();
  const planes = created[0].clippingPlanes;
  assert.ok(planes instanceof Cesium.ClippingPlaneCollection);
  assert.equal(planes.length, 1);
  const plane = planes.get(0);
  assert.equal(plane.distance, 0);
  assert.ok(Cesium.Cartesian3.equals(plane.normal, Cesium.Cartesian3.UNIT_Z));
  assert.equal(planes.unionClippingRegions, false);
  // Cesium keeps a point where normal · p + distance >= 0: above the waterline.
  const above = Cesium.Cartesian3.dot(
    plane.normal,
    new Cesium.Cartesian3(0, 0, 3),
  );
  const below = Cesium.Cartesian3.dot(
    plane.normal,
    new Cesium.Cartesian3(0, 0, -3),
  );
  assert.ok(above + plane.distance > 0 && below + plane.distance < 0);
  layer.destroy();

  const plain = readyLayer({ display: { models3d: true } });
  plain.layer.frame(
    new Map([['t', itemAt(10, transitModelSpec(set, { mode: 'tram' }))]]),
    0,
  );
  await flush();
  assert.equal(plain.created[0].clippingPlanes, undefined, 'others unclipped');
  plain.layer.destroy();
});

test('a vehicle drawn as its model keeps its card and its detection entry', () => {
  const read = (file) =>
    fs.readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');
  assert.match(
    read('src/layers/transit/selection.js'),
    /marker\?\.show !== false \|\| entry\.modelOwnsVisual === true/,
  );
  assert.match(
    read('src/layers/rail/selection.js'),
    /entry\.marker\?\.show !== false \|\| entry\.modelOwnsVisual === true/,
  );
  assert.match(
    read('src/layers/transit/queries.js'),
    /marker\.show === false && entry\.modelOwnsVisual !== true/,
  );
  assert.match(
    read('src/layers/vessels/queries.js'),
    /!visual\.billboard\.show &&\s*!visual\.modelOwnsVisual/,
  );
  assert.match(
    read('src/layers/transit/rendering.js'),
    /entry\.mode === 'unknown'/,
    'a vehicle of unknown mode keeps its icon',
  );
});
