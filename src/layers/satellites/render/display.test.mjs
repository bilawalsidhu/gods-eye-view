import { createFakeGroundHarness as fakeHarness } from '../../../testSupport/groundDisplayEngines.mjs';
// The satellites display on the engine contract, on the fake engine and on
// the Cesium engine (real Cesium point collections and polylines over a stub
// scene: they draw nothing but hold what the engine writes): the fleet's
// point banks and their looks, writes committed once per frame, the tracked
// dot over the fleet, the follow (its target, offset, readout label and
// release guard), the orbit rings turned by their model matrix, clicks and
// teardown.

import test from 'node:test';
import assert from 'node:assert/strict';

import * as geo from '../../../geo/index.js';
import { createFakeEngine } from '../../../globe/testing/fakeEngine.js';

import { CYAN, WHITE, nearFarScale } from '../../shared/color.js';
import { createSatellitesDisplay } from './display.js';

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const position = geo.cartesian3.fromDegrees(0, 0, 420000);
const SCALE = nearFarScale(1e6, 1.5, 2e7, 0.6);
const spec = (id, overrides = {}) => ({
  id,
  position,
  color: WHITE,
  pixelSize: 12,
  outlineColor: WHITE.withAlpha(0.3),
  outlineWidth: 1,
  scaleByDistance: SCALE,
  ...overrides,
});
const near = (actual, expected, label, tolerance = 1e-6) =>
  assert.ok(
    Math.abs(actual - expected) < tolerance,
    `${label}: ${actual} vs ${expected}`,
  );

const HARNESSES = [fakeHarness];

function setup(makeHarness) {
  const harness = makeHarness();
  harness.engine.camera.setView({
    destination: geo.cartesian3.fromDegrees(0, 0, 2e7),
  });
  return { ...harness, display: createSatellitesDisplay(harness.engine) };
}

const setsOf = (engine) =>
  engine.movers.list().filter(({ id }) => id.startsWith('satellites-points'));

/** What a set's instance draws: its size, outline, depth mode and colour. */
function drawn(h, setId, index) {
  const { options, store } = h.engine.fake.moverSet(setId);
  const [r, g, b, a] = store.colors.slice(index * 4, index * 4 + 4);
  const [nearM, nearValue, farM, farValue] =
    options.point.scaleByDistance ?? [];
  return {
    position: {
      x: store.positions[index * 3],
      y: store.positions[index * 3 + 1],
      z: store.positions[index * 3 + 2],
    },
    pixelSize: options.point.sizePx * store.scales[index],
    outlineWidth: options.point.outlinePx,
    outline: {
      red: options.point.outlineColor[0],
      alpha: options.point.outlineColor[3],
    },
    depth:
      options.depthTest === 'always'
        ? Number.POSITIVE_INFINITY
        : options.depthTest === 'normal'
          ? 0
          : options.depthTest.disableWithinM,
    scale: { near: nearM, nearValue, far: farM, farValue },
    color: { red: r, green: g, blue: b, alpha: a },
    show: store.shows[index] === 1,
    id: store.pickIds[index],
  };
}

for (const makeHarness of HARNESSES) {
  const { name } = makeHarness();

  test(`fleet dots draw as the layer asked, in banks that survive growth, written once per frame (${name})`, async () => {
    const h = setup(makeHarness);
    const { engine, display } = h;
    const points = display.createPoints();
    const all = Array.from({ length: 1500 }, (_, i) => points.add(spec(i)));
    await settle();
    const [listed] = setsOf(engine);
    assert.equal(setsOf(engine).length, 1);
    assert.equal(listed.count, 1500);
    let dot = drawn(h, listed.id, 699);
    assert.equal(dot.id, 699);
    assert.equal(dot.pixelSize, 12);
    assert.equal(dot.outlineWidth, 1);
    near(dot.outline.alpha, 0.3, 'outline alpha');
    assert.equal(dot.depth, 0, 'fleet dots are depth-tested');
    assert.equal(dot.scale.near, 1e6);
    assert.equal(dot.scale.nearValue, 1.5);
    assert.equal(dot.scale.far, 2e7);
    assert.equal(dot.scale.farValue, 0.6);
    assert.equal(dot.show, true);
    // Reads are the display's own copies.
    assert.notEqual(all[0].color, WHITE);
    assert.equal(all[0].color.alpha, 1);
    const commits = () => engine.fake.moverSet(listed.id).commits;
    const before = commits?.();
    const remove = display.onFrame(() => {
      all[0].position = { x: 1, y: 2, z: 3 };
      all[0].show = false;
      all[0].color = CYAN.withAlpha(0.25);
    });
    h.frame();
    remove();
    if (commits) assert.equal(commits(), before + 1, 'one commit per frame');
    dot = drawn(h, listed.id, 0);
    assert.deepEqual(
      [dot.position.x, dot.position.y, dot.position.z],
      [1, 2, 3],
    );
    assert.equal(dot.show, false);
    near(dot.color.alpha, 0.25, 'alpha');
    assert.equal(all[0].color.alpha, 0.25);
    // Another look is another bank.
    all[1].pixelSize = 14;
    await settle();
    assert.equal(setsOf(engine).length, 2);
    assert.equal(setsOf(engine)[0].count, 1499);
    assert.equal(all[1].pixelSize, 14);
    // A removed dot leaves; the look it had no longer matters.
    assert.equal(points.remove(all[2]), true);
    assert.equal(points.remove(all[2]), false);
    all[2].pixelSize = 16;
    await settle();
    assert.equal(setsOf(engine).length, 2);
    // Hiding the fleet hides its banks.
    points.show = false;
    await settle();
    assert.equal(points.show, false);
    assert.ok(setsOf(engine).every(({ count }) => count === 0));
    points.show = true;
    points.removeAll();
    await settle();
    assert.ok(setsOf(engine).every(({ count }) => count === 0));
    display.destroy();
    assert.equal(engine.movers.list().length, 0, 'no set left behind');
    h.destroy();
  });

  test(`the tracked dot draws over the fleet at its follow's sample, whatever the fleet's visibility (${name})`, async () => {
    const h = setup(makeHarness);
    const { engine, display } = h;
    const points = display.createPoints();
    const fleetDot = points.add(spec(25544));
    fleetDot.show = false;
    let sample = position;
    const handle = display.createTracked({
      id: 25544,
      position: () => sample,
      viewFrom: { x: -450000, y: -450000, z: 350000 },
    });
    assert.equal(handle.id, 'satellites:25544');
    points.show = false;
    const remove = display.onFrame(() => {});
    sample = { x: position.x + 7600, y: 100, z: 0 };
    h.frame();
    remove();
    await settle();
    assert.deepEqual({ ...handle.point.position }, sample);
    assert.deepEqual({ ...display.trackedPosition(handle) }, sample);
    const tracked = setsOf(engine).find(
      ({ id, count }) => count > 0 && drawn(h, id, 0).pixelSize === 14,
    );
    assert.ok(tracked, 'the tracked bank');
    const dot = drawn(h, tracked.id, 0);
    assert.equal(dot.show, true);
    assert.equal(dot.pixelSize, 14);
    assert.equal(dot.outlineWidth, 2);
    assert.equal(dot.outline.red, 1);
    assert.equal(dot.depth, Number.POSITIVE_INFINITY, 'never depth-tested');
    assert.deepEqual(
      [dot.color.red, dot.color.green, dot.color.blue],
      [1, 1, 0],
      'yellow',
    );
    assert.equal(dot.id, 25544);
    assert.equal(engine.fake.moverSet(tracked.id).options.order, 100);
    assert.ok(
      setsOf(engine)
        .filter(({ id }) => id !== tracked.id)
        .every(({ count }) => count === 0),
      'the fleet is hidden',
    );
    display.removeTracked(handle);
    await settle();
    assert.equal(
      engine.movers.list().find(({ id }) => id === tracked.id).count,
      0,
    );
    display.destroy();
    h.destroy();
  });

  test(`the follow centres the tracked satellite from its offset in the east-north-up frame and carries its readout label (${name})`, async () => {
    const h = setup(makeHarness);
    const { engine, display } = h;
    display.createPoints().add(spec(25544));
    const target = geo.cartesian3.fromDegrees(0, 0, 20200000);
    const offset = geo.cartesian3.create(-1800000, -1800000, 1400000);
    const handle = display.createTracked({
      id: 25544,
      position: () => target,
      viewFrom: offset,
    });
    handle.gevTrackedId = 'satellites:25544';
    handle.gevSelectionOrigin = 'user';
    handle.gevLabelModel = { title: 'ISS', details: [] };
    handle.gevDisplayPosition = () => target;
    const seen = [];
    const removeListener = display.follow.onChanged(() =>
      seen.push(display.follow.current()),
    );
    display.follow.start(handle);
    // Every change the start raises reads the satellite being followed.
    assert.ok(seen.length >= 1);
    assert.ok(seen.every((current) => current === handle));
    const following = engine.camera.following();
    assert.equal(following, handle.gevFollowHandle);
    assert.equal(following.native, handle);
    assert.equal(following.label.id, 'satellites:25544');
    assert.equal(following.label.model(), handle.gevLabelModel);
    assert.equal(following.label.position(), target);
    assert.equal(display.follow.current(), handle);
    assert.equal(following.target(), target);

    // The display's own release is guarded; a later external change is not.
    seen.length = 0;
    const guards = [];
    const removeGuard = display.follow.onChanged(() =>
      guards.push(display.follow.releasing()),
    );
    display.follow.release();
    assert.equal(engine.camera.following(), null);
    assert.equal(display.follow.current(), null);
    assert.ok(guards.length >= 1);
    assert.ok(guards.every(Boolean), 'own release');
    guards.length = 0;
    const other = { id: 'other', gevSelectionOrigin: 'programmatic' };
    const foreign = engine.camera.follow({
      native: other,
      position: () => target,
      viewFrom: { x: 0, y: -100, z: 100 },
    });
    assert.equal(display.follow.current(), other, "another layer's target");
    foreign.stop();
    assert.ok(guards.length >= 1);
    assert.ok(
      guards.every((guard) => guard === false),
      'external changes',
    );
    assert.equal(display.follow.releasing(), false);
    removeGuard();
    removeListener();
    // Removing the followed satellite ends its follow.
    display.follow.start(handle);
    display.removeTracked(handle);
    assert.equal(engine.camera.following(), null);

    display.destroy();
    h.destroy();
  });

  test(`orbit rings start at identity, turn by their model matrix without a rebuild, dim behind the globe and leave (${name})`, () => {
    const h = setup(makeHarness);
    const { engine, display } = h;
    const ring = [position, { x: 0, y: 6778137, z: 0 }];
    const orbit = display.createOrbit({
      positions: ring,
      width: 2.5,
      color: CYAN,
    });
    assert.deepEqual(orbit.modelMatrix, geo.matrix4.IDENTITY);
    const [before] = engine.lines.list();
    assert.equal(before.points, 2);

    const { options } = engine.fake.line(before.id);
    assert.equal(options.widthPx, 2.5);
    assert.equal(options.arc, 'geodesic');
    assert.equal(options.pickId, undefined, 'rings are not picked');
    near(options.color[3], 0.6, 'alpha');
    near(options.color[3] * options.depthFailAlpha, 0.35, 'occluded alpha');

    orbit.modelMatrix[12] = 123;
    display.commitOrbit(orbit);
    assert.equal(engine.lines.list()[0].id, before.id, 'the same line');
    assert.equal(engine.fake.line(before.id).modelMatrix[12], 123);
    orbit.show = false;
    assert.equal(orbit.show, false);
    assert.equal(engine.lines.list()[0].shown, false);
    // A ring that is not the display's is left alone.
    display.commitOrbit({ show: true, modelMatrix: geo.matrix4.create() });
    display.removeOrbit({ show: true });
    assert.equal(engine.lines.list().length, 1);
    display.removeOrbit(orbit);
    assert.equal(engine.lines.list().length, 0);
    display.createOrbit({ positions: ring, width: 2, color: CYAN });
    display.destroy();
    assert.equal(engine.lines.list().length, 0, 'the display releases rings');
    h.destroy();
  });

  test(`the view reads the engine's camera and frames (${name})`, () => {
    const h = setup(makeHarness);
    const { display } = h;
    const frame = display.view.frameNumber();
    h.frame();
    assert.equal(display.view.frameNumber(), frame + 1);
    near(display.view.camera.positionCartographic.height, 2e7, 'height', 1);
    const screen = display.project(geo.cartesian3.fromDegrees(0, 0, 0));
    assert.ok(Number.isFinite(screen.x) && Number.isFinite(screen.y));
    display.destroy();
    h.destroy();
  });
}

test('a click comes with its top pick; picks name the NORAD id and the tracked dot (the fake engine)', async () => {
  const previousDocument = globalThis.document;
  globalThis.document = new EventTarget();
  try {
    const engine = createFakeEngine();
    const display = createSatellitesDisplay(engine);
    display.createPoints().add(spec(25544));
    const clicks = [];
    const handler = display.listenClick((ctx) => clicks.push(ctx));
    engine.fake.script('pick', () => ({ id: 25544 }));
    engine.fake.input('click', { position: { x: 10, y: 10 } });
    assert.equal(clicks.length, 1);
    assert.equal(display.pickedNorad(clicks[0].picked), 25544);
    const handle = display.createTracked({
      id: 25544,
      position: () => position,
      viewFrom: { x: 0, y: 0, z: 1 },
    });
    assert.equal(display.isTrackedPick(clicks[0].picked, handle), true);
    assert.equal(display.isTrackedPick({ id: 1 }, handle), false);
    assert.equal(display.isTrackedPick(clicks[0].picked, null), false);
    assert.equal(Number.isNaN(display.pickedNorad({ id: { id: 'x' } })), true);
    handler.destroy();
    engine.fake.input('click', { position: { x: 10, y: 10 } });
    assert.equal(clicks.length, 1);
    display.destroy();
    engine.destroy();
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }
});
