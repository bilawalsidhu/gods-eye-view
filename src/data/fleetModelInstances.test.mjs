// The icon-to-model handoff the Vessels, Transit and Rail layers share
// (fleetModelInstances.js): models only under the DISPLAY 3D toggle and the
// altitude ceiling, at most `cap` of the nearest, each vehicle's icon the
// visual until its model is loaded, ready and placed, drawn through the
// renderer's model sets from the bytes loaded up front, and a tinted model
// painted with its route colour.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  createFleetModelLayer,
  fleetAxisScale,
  fleetColor,
  FLEET_HEADING_OFFSET_DEG,
} from './fleetModelInstances.js';
import {
  loadFleetModelSet,
  transitModelSpec,
  vesselModelSpec,
} from './fleetModels.js';
import { fetchPublicFile } from '../testSupport/fleetGlb.mjs';
import { bindFakeDraw } from '../testSupport/fakeDrawPort.mjs';
import { eastNorthUp } from '../geo/frames.js';
import { fromDegrees, toLonLatH } from '../geo/ellipsoid.js';
import { add, distance, scale } from '../geo/vector.js';

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

const CENTRE = fromDegrees(-122.4, 37.8, 0);

/** A scene host with a fake draw port and a camera `height` m above CENTRE, looking down. */
function fakeViewer(height = 1_000) {
  const viewer = {};
  const position = fromDegrees(-122.4, 37.8, height);
  const enu = eastNorthUp(position);
  const { draw } = bindFakeDraw(viewer, {
    camera: {
      pose: () => ({
        lon: -122.4,
        lat: 37.8,
        height,
        position,
        direction: scale(enu.z, -1),
        up: enu.y,
        right: enu.x,
        fovy: Math.PI / 3,
        aspectRatio: 1.5,
      }),
    },
  });
  return { viewer, draw };
}

/** A vehicle `metres` east of the camera's foot. */
function itemAt(metres, spec, extra = {}) {
  const position = add(CENTRE, scale(eastNorthUp(CENTRE).x, metres));
  return { position, headingDeg: 90, spec, tint: null, pickId: null, ...extra };
}

/** The layer's model set in the fake draw port. */
const modelSet = (draw) => draw.find('fleet-models:');

test('models are drawn from the up-front set, never fetched by URL', () => {
  const { viewer, draw } = fakeViewer();
  const layer = createFleetModelLayer({
    viewer,
    display: () => ({ models3d: true }),
    policy: POLICY,
    resolveAsset: (url) => `/base${url}`,
  });
  const spec = vesselModelSpec(set, { type: '70', length: 200, beam: 32 });
  layer.frame(new Map([['s', itemAt(10, spec, { pickId: 's' })]]), 0);
  const item = modelSet(draw).items.get('s');
  assert.ok(item.gltf instanceof Uint8Array, 'the loaded GLB bytes');
  assert.equal(item.gltf, set.bytes.get(spec.model));
  assert.equal(item.url, `/base${spec.url}`, 'the url names it');
  assert.equal(item.environmentMap, false);
  layer.destroy();
});

test('the icon stays the visual until the model is ready; only the nearest are drawn', () => {
  const { viewer, draw } = fakeViewer();
  const display = { models3d: true, models3dMode: 'proximity' };
  const layer = createFleetModelLayer({
    viewer,
    display: () => display,
    policy: POLICY,
  });
  const spec = transitModelSpec(set, { mode: 'tram' });
  const items = new Map([
    ['near', itemAt(100, spec, { pickId: 'near' })],
    ['mid', itemAt(1_000, spec, { pickId: 'mid' })],
    ['far', itemAt(4_000, spec, { pickId: 'far' })],
  ]);
  layer.frame(items, 0);
  const models = modelSet(draw);
  assert.equal(models.items.size, POLICY.cap, 'the cap holds');
  assert.deepEqual(
    [...models.items.keys()].sort(),
    ['mid', 'near'],
    'the nearest are modelled',
  );
  const near = models.items.get('near');
  assert.equal(near.scale, spec.scale, 'drawn life size');
  assert.equal(near.minPixelSize, POLICY.minimumPixelSize);
  assert.equal(near.meta, 'near', 'picked as its vehicle');
  assert.equal(near.show, false, 'hidden until ready');

  layer.frame(items, 100);
  for (const item of items.values())
    assert.equal(item.modelOwnsVisual, false, 'not ready: the icon draws');
  assert.ok(
    layer.settling > 0,
    'the layer asks for frames while models settle',
  );

  draw.ready(models.spec.id, 'near');
  draw.ready(models.spec.id, 'mid');
  layer.frame(items, 200);
  assert.equal(items.get('near').modelOwnsVisual, true);
  assert.equal(items.get('mid').modelOwnsVisual, true);
  assert.equal(items.get('far').modelOwnsVisual, false);
  assert.equal(layer.settling, 0);
  assert.equal(models.items.get('near').show, true);

  // A placed model stands on its item's point, nose along its heading.
  const placed = models.items.get('near');
  assert.ok(distance(placed.pos, items.get('near').position) < 1e-6);
  assert.ok(
    Math.abs(
      placed.orientation.heading -
        ((90 + FLEET_HEADING_OFFSET_DEG) * Math.PI) / 180,
    ) < 1e-12,
  );

  // 3D off: every model goes and every icon comes back.
  display.models3d = false;
  layer.frame(items, 300);
  assert.equal(layer.size, 0);
  assert.equal(models.items.size, 0, 'released from the set');
  for (const item of items.values()) assert.equal(item.modelOwnsVisual, false);
  layer.destroy();
  assert.equal(models.disposed, true);
});

test('models stay off above the altitude ceiling', () => {
  const { viewer, draw } = fakeViewer(POLICY.altitudeCeilingM + 1);
  const layer = createFleetModelLayer({
    viewer,
    display: () => ({ models3d: true }),
    policy: POLICY,
  });
  assert.equal(layer.active(), false);
  layer.frame(new Map([['a', itemAt(0, transitModelSpec(set, {}))]]), 0);
  assert.equal(modelSet(draw).items.size, 0);
  layer.destroy();
});

test('a tinted model is painted with its route colour; an untinted one is not', () => {
  const { viewer, draw } = fakeViewer();
  const layer = createFleetModelLayer({
    viewer,
    display: () => ({ models3d: true }),
    policy: POLICY,
  });
  const tram = transitModelSpec(set, { mode: 'tram' });
  const ship = vesselModelSpec(set, { type: '70', length: 180 });
  assert.equal(tram.tinted, true);
  assert.equal(ship.tinted, false);
  const items = new Map([
    ['tram', itemAt(10, tram, { pickId: 'tram', tint: '#ff0000' })],
    ['ship', itemAt(20, ship, { pickId: 'ship', tint: '#ff0000' })],
  ]);
  layer.frame(items, 0);
  const models = modelSet(draw);
  assert.equal(models.items.get('tram').maskColor, '#ff0000');
  assert.equal(models.items.get('ship').maskColor, undefined);
  // A new route colour is written in place.
  items.get('tram').tint = [0, 0, 1, 1];
  layer.frame(items, 10);
  assert.deepEqual(models.items.get('tram').maskColor, [0, 0, 1, 1]);
  assert.deepEqual(fleetColor({ red: 1, green: 0, blue: 0 }), [1, 0, 0, 1]);
  layer.destroy();
});

test('an elevated vehicle is raised by its type elevation', () => {
  const { viewer, draw } = fakeViewer();
  const layer = createFleetModelLayer({
    viewer,
    display: () => ({ models3d: true }),
    policy: POLICY,
  });
  const monorail = transitModelSpec(set, { mode: 'monorail' });
  assert.equal(monorail.elevationM, set.types.transit.elevation.monorail);
  const item = itemAt(10, monorail, { pickId: 'm' });
  layer.frame(new Map([['m', item]]), 0);
  const placed = modelSet(draw).items.get('m');
  const lifted = toLonLatH(placed.pos).height;
  const ground = toLonLatH(item.position).height;
  assert.ok(Math.abs(lifted - ground - monorail.elevationM) < 1e-3);
  layer.destroy();
});

test('a vessel stretched to its reported beam keeps its length scale on the model', () => {
  const spec = vesselModelSpec(set, { type: '70', length: 200, beam: 60 });
  assert.ok(spec.scaleXYZ[1] > spec.scaleXYZ[0], 'a wide hull for its length');
  // Along the model's glTF axes: x its length, y its height, z its beam.
  const [x, y, z] = fleetAxisScale(spec);
  assert.equal(x, 1);
  assert.ok(Math.abs(y - spec.scaleXYZ[2] / spec.scaleXYZ[0]) < 1e-12);
  assert.ok(Math.abs(z - spec.scaleXYZ[1] / spec.scaleXYZ[0]) < 1e-12);
  assert.equal(
    fleetAxisScale(transitModelSpec(set, { mode: 'tram' })),
    undefined,
    'a model at its own proportions is not stretched',
  );
  assert.equal(FLEET_HEADING_OFFSET_DEG, 180, 'fleet models are built nose -X');

  const { viewer, draw } = fakeViewer();
  const layer = createFleetModelLayer({
    viewer,
    display: () => ({ models3d: true }),
    policy: POLICY,
  });
  layer.frame(new Map([['s', itemAt(10, spec, { pickId: 's' })]]), 0);
  const item = modelSet(draw).items.get('s');
  assert.equal(item.scale, spec.scale, 'its length scale');
  assert.deepEqual(item.axisScale, [x, y, z], 'stretched to its beam');
  layer.destroy();
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

/** A layer whose models are all ready as soon as they are written. */
function readyLayer({ display, waterline = false } = {}) {
  const { viewer, draw } = fakeViewer();
  const layer = createFleetModelLayer({
    viewer,
    display: () => display,
    policy: POLICY,
    waterline,
  });
  const frame = (items, nowMs) => {
    layer.frame(items, nowMs);
    const models = modelSet(draw);
    for (const id of models.items.keys()) draw.ready(models.spec.id, id);
    layer.frame(items, nowMs + 1);
    return models;
  };
  return { layer, draw, frame };
}

test('a model stands on the floor its icon is lifted above', () => {
  const { layer, frame } = readyLayer({ display: { models3d: true } });
  const tram = transitModelSpec(set, { mode: 'tram' });
  const item = itemAt(10, tram, { pickId: 't', groundLiftM: 1.5 });
  const models = frame(new Map([['t', item]]), 0);
  const drop =
    toLonLatH(item.position).height -
    toLonLatH(models.items.get('t').pos).height;
  assert.ok(Math.abs(drop - 1.5) < 1e-3, `dropped ${drop} m`);
  layer.destroy();
});

test('a model that did not change is not written, nor built anew to find that out', () => {
  const { layer, frame } = readyLayer({ display: { models3d: true } });
  const tram = transitModelSpec(set, { mode: 'tram' });
  // Reads of what only the draw item takes (its scales): a model whose item
  // is built again reads them.
  let shapeReads = 0;
  const spec = new Proxy(tram, {
    get(target, key) {
      if (key === 'scale' || key === 'scaleXYZ') shapeReads += 1;
      return target[key];
    },
  });
  const tint = [1, 0, 0, 1];
  const item = itemAt(10, spec, { pickId: 't', tint });
  const items = new Map([['t', item]]);
  const models = frame(items, 0);
  const writes = models.writes;
  shapeReads = 0;
  for (let at = 2; at < 6; at++) layer.frame(items, at);
  assert.equal(models.writes, writes, 'nothing written');
  assert.equal(shapeReads, 0, 'no draw item built');

  // A move, a turn and a route colour the layer changes in its own array
  // are each written.
  item.position = add(item.position, { x: 1, y: 0, z: 0 });
  layer.frame(items, 6);
  assert.equal(models.writes, writes + 1, 'a move is written');
  item.headingDeg += 10;
  layer.frame(items, 7);
  assert.equal(models.writes, writes + 2, 'a turn is written');
  tint[2] = 1;
  layer.frame(items, 8);
  assert.equal(models.writes, writes + 3, 'a colour changed in place');
  assert.deepEqual(models.items.get('t').maskColor, [1, 0, 1, 1]);
  layer.frame(items, 9);
  assert.equal(models.writes, writes + 3, 'and then nothing');
  layer.destroy();
});

test('under NVG/FLIR models draw unlit white, and lit again on exit, without loading again', () => {
  const display = { models3d: true, irBoost: false };
  const { layer, frame } = readyLayer({ display });
  const tram = transitModelSpec(set, { mode: 'tram' });
  const items = new Map([
    ['t', itemAt(10, tram, { pickId: 't', tint: '#ff0000' })],
  ]);
  let models = frame(items, 0);
  let item = models.items.get('t');
  assert.equal(item.shading, 'pbr');
  assert.equal(item.maskColor, '#ff0000');
  display.irBoost = true;
  layer.frame(items, 100);
  item = models.items.get('t');
  assert.equal(item.shading, 'unlit');
  assert.deepEqual(item.tint, [1, 1, 1, 1]);
  assert.deepEqual(item.colorBlend, { mode: 'mix', amount: 1 });
  assert.equal(item.maskColor, undefined, 'no route colour under NVG/FLIR');
  assert.equal(item.show, true, 'still the visual: restyled in place');
  display.irBoost = false;
  layer.frame(items, 200);
  item = models.items.get('t');
  assert.equal(item.shading, 'pbr');
  assert.equal(item.maskColor, '#ff0000');
  layer.destroy();
});

test('a waterline layer clips each model at its origin, keeping the part above', () => {
  const { layer, frame } = readyLayer({
    display: { models3d: true },
    waterline: true,
  });
  const ship = vesselModelSpec(set, { type: '70', length: 200, beam: 32 });
  const models = frame(new Map([['s', itemAt(10, ship, { pickId: 's' })]]), 0);
  assert.equal(models.items.get('s').clip, 'belowOrigin');
  layer.destroy();

  const plain = readyLayer({ display: { models3d: true } });
  const others = plain.frame(
    new Map([['t', itemAt(10, transitModelSpec(set, { mode: 'tram' }))]]),
    0,
  );
  assert.equal(others.items.get('t').clip, undefined, 'others unclipped');
  plain.layer.destroy();
});

test('a failed model loads again after a while; the icon stays meanwhile', () => {
  const { viewer, draw } = fakeViewer();
  const layer = createFleetModelLayer({
    viewer,
    display: () => ({ models3d: true }),
    policy: POLICY,
  });
  const tram = transitModelSpec(set, { mode: 'tram' });
  const items = new Map([['t', itemAt(10, tram, { pickId: 't' })]]);
  layer.frame(items, 0);
  const models = modelSet(draw);
  draw.loadFailed(models.spec.id, 't');
  layer.frame(items, 100);
  assert.equal(items.get('t').modelOwnsVisual, false);
  assert.equal(layer.settling, 0, 'a failed model is not waited on');
  layer.destroy();
});

test('without a draw port that draws models, vehicles stay icons', () => {
  const viewer = {};
  const layer = createFleetModelLayer({
    viewer,
    display: () => ({ models3d: true }),
    policy: POLICY,
    draw: { models: undefined },
  });
  const items = new Map([
    ['t', itemAt(10, transitModelSpec(set, { mode: 'tram' }))],
  ]);
  assert.equal(layer.active(), false);
  assert.equal(layer.frame(items, 0), false);
  assert.equal(items.get('t').modelOwnsVisual, false);
  layer.destroy();
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
    /if \(!visual\.visible\) continue;/,
  );
  assert.match(
    read('src/layers/transit/rendering.js'),
    /entry\.mode === 'unknown'/,
    'a vehicle of unknown mode keeps its icon',
  );
});
