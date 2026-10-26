// The aircraft renderer on the engine contract (Navara's), over the fake
// engine: the contract's members, sprite banks with the glyph atlas, handle
// writes committed once per frame, the tracked glyph's per-frame callbacks,
// the follow and its readout label, model poses and the trail lines.

import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import * as geo from '../../../geo/index.js';
import { createFakeEngine } from '../../../globe/testing/fakeEngine.js';
import { aircraftIcon, TRACKED_ICON_PX } from '../../../data/aircraftIcons.js';
import { CYAN, WHITE, nearFarScale, rgbaFromCss } from '../../shared/color.js';
import { missingAircraftRendererMembers } from './contract.js';
import {
  aircraftAtlasLayout,
  aircraftIconCells,
  createAircraftNavaraRenderer,
} from './navara.js';

const layout = aircraftAtlasLayout();
const drawAtlas = async () => ({
  canvas: { width: layout.width, height: layout.height },
  cells: layout.cells,
});

async function setup() {
  const engine = createFakeEngine();
  const renderer = createAircraftNavaraRenderer({
    engine,
    layerId: 'flights',
    order: 8,
    headingOffsetDeg: 180,
    drawAtlas,
  });
  await renderer.whenReady();
  return { engine, renderer };
}

const setsOf = (engine, prefix) =>
  engine.movers.list().filter(({ id }) => id.startsWith(prefix));

test('the Navara aircraft renderer has every member of the contract', async () => {
  const { engine, renderer } = await setup();
  assert.deepEqual(missingAircraftRendererMembers(renderer), []);
  assert.equal(renderer.kind, 'navara');
  renderer.destroy();
  engine.destroy();
});

test('the atlas has every glyph at the fleet and tracked sizes', () => {
  const cells = aircraftIconCells();
  for (const key of cells.values())
    assert.ok(layout.cells[key], `${key} in the atlas`);
  for (const [, [u0, v0, u1, v1]] of Object.entries(layout.cells))
    assert.ok(u0 >= 0 && v0 >= 0 && u1 <= 1 && v1 <= 1 && u1 > u0 && v1 > v0);
  assert.equal(
    cells.get(aircraftIcon('quadjet', TRACKED_ICON_PX)),
    `quadjet@${TRACKED_ICON_PX}`,
  );
});

test('fleet sprites write the mover store, once per frame', async () => {
  const { engine, renderer } = await setup();
  const position = geo.cartesian3.fromDegrees(-97.7, 30.2, 3000);
  const sprite = renderer.fleet.add({
    position,
    image: aircraftIcon('helicopter'),
    width: 20,
    height: 20,
    scale: 1.5,
    rotation: 0.3,
    color: rgbaFromCss('#FFB800'),
    scaleByDistance: nearFarScale(1000, 3.0, 8000000, 0.5),
    disableDepthTestDistance: Number.POSITIVE_INFINITY,
    id: 'abc123',
    show: true,
  });
  await Promise.resolve();
  const [listed] = setsOf(engine, 'flights-sprites');
  const set = engine.fake.moverSet(listed.id);
  assert.equal(set.options.depthTest, 'always');
  assert.deepEqual(set.options.sprite.scaleByDistance, [1000, 3, 8000000, 0.5]);
  assert.equal(set.options.sprite.sizePx, 20);
  assert.equal(set.options.order, 8);
  const { store } = set;
  assert.equal(store.count, 1);
  assert.equal(store.positions[0], position.x);
  assert.equal(store.pickIds[0], 'abc123');
  assert.equal(store.cellKeys[store.cells[0]], 'helicopter@64');
  assert.ok(Math.abs(store.scales[0] - 1.5) < 1e-6);
  assert.ok(Math.abs(store.rotations[0] - 0.3) < 1e-6);
  assert.ok(Math.abs(store.colors[1] - 184 / 255) < 1e-6);
  // Writes inside a frame listener commit at its end, once.
  const before = set.commits;
  const remove = renderer.view.on('preRender', () => {
    sprite.color = WHITE.withAlpha(0.45);
    sprite.scale = 2;
    sprite.width = 24;
    sprite.image = aircraftIcon('helicopter', TRACKED_ICON_PX);
    sprite.show = false;
  });
  engine.fake.frame();
  remove();
  assert.equal(engine.fake.moverSet(listed.id).commits, before + 1);
  assert.ok(Math.abs(store.colors[3] - 0.45) < 1e-6);
  assert.ok(Math.abs(store.scales[0] - 2.4) < 1e-6, 'scale × width/20');
  assert.equal(store.cellKeys[store.cells[0]], `helicopter@${TRACKED_ICON_PX}`);
  assert.equal(store.shows[0], 0);
  assert.equal(sprite.color.alpha, 0.45);
  // Removal moves the last sprite into the hole.
  const other = renderer.fleet.add({
    position,
    image: aircraftIcon('light'),
    id: 'def456',
    scaleByDistance: nearFarScale(1000, 3.0, 8000000, 0.5),
    disableDepthTestDistance: Number.POSITIVE_INFINITY,
  });
  renderer.fleet.remove(sprite);
  await Promise.resolve();
  assert.equal(store.count, 1);
  assert.equal(store.pickIds[0], 'def456');
  assert.equal(other.gevIndex, 0);
  renderer.fleet.setVisible(false);
  await Promise.resolve();
  assert.equal(store.count, 0);
  assert.equal(renderer.fleet.visible(), false);
  renderer.destroy();
  assert.equal(setsOf(engine, 'flights').length, 0, 'no set left behind');
  engine.destroy();
});

test('the bank grows past its capacity without losing sprites', async () => {
  const { engine, renderer } = await setup();
  const sprites = [];
  for (let index = 0; index < 1500; index++)
    sprites.push(
      renderer.fleet.add({
        position: geo.cartesian3.fromDegrees(index * 0.01, 0, 1000),
        image: aircraftIcon('airliner'),
        id: `a${index}`,
        scaleByDistance: nearFarScale(1000, 3.0, 8000000, 0.5),
      }),
    );
  await Promise.resolve();
  const sets = setsOf(engine, 'flights-sprites');
  assert.equal(sets.length, 1);
  assert.equal(sets[0].count, 1500);
  assert.ok(sets[0].capacity >= 1500);
  const { store } = engine.fake.moverSet(sets[0].id);
  assert.equal(store.pickIds[1499], 'a1499');
  renderer.destroy();
  engine.destroy();
});

test('the tracked glyph reads its callbacks every frame; follow carries its readout label', async () => {
  const { engine, renderer } = await setup();
  let position = geo.cartesian3.fromDegrees(-97.7, 30.2, 3000);
  let color = CYAN;
  const handle = renderer.tracked.create({
    position: () => position,
    image: aircraftIcon('airliner', TRACKED_ICON_PX),
    width: 28,
    height: 28,
    scale: 1,
    color: () => color,
    scaleByDistance: nearFarScale(1000, 3.0, 8000000, 0.5),
    disableDepthTestDistance: Number.POSITIVE_INFINITY,
    rotation: () => 0.5,
  });
  handle.gevTrackedId = 'flights:abc123';
  handle.gevLabelModel = { title: 'DAL123' };
  handle.gevDisplayPosition = () => position;
  renderer.tracked.setViewFrom(handle, { x: 0, y: -2400, z: 1650 });
  engine.fake.frame();
  const [listed] = setsOf(engine, 'flights-tracked');
  const { store } = engine.fake.moverSet(listed.id);
  assert.equal(store.pickIds[0], handle.id);
  assert.ok(Math.abs(store.rotations[0] - 0.5) < 1e-6);
  position = geo.cartesian3.fromDegrees(-97.6, 30.2, 3000);
  color = CYAN.withAlpha(0);
  engine.fake.frame();
  assert.equal(
    store.positions[0],
    position.x,
    'the position callback, per frame',
  );
  assert.equal(store.colors[3], 0, 'the colour callback, per frame');

  const stop = renderer.follow.start(handle);
  assert.equal(typeof stop, 'function');
  const following = engine.camera.following();
  assert.equal(following, handle.gevFollowHandle);
  assert.equal(following.label.id, 'flights:abc123');
  assert.equal(following.label.model(), handle.gevLabelModel);
  assert.equal(renderer.follow.isFollowing(handle), true);
  assert.equal(renderer.follow.current(), handle);
  renderer.follow.release();
  assert.equal(engine.camera.following(), null);
  assert.equal(renderer.follow.current(), undefined);
  renderer.tracked.remove(handle);
  assert.equal(renderer.tracked.isLive(handle), false);
  renderer.destroy();
  engine.destroy();
});

test("a model pose is the Cesium model frame, turned to Navara's glTF axes", async () => {
  const { engine, renderer } = await setup();
  const model = await renderer.models.loadFleet({
    url: '/models/airplane.glb',
    minimumPixelSize: 24,
    scale: 1,
    radiusM: 34.41,
    color: WHITE,
    blendAmount: 0.94,
    unlit: false,
    id: 'abc123',
  });
  model.show = false;
  renderer.models.add(model);
  const position = geo.cartesian3.fromDegrees(-97.7, 30.2, 3000);
  renderer.models.setPose(model, position, 75);
  // modelMatrix is Cesium's (what the trail anchors read).
  const expected = Cesium.Transforms.headingPitchRollToFixedFrame(
    position,
    new Cesium.HeadingPitchRoll(Cesium.Math.toRadians(75 + 180), 0, 0),
    Cesium.Ellipsoid.WGS84,
  );
  for (let index = 0; index < 16; index++)
    assert.ok(Math.abs(model.modelMatrix[index] - expected[index]) < 1e-6);
  // The instance orientation: modelMatrix × Cesium's glTF axis correction
  // (Y_UP_TO_Z_UP × Z_UP_TO_X_UP; Navara's loader keeps the glTF Y-up).
  const corrected = Cesium.Matrix4.multiplyTransformation(
    expected,
    Cesium.Matrix4.multiplyTransformation(
      Cesium.Axis.Y_UP_TO_Z_UP,
      Cesium.Axis.Z_UP_TO_X_UP,
      new Cesium.Matrix4(),
    ),
    new Cesium.Matrix4(),
  );
  const q = Cesium.Quaternion.fromRotationMatrix(
    Cesium.Matrix4.getMatrix3(corrected, new Cesium.Matrix3()),
  );
  await Promise.resolve();
  const [listed] = setsOf(engine, 'flights-models');
  const set = engine.fake.moverSet(listed.id);
  assert.equal(set.options.model.minimumPixelSize, 24);
  assert.deepEqual(set.options.model.colorBlend, { mode: 'mix', amount: 0.94 });
  const { store } = set;
  for (const [k, value] of ['x', 'y', 'z', 'w'].entries())
    assert.ok(
      Math.abs(store.orientations[k] - q[value]) < 1e-9,
      `${value}: ${[...store.orientations.slice(0, 4)]} vs ${[q.x, q.y, q.z, q.w]}`,
    );
  assert.equal(store.shows[0], 0, 'admitted hidden');
  model.show = true;
  await Promise.resolve();
  assert.equal(store.shows[0], 1);
  assert.equal(model.ready, true, 'the fake engine draws at once');
  assert.ok(model.computedScale >= model.scale);
  renderer.destroy();
  engine.destroy();
});

test('trails are engine lines in the trail pick namespace; the head follows each frame', async () => {
  const { engine, renderer } = await setup();
  const trail = renderer.trails.create({ color: '#00d4ff', width: 2.5 });
  const a = geo.cartesian3.fromDegrees(0, 0, 1000);
  const b = geo.cartesian3.fromDegrees(0.1, 0, 1000);
  trail.setPositions([a, a, b]);
  const lines = engine.lines.list();
  assert.equal(lines.length, 1);
  const line = engine.fake.line(lines[0].id);
  assert.match(lines[0].id, /^gev-trail:/);
  assert.equal(line.options.pickId, lines[0].id);
  assert.ok(Math.abs(line.options.color[3] - 0.85) < 1e-9);
  assert.equal(line.options.arc, 'geodesic');
  let ends = [a, b];
  const head = renderer.trails.createHead({
    id: 'gev-trail:fl-head-1',
    show: true,
    positions: () => ends,
    color: '#00d4ff',
    width: 2.5,
  });
  engine.fake.frame();
  assert.equal(engine.lines.list().length, 2);
  head.show = false;
  ends = [];
  renderer.trails.removeHead(head);
  trail.destroy();
  assert.equal(engine.lines.list().length, 0);
  renderer.destroy();
  engine.destroy();
});

test('unchanged sprite style does not upload or request another frame', async () => {
  const { engine, renderer } = await setup();
  const sprite = renderer.fleet.add({
    id: 'same',
    position: geo.cartesian3.fromDegrees(0, 0, 1000),
    image: aircraftIcon('light'),
  });
  await Promise.resolve();
  const [listed] = setsOf(engine, 'flights-sprites');
  const part = engine.fake.moverSet(listed.id);
  const before = part.commits;
  const color = sprite.color;
  for (let n = 0; n < 1000; n++) {
    sprite.show = true;
    sprite.rotation = 0;
    sprite.scale = 1;
    sprite.width = 20;
    sprite.color = WHITE;
  }
  await Promise.resolve();
  assert.equal(part.commits, before);
  assert.equal(sprite.color, color);
  renderer.destroy();
  engine.destroy();
});

test('reused sprite field records are copied, including a mutated color getter', async () => {
  const { engine, renderer } = await setup();
  const a = renderer.fleet.add({
    id: 'a',
    position: geo.cartesian3.fromDegrees(0, 0, 1000),
    image: aircraftIcon('light'),
  });
  const b = renderer.fleet.add({
    id: 'b',
    position: a.position,
    image: aircraftIcon('light'),
  });
  await Promise.resolve();
  const [listed] = setsOf(engine, 'flights-sprites');
  const { store } = engine.fake.moverSet(listed.id);
  const position = geo.cartesian3.create(7, 8, 9);
  a.position = position;
  position.x = 20;
  b.position = position;
  a.color.alpha = 0.25;
  a.color = a.color;
  b.color = WHITE.withAlpha(0.75);
  await Promise.resolve();
  assert.deepEqual([...store.positions.subarray(0, 6)], [7, 8, 9, 20, 8, 9]);
  assert.equal(store.colors[3], 0.25);
  assert.equal(store.colors[7], 0.75);
  renderer.destroy();
  engine.destroy();
});
