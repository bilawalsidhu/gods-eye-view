// The aircraft display on the engine contract, on the fake engine and on the
// Cesium engine (real Cesium collections, billboards, models and
// polylines over a stub scene: they draw nothing but hold what the engine
// writes): the fleet's sprite sets, handle writes committed once per frame,
// the tracked glyph's per-frame callbacks, the follow and its readout label,
// model poses, loads and readiness, the view, the trail lines and teardown.

import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import * as geo from '../../../geo/index.js';
import { createFakeEngine } from '../../../globe/testing/fakeEngine.js';
import { createCesiumMoversEngine } from '../../../testSupport/cesiumMoversEngine.mjs';
import { aircraftIcon, TRACKED_ICON_PX } from '../../../data/aircraftIcons.js';
import { CYAN, WHITE, nearFarScale, rgbaFromCss } from '../../shared/color.js';
import {
  aircraftAtlasLayout,
  aircraftIconCells,
  aircraftLayerDisplay,
  createAircraftDisplay,
} from './display.js';

const layout = aircraftAtlasLayout();
const drawAtlas = async () => ({
  canvas: { width: layout.width, height: layout.height },
  cells: layout.cells,
});
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const AXIS = Cesium.Matrix4.multiplyTransformation(
  Cesium.Axis.Y_UP_TO_Z_UP,
  Cesium.Axis.Z_UP_TO_X_UP,
  new Cesium.Matrix4(),
);
const SCALE_BY_DISTANCE = nearFarScale(1000, 3.0, 8000000, 0.5);

function fakeHarness() {
  const engine = createFakeEngine();
  return {
    name: 'the fake engine',
    engine,
    frame: () => engine.fake.frame(),
    destroy: () => engine.destroy(),
  };
}

function cesiumHarness() {
  const { engine, ...rest } = createCesiumMoversEngine();
  return {
    name: 'the Cesium engine',
    cesium: true,
    engine,
    ...rest,
    destroy: () => engine.destroy(),
  };
}

const HARNESSES = [fakeHarness, cesiumHarness];

async function setup(makeHarness, options = {}) {
  const harness = makeHarness();
  harness.engine.camera.setView({
    destination: geo.cartesian3.fromDegrees(-97.7, 30.2, 50_000),
  });
  const display = createAircraftDisplay(harness.engine, {
    layerId: 'flights',
    order: 8,
    headingOffsetDeg: 180,
    drawAtlas,
    ...options,
  });
  await display.whenReady();
  display.fleet.attach();
  return { ...harness, display };
}

const setsOf = (engine, prefix) =>
  engine.movers.list().filter(({ id }) => id.startsWith(prefix));

const near = (actual, expected, label, tolerance = 1e-6) =>
  assert.ok(
    Math.abs(actual - expected) < tolerance,
    `${label}: ${actual} vs ${expected}`,
  );

const fleetSpec = (overrides = {}) => ({
  position: geo.cartesian3.fromDegrees(-97.7, 30.2, 3000),
  image: aircraftIcon('helicopter'),
  width: 20,
  height: 20,
  scale: 1.5,
  rotation: 0.3,
  color: rgbaFromCss('#FFB800'),
  scaleByDistance: SCALE_BY_DISTANCE,
  disableDepthTestDistance: Number.POSITIVE_INFINITY,
  id: 'abc123',
  show: true,
  ...overrides,
});

const trackedSpec = (state) => ({
  position: () => state.position,
  image: aircraftIcon('airliner', TRACKED_ICON_PX),
  width: 28,
  height: 28,
  scale: 1.2,
  color: () => state.color,
  scaleByDistance: SCALE_BY_DISTANCE,
  disableDepthTestDistance: Number.POSITIVE_INFINITY,
  rotation: () => 0.25,
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

test("a layer's factory puts its sprites in its data/spriteOrder slot", async () => {
  const engine = createFakeEngine();
  const display = aircraftLayerDisplay('military', 90)(engine, { drawAtlas });
  await display.whenReady();
  display.fleet.attach();
  display.fleet.add(fleetSpec());
  await Promise.resolve();
  const [listed] = setsOf(engine, 'military-sprites');
  assert.equal(engine.fake.moverSet(listed.id).options.order, 8);
  display.destroy();
  engine.destroy();
});

for (const makeHarness of HARNESSES) {
  const { name } = makeHarness();

  test(`fleet sprites draw as the layer asked, written once per frame (${name})`, async () => {
    const h = await setup(makeHarness);
    const { engine, display } = h;
    assert.equal(display.fleet.attached(), true);
    assert.equal(display.fleet.visible(), true);
    const spec = fleetSpec();
    const sprite = display.fleet.add(spec);
    assert.equal(sprite.id, 'abc123');
    assert.equal(sprite.width, 20);
    await settle();
    const [listed] = setsOf(engine, 'flights-sprites');
    assert.equal(listed.count, 1);
    if (h.cesium) {
      const collection = h.primitive(listed.id);
      assert.ok(collection instanceof Cesium.BillboardCollection);
      const billboard = collection.get(0);
      assert.ok(Cesium.Cartesian3.equals(billboard.position, spec.position));
      assert.equal(billboard.id, 'abc123');
      near(billboard.scale, 1.5, 'scale');
      near(billboard.rotation, 0.3, 'rotation');
      assert.equal(billboard.width, 20);
      assert.equal(billboard.height, 20);
      assert.equal(
        billboard.disableDepthTestDistance,
        Number.POSITIVE_INFINITY,
      );
      assert.ok(
        Cesium.NearFarScalar.equals(
          billboard.scaleByDistance,
          new Cesium.NearFarScalar(1000, 3, 8000000, 0.5),
        ),
      );
      assert.ok(
        billboard.color.equalsEpsilon(
          Cesium.Color.fromCssColorString('#FFB800'),
          1e-6,
        ),
      );
      assert.equal(billboard.show, true);
    } else {
      const set = engine.fake.moverSet(listed.id);
      assert.equal(set.options.depthTest, 'always');
      assert.deepEqual(
        set.options.sprite.scaleByDistance,
        [1000, 3, 8000000, 0.5],
      );
      assert.equal(set.options.sprite.sizePx, 20);
      assert.equal(set.options.order, 8);
      assert.equal(set.options.pickable, true);
      const { store } = set;
      assert.equal(store.positions[0], spec.position.x);
      assert.equal(store.pickIds[0], 'abc123');
      assert.equal(store.cellKeys[store.cells[0]], 'helicopter@64');
      near(store.scales[0], 1.5, 'scale');
      near(store.rotations[0], 0.3, 'rotation');
      near(store.colors[1], 184 / 255, 'green');
    }
    // Writes inside a frame listener commit at its end, once.
    const commits = h.cesium
      ? null
      : () => engine.fake.moverSet(listed.id).commits;
    const before = commits?.();
    const remove = display.view.on('preRender', () => {
      sprite.color = WHITE.withAlpha(0.45);
      sprite.scale = 2;
      sprite.width = 24;
      sprite.image = aircraftIcon('helicopter', TRACKED_ICON_PX);
      sprite.show = false;
    });
    h.frame();
    remove();
    if (commits) assert.equal(commits(), before + 1);
    assert.equal(sprite.color.alpha, 0.45);
    if (h.cesium) {
      const billboard = h.primitive(listed.id).get(0);
      near(billboard.color.alpha, 0.45, 'alpha');
      near(billboard.scale, 2.4, 'scale × width/20');
      assert.equal(billboard.show, false);
    } else {
      const { store } = engine.fake.moverSet(listed.id);
      near(store.colors[3], 0.45, 'alpha');
      near(store.scales[0], 2.4, 'scale × width/20');
      assert.equal(
        store.cellKeys[store.cells[0]],
        `helicopter@${TRACKED_ICON_PX}`,
      );
      assert.equal(store.shows[0], 0);
    }
    // Removal moves the last sprite into the hole.
    const other = display.fleet.add(
      fleetSpec({ image: aircraftIcon('light'), id: 'def456' }),
    );
    display.fleet.remove(sprite);
    await settle();
    assert.equal(setsOf(engine, 'flights-sprites')[0].count, 1);
    assert.equal(other.gevIndex, 0);
    if (h.cesium) assert.equal(h.primitive(listed.id).get(0).id, 'def456');
    else
      assert.equal(engine.fake.moverSet(listed.id).store.pickIds[0], 'def456');
    // Another depth mode is another set.
    other.disableDepthTestDistance = 0;
    await settle();
    assert.equal(setsOf(engine, 'flights-sprites').length, 2);
    display.fleet.setVisible(false);
    await settle();
    assert.equal(display.fleet.visible(), false);
    assert.ok(setsOf(engine, 'flights-sprites').every(({ count }) => !count));
    display.fleet.detach();
    assert.equal(display.fleet.attached(), false);
    assert.equal(setsOf(engine, 'flights-sprites').length, 0);
    display.destroy();
    assert.equal(engine.movers.list().length, 0, 'no set left behind');
    h.destroy();
  });

  test(`a model pose is the heading-pitch-roll frame with the nose offset; the instance turns the glTF's own axes (${name})`, async () => {
    const h = await setup(makeHarness);
    const { engine, display } = h;
    const model = await display.models.loadFleet({
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
    display.models.add(model);
    const position = geo.cartesian3.fromDegrees(-97.7, 30.2, 3000);
    const written = display.models.setPose(model, position, 75);
    assert.equal(written, model.modelMatrix, 'the model own matrix');
    const expected = Cesium.Transforms.headingPitchRollToFixedFrame(
      position,
      new Cesium.HeadingPitchRoll(Cesium.Math.toRadians(75 + 180), 0, 0),
      Cesium.Ellipsoid.WGS84,
    );
    for (let index = 0; index < 16; index++)
      near(model.modelMatrix[index], expected[index], `modelMatrix ${index}`);
    // What draws: the model frame × Cesium's glTF axis correction, which
    // Cesium's own Model applied to the model frame (the movers load the
    // glTF uncorrected).
    const drawn = Cesium.Matrix4.multiplyTransformation(
      expected,
      AXIS,
      new Cesium.Matrix4(),
    );
    await settle();
    const [listed] = setsOf(engine, 'flights-models');
    assert.equal(listed.count, 1);
    if (h.cesium) {
      const [instance] = h.loads;
      for (let index = 0; index < 12; index++)
        near(instance.modelMatrix[index], drawn[index], `drawn ${index}`);
      assert.equal(instance.show, false, 'admitted hidden');
      assert.equal(instance.id, 'abc123');
      assert.equal(model.ready, false, 'until the model has loaded');
      instance.ready = true;
      assert.equal(model.ready, true);
    } else {
      const q = Cesium.Quaternion.fromRotationMatrix(
        Cesium.Matrix4.getMatrix3(drawn, new Cesium.Matrix3()),
      );
      const { store, options } = engine.fake.moverSet(listed.id);
      assert.equal(options.model.minimumPixelSize, 24);
      assert.deepEqual(options.model.colorBlend, { mode: 'mix', amount: 0.94 });
      for (const [k, value] of ['x', 'y', 'z', 'w'].entries())
        near(store.orientations[k], q[value], value, 1e-9);
      assert.equal(store.shows[0], 0, 'admitted hidden');
      assert.equal(model.ready, true, 'the fake engine draws at once');
    }
    model.show = true;
    await settle();
    if (h.cesium) assert.equal(h.loads[0].show, true);
    else
      assert.equal(
        engine.fake.moverSet(listed.id).store.shows[0],
        1,
        'shown once placed',
      );
    assert.ok(model.computedScale >= model.scale);
    // A per-model nose offset (military per-class specs).
    display.models.setPose(model, position, 75, 90);
    const offset = Cesium.Transforms.headingPitchRollToFixedFrame(
      position,
      new Cesium.HeadingPitchRoll(Cesium.Math.toRadians(75 + 90), 0, 0),
      Cesium.Ellipsoid.WGS84,
    );
    for (let index = 0; index < 16; index++)
      near(model.modelMatrix[index], offset[index], `offset ${index}`);
    display.models.setVisible(false);
    await settle();
    assert.equal(setsOf(engine, 'flights-models')[0].count, 0);
    assert.equal(display.models.live(), true);
    display.destroy();
    assert.equal(display.models.live(), false);
    assert.equal(engine.movers.list().length, 0);
    h.destroy();
  });

  test(`the tracked glyph reads its callbacks every frame; the follow centres it and carries its readout label (${name})`, async () => {
    const h = await setup(makeHarness);
    const { engine, display } = h;
    const state = {
      position: geo.cartesian3.fromDegrees(-97.7, 30.2, 3000),
      color: CYAN,
    };
    const handle = display.tracked.create(trackedSpec(state));
    handle.gevTrackedId = 'flights:abc123';
    handle.gevLabelModel = { title: 'DAL123' };
    handle.gevDisplayPosition = () => state.position;
    assert.equal(display.tracked.isLive(handle), true);
    assert.deepEqual(display.tracked.billboardSize(handle), {
      width: 28,
      height: 28,
      scale: 1.2,
      scaleByDistance: { ...SCALE_BY_DISTANCE },
    });
    display.tracked.setViewFrom(handle, { x: 0, y: -2400, z: 1650 });
    assert.deepEqual(
      [handle.viewFrom.x, handle.viewFrom.y, handle.viewFrom.z],
      [0, -2400, 1650],
    );
    h.frame();
    await settle();
    const [listed] = setsOf(engine, 'flights-tracked');
    assert.equal(listed.count, 1);
    const read = () => {
      if (h.cesium) {
        const billboard = h.primitive(listed.id).get(0);
        return {
          x: billboard.position.x,
          alpha: billboard.color.alpha,
          rotation: billboard.rotation,
          id: billboard.id,
        };
      }
      const { store } = engine.fake.moverSet(listed.id);
      return {
        x: store.positions[0],
        alpha: store.colors[3],
        rotation: store.rotations[0],
        id: store.pickIds[0],
      };
    };
    assert.equal(read().id, handle.id);
    near(read().rotation, 0.25, 'rotation');
    if (h.cesium) {
      const billboard = h.primitive(listed.id).get(0);
      assert.equal(
        billboard.disableDepthTestDistance,
        Number.POSITIVE_INFINITY,
      );
      assert.equal(billboard.width, 20);
      near(billboard.scale, 1.2 * (28 / 20), 'scale × width/20');
    }
    state.position = geo.cartesian3.fromDegrees(-97.6, 30.2, 3000);
    state.color = CYAN.withAlpha(0);
    h.frame();
    assert.equal(read().x, state.position.x, 'the position, per frame');
    assert.equal(read().alpha, 0, 'the colour, per frame');

    const stop = display.follow.start(handle);
    assert.equal(typeof stop, 'function');
    const following = engine.camera.following();
    assert.equal(following, handle.gevFollowHandle);
    assert.equal(following.native, handle, 'cockpit follows the glyph');
    assert.equal(following.label.id, 'flights:abc123');
    assert.equal(following.label.model(), handle.gevLabelModel);
    assert.equal(display.follow.isFollowing(handle), true);
    assert.equal(display.follow.current(), handle);
    if (h.cesium) {
      const proxy = h.viewer.trackedEntity;
      assert.ok(proxy instanceof Cesium.Entity);
      assert.equal(
        proxy.trackingReferenceFrame,
        Cesium.TrackingReferenceFrame.ENU,
      );
      assert.equal(proxy.gevTrackedId, 'flights:abc123');
      const time = h.viewer.clock.currentTime;
      assert.ok(
        Cesium.Cartesian3.equals(proxy.viewFrom.getValue(time), {
          x: 0,
          y: -2400,
          z: 1650,
        }),
      );
    }
    // The glyph draws where the follow centred in its frame.
    const centred = state.position;
    assert.equal(following.target(), centred);
    state.position = geo.cartesian3.fromDegrees(-97.5, 30.2, 3000);
    if (h.cesium) {
      h.frame();
      assert.equal(read().x, centred.x, "the follow's sample");
      h.frame();
    } else h.frame();
    assert.equal(read().x, state.position.x);

    display.follow.release();
    assert.equal(engine.camera.following(), null);
    assert.equal(display.follow.current(), undefined);
    assert.equal(display.follow.isFollowing(handle), false);
    if (h.cesium) assert.equal(h.viewer.trackedEntity, undefined);
    handle.resumeAircraftFollow();
    assert.equal(display.follow.current(), handle);
    display.tracked.remove(handle);
    assert.equal(engine.camera.following(), null);
    assert.equal(display.tracked.isLive(handle), false);
    await settle();
    assert.equal(setsOf(engine, 'flights-tracked')[0].count, 0);
    display.destroy();
    h.destroy();
  });

  test(`a tracked glyph hidden through its follow's target stays hidden, as the Cockpit rides it (${name})`, async () => {
    const h = await setup(makeHarness);
    const { engine, display } = h;
    const state = {
      position: geo.cartesian3.fromDegrees(-97.7, 30.2, 3000),
      color: CYAN,
    };
    const handle = display.tracked.create(trackedSpec(state));
    display.tracked.setViewFrom(handle, { x: 0, y: -2400, z: 1650 });
    display.follow.start(handle);
    h.frame();
    await settle();
    const [listed] = setsOf(engine, 'flights-tracked');
    const drawn = () =>
      h.cesium
        ? h.primitive(listed.id).get(0).show
        : engine.fake.moverSet(listed.id).store.shows[0] === 1;
    assert.equal(drawn(), true);
    // The Cockpit hides what the engine follows, then releases the follow.
    const ridden = engine.camera.following().native;
    assert.equal(ridden, handle);
    ridden.show = false;
    engine.camera.following().stop();
    state.position = geo.cartesian3.fromDegrees(-97.6, 30.2, 3000);
    h.frame();
    await settle();
    assert.equal(drawn(), false, 'not drawn while ridden');
    // Another distance scale moves it to another set, still hidden.
    handle.scaleByDistance = nearFarScale(1000, 2.0, 8000000, 0.5);
    await settle();
    const moved = setsOf(engine, 'flights-tracked').find(
      ({ count }) => count === 1,
    );
    const shownIn = (set) =>
      h.cesium
        ? h.primitive(set.id).get(0).show
        : engine.fake.moverSet(set.id).store.shows[0] === 1;
    assert.equal(shownIn(moved), false);
    ridden.show = true;
    ridden.resumeAircraftFollow();
    h.frame();
    await settle();
    assert.equal(shownIn(moved), true, 'drawn again on exit');
    assert.equal(display.follow.current(), handle);
    display.destroy();
    h.destroy();
  });

  test(`another layer's follow reads as what it follows (${name})`, async () => {
    const h = await setup(makeHarness);
    const { engine, display } = h;
    const changes = [];
    const remove = display.follow.onChanged(() =>
      changes.push(display.follow.current()),
    );
    const native = h.cesium
      ? new Cesium.Entity({
          position: geo.cartesian3.fromDegrees(0, 0, 400_000),
          viewFrom: new Cesium.Cartesian3(0, -900, 400),
        })
      : { gevSelectionOrigin: 'user' };
    if (h.cesium) {
      native.gevSelectionOrigin = 'user';
      h.viewer.entities.add(native);
    }
    engine.camera.follow({
      native,
      position: () => geo.cartesian3.fromDegrees(0, 0, 400_000),
      viewFrom: { x: 0, y: -900, z: 400 },
    });
    assert.equal(display.follow.current(), native);
    assert.equal(display.follow.current().gevSelectionOrigin, 'user');
    assert.deepEqual(changes, [native]);
    display.follow.release();
    assert.equal(engine.camera.following(), null);
    remove();
    display.destroy();
    h.destroy();
  });

  test(`trails are geodesic lines in the trail pick namespace; the head follows each frame (${name})`, async () => {
    const h = await setup(makeHarness);
    const { engine, display } = h;
    const trail = display.trails.create({ color: '#00d4ff', width: 2.5 });
    const a = geo.cartesian3.fromDegrees(0, 0, 1000);
    const b = geo.cartesian3.fromDegrees(0.1, 0, 1000);
    trail.setPositions([a, a, b]);
    const [body] = engine.lines.list();
    assert.match(body.id, /^gev-trail:flights-/);
    assert.equal(body.points, 2, 'near-duplicates dropped');
    const base = Cesium.Color.fromCssColorString('#00d4ff');
    const alphas = (id) => {
      if (h.cesium) {
        const primitive = h.primitive(id);
        assert.equal(primitive.allowPicking, true);
        assert.equal(
          primitive.geometryInstances.geometry._arcType,
          Cesium.ArcType.GEODESIC,
        );
        assert.equal(primitive.geometryInstances.id, id);
        return [
          primitive.appearance.material.uniforms.color.alpha,
          primitive.depthFailAppearance.material.uniforms.color.alpha,
        ];
      }
      const { options } = engine.fake.line(id);
      assert.equal(options.arc, 'geodesic');
      assert.equal(options.pickId, id);
      return [options.color[3], options.color[3] * options.depthFailAlpha];
    };
    // 0.85 where it passes the depth test, 0.4 where the scene hides it.
    const [bodyAlpha, bodyHidden] = alphas(body.id);
    near(bodyAlpha, 0.85, 'trail alpha');
    near(bodyHidden, 0.4, 'trail occluded alpha');
    if (h.cesium) {
      const { color } = h.primitive(body.id).appearance.material.uniforms;
      near(color.red, base.red, 'trail red');
    }
    trail.setPositions([a]);
    assert.equal(engine.lines.list()[0].points, 0, 'one point draws nothing');
    trail.setVisible(false);
    assert.equal(engine.lines.list()[0].shown, false);
    trail.setVisible(true);
    let ends = [a, b];
    const head = display.trails.createHead({
      id: 'gev-trail:fl-head-1',
      show: true,
      positions: () => ends,
      color: '#00d4ff',
      width: 2.5,
    });
    assert.equal(head.id, 'gev-trail:fl-head-1');
    h.frame();
    const headLine = engine.lines
      .list()
      .find(({ id }) => id === 'gev-trail:fl-head-1');
    assert.equal(headLine.points, 2);
    // 0.9 where it passes the depth test, 0.45 where the scene hides it.
    const [headAlpha, headHidden] = alphas(headLine.id);
    near(headAlpha, 0.9, 'head alpha');
    near(headHidden, 0.45, 'head occluded alpha');
    head.show = false;
    assert.equal(head.show, false);
    ends = [];
    h.frame();
    assert.equal(
      engine.lines.list().find(({ id }) => id === headLine.id).points,
      2,
      'a hidden head is not read',
    );
    display.trails.removeHead(head);
    trail.destroy();
    assert.equal(engine.lines.list().length, 0);
    // The display releases what the layer left.
    display.trails.createHead({
      id: 'gev-trail:fl-head-2',
      positions: () => [a, b],
      color: '#00d4ff',
    });
    display.trails.create({ color: '#00d4ff' }).setPositions([a, b]);
    assert.equal(engine.lines.list().length, 2);
    display.destroy();
    assert.equal(engine.lines.list().length, 0);
    h.frame();
    h.destroy();
  });

  test(`the view: camera, frustum, horizon, frame number and viewport (${name})`, async () => {
    const h = await setup(makeHarness);
    const { engine, display } = h;
    engine.camera.setView({
      destination: geo.cartesian3.fromDegrees(-73.78, 40.0, 50_000),
    });
    const { view } = display;
    near(view.camera.positionCartographic.height, 50_000, 'height', 1);
    const inFrustum = view.frustumTester();
    const below = geo.cartesian3.fromDegrees(-73.78, 40.0, 0);
    const behind = geo.cartesian3.fromDegrees(106.22, -40.0, 0);
    const aboveCamera = geo.cartesian3.fromDegrees(-73.78, 40.0, 200_000);
    assert.equal(inFrustum(below), true);
    assert.equal(inFrustum(aboveCamera), false);
    assert.equal(view.horizon().isPointVisible(below), true);
    assert.equal(view.horizon().isPointVisible(behind), false);
    const screen = view.worldToWindow(below);
    const { width, height } = engine.host.size();
    near(screen.x, width / 2, 'centre x', 1);
    near(screen.y, height / 2, 'centre y', 1);
    assert.equal(view.viewportHeightPx(), height);
    const frame = view.frameNumber();
    h.frame();
    assert.equal(view.frameNumber(), frame + 1);
    let moved = 0;
    const remove = view.on('preUpdate', () => moved++);
    h.frame();
    remove();
    h.frame();
    assert.equal(moved, 1);
    display.destroy();
    h.destroy();
  });

  test(`the surface probe skips the layer's own mover sets (${name})`, async () => {
    const h = await setup(makeHarness);
    const { engine, display } = h;
    display.fleet.add(fleetSpec());
    const model = await display.models.loadFleet({
      url: '/models/airplane.glb',
      id: 'abc123',
    });
    display.models.add(model);
    await settle();
    const excluded = display.surfaceExclusions({
      sprites: [],
      models: [model],
    });
    assert.deepEqual(
      excluded.map((set) => set.id).sort(),
      engine.movers
        .list()
        .map(({ id }) => id)
        .sort(),
    );
    // The engine's surface takes them (Cesium: hidden for the sample).
    assert.doesNotThrow(() =>
      engine.surface.sampleHeight(
        geo.cartographic.fromDegrees(-97.7, 30.2, 0),
        excluded,
      ),
    );
    display.destroy();
    h.destroy();
  });
}

test('the bank grows past its capacity without losing sprites', async () => {
  const { engine, display, destroy } = await setup(fakeHarness);
  for (let index = 0; index < 1500; index++)
    display.fleet.add({
      position: geo.cartesian3.fromDegrees(index * 0.01, 0, 1000),
      image: aircraftIcon('airliner'),
      id: `a${index}`,
      scaleByDistance: SCALE_BY_DISTANCE,
    });
  await Promise.resolve();
  const sets = setsOf(engine, 'flights-sprites');
  assert.equal(sets.length, 1);
  assert.equal(sets[0].count, 1500);
  assert.ok(sets[0].capacity >= 1500);
  const { store } = engine.fake.moverSet(sets[0].id);
  assert.equal(store.pickIds[1499], 'a1499');
  display.destroy();
  destroy();
});

test('sprites added before the atlas draw once it is', async () => {
  const engine = createFakeEngine();
  let finish;
  const display = createAircraftDisplay(engine, {
    layerId: 'flights',
    drawAtlas: () => new Promise((resolve) => (finish = resolve)),
  });
  display.fleet.attach();
  const sprite = display.fleet.add(fleetSpec());
  await Promise.resolve();
  assert.equal(setsOf(engine, 'flights-sprites').length, 0);
  sprite.scale = 2;
  finish(await drawAtlas());
  await display.whenReady();
  await Promise.resolve();
  const [listed] = setsOf(engine, 'flights-sprites');
  assert.equal(listed.count, 1);
  near(engine.fake.moverSet(listed.id).store.scales[0], 2, 'latest scale');
  display.destroy();
  engine.destroy();
});

test('unchanged sprite style does not upload or request another frame', async () => {
  const { engine, display, destroy } = await setup(fakeHarness);
  const sprite = display.fleet.add({
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
  display.destroy();
  destroy();
});

test('reused sprite field records are copied, including a mutated color getter', async () => {
  const { engine, display, destroy } = await setup(fakeHarness);
  const a = display.fleet.add({
    id: 'a',
    position: geo.cartesian3.fromDegrees(0, 0, 1000),
    image: aircraftIcon('light'),
  });
  const b = display.fleet.add({
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
  // eslint-disable-next-line no-self-assign
  a.color = a.color;
  b.color = WHITE.withAlpha(0.75);
  await Promise.resolve();
  assert.deepEqual([...store.positions.subarray(0, 6)], [7, 8, 9, 20, 8, 9]);
  assert.equal(store.colors[3], 0.25);
  assert.equal(store.colors[7], 0.75);
  display.destroy();
  destroy();
});

test("model loads on Cesium carry the layer's look; the IR boost is unlit; readiness is per model", async () => {
  const h = await setup(cesiumHarness);
  const { display, loads } = h;
  const spec = {
    url: '/models/airplane.glb',
    minimumPixelSize: 24,
    scale: 1,
    color: CYAN,
    blendAmount: 0.94,
    unlit: false,
    id: 'abc123',
  };
  const position = geo.cartesian3.fromDegrees(-97.7, 30.2, 3000);
  const fleet = await display.models.loadFleet(spec);
  const second = await display.models.loadFleet({ ...spec, id: 'def456' });
  const boosted = await display.models.loadTracked({
    ...spec,
    unlit: true,
    minimumPixelSize: 40,
    id: 'ghi789',
  });
  for (const model of [fleet, second, boosted]) {
    display.models.add(model);
    display.models.setPose(model, position, 10);
  }
  await settle();
  assert.equal(loads.length, 3, 'one Cesium model per instance');
  const [first, other, unlit] = loads;
  for (const { options } of loads) {
    assert.equal(options.asynchronous, false);
    assert.deepEqual(options.environmentMapOptions, { enabled: false });
    assert.equal(options.url, '/models/airplane.glb');
    assert.equal(options.colorBlendMode, Cesium.ColorBlendMode.MIX);
    assert.equal(options.colorBlendAmount, 0.94);
    assert.equal(options.allowPicking, true);
  }
  assert.equal(first.options.minimumPixelSize, 24);
  assert.equal(first.options.customShader, undefined);
  assert.equal(unlit.options.minimumPixelSize, 40);
  assert.equal(
    unlit.options.customShader.lightingModel,
    Cesium.LightingModel.UNLIT,
  );
  assert.equal(first.id, 'abc123', 'picks name the aircraft');
  assert.equal(unlit.id, 'ghi789');
  assert.ok(first.color.equalsEpsilon(Cesium.Color.CYAN, 1e-6));
  // Readiness is each model's own: one loading model leaves the others up.
  first.ready = true;
  unlit.ready = true;
  assert.equal(fleet.ready, true);
  assert.equal(second.ready, false);
  assert.equal(boosted.ready, true);
  other.ready = true;
  assert.equal(second.ready, true);
  // A removed model's place goes to the last one, ready with its model.
  display.models.remove(fleet);
  await settle();
  assert.equal(second.gevIndex, 0);
  assert.equal(second.ready, true);
  display.destroy();
  h.destroy();
});
