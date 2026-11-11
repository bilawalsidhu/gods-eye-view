import { createFakeGroundHarness as fakeHarness } from '../../../testSupport/groundDisplayEngines.mjs';
// The Space Missions display on the engine contract, on the fake engine and
// on the Cesium engine (real Cesium collections and polylines over a stub
// scene: they draw nothing but hold what the engine writes): the dots and the
// reticle as Cesium's entity points and billboards drew them, their per-frame
// positions, the mission paths' dashes, the tactical orbits and their model
// matrix, the pad zone's rim, the layer's switch, clicks, the hover cursor
// and teardown.

import test from 'node:test';
import assert from 'node:assert/strict';

import * as geo from '../../../geo/index.js';
import { createFakeEngine } from '../../../globe/testing/fakeEngine.js';

import { rgbaFromCss } from '../../shared/color.js';
import { LAUNCH_PAD_ZONE_RADIUS_M, LAUNCH_PAD_ZONE_STYLE } from '../policy.js';
import { createLaunchesDisplay } from './display.js';
import { GROUND_HARNESSES } from '../../../testSupport/groundDisplayEngines.mjs';

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const reticle = { width: 48, height: 48, getContext: () => null };

const HARNESSES = [fakeHarness];

function setup(makeHarness) {
  const harness = makeHarness();
  harness.engine.camera.setView({
    destination: geo.cartesian3.fromDegrees(-80.6, 28.6, 2_000_000),
  });
  const display = createLaunchesDisplay(harness.engine);
  return { ...harness, display };
}

const near = (actual, expected, label, tolerance = 1e-6) =>
  assert.ok(
    Math.abs(actual - expected) < tolerance,
    `${label}: ${actual} vs ${expected}`,
  );
const PAD = geo.cartesian3.fromDegrees(-80.6, 28.6);
const ORBIT = [
  geo.cartesian3.fromDegrees(-80.6, 28.6, 400_000),
  geo.cartesian3.fromDegrees(-70, 30, 400_000),
  geo.cartesian3.fromDegrees(-60, 31, 400_000),
];

for (const makeHarness of HARNESSES) {
  const { name } = makeHarness();

  test(`mission dots draw as Cesium's entity points: size, colour, over the scene, picked by id (${name})`, async () => {
    const h = setup(makeHarness);
    const { engine, display } = h;
    const color = rgbaFromCss('#4cc9f0');
    const pad = display.addPoint({
      id: 'rocket-launch:a',
      position: PAD,
      sizePx: 5,
      color,
    });
    display.addPoint({
      id: 'rocket-recovery-end:a:0',
      position: geo.cartesian3.fromDegrees(-76.2, 30.1),
      sizePx: 4,
      color: rgbaFromCss('#ff66c4'),
    });
    await settle();
    // Off until the layer shows it.
    assert.deepEqual(
      engine.movers.list().map(({ count }) => count),
      [0, 0],
    );
    display.setVisible(true);
    const [five, four] = engine.movers.list();
    assert.equal(five.kind, 'point');
    assert.equal(five.count, 1);
    assert.equal(four.count, 1);

    const set = engine.fake.moverSet(five.id);
    assert.equal(set.options.point.sizePx, 5);
    assert.equal(set.options.point.outlinePx, 0);
    assert.equal(set.options.depthTest, 'always');
    assert.equal(set.options.pickable, true);
    assert.equal(set.store.pickIds[0], 'rocket-launch:a');
    near(set.store.colors[1], color.green, 'green');

    pad.show = false;
    await settle();
    assert.equal(engine.fake.moverSet(five.id).store.shows[0], 0);
    display.setVisible(false);
    assert.deepEqual(
      engine.movers.list().map(({ count }) => count),
      [0, 0],
    );
    display.destroy();
    assert.deepEqual(engine.movers.list(), []);
    h.destroy();
  });

  test(`the hover reticle is a 24 px sprite of the reticle canvas over the scene (${name})`, async () => {
    const h = setup(makeHarness);
    const { engine, display } = h;
    display.setVisible(true);
    const sprite = display.addReticle({
      id: 'rocket-launch:a',
      position: PAD,
      image: reticle,
    });
    sprite.show = false;
    await settle();
    const [listed] = engine.movers.list();
    assert.equal(listed.kind, 'sprite');

    const set = engine.fake.moverSet(listed.id);
    assert.equal(set.options.sprite.sizePx, 24);
    assert.equal(set.options.sprite.atlas.canvas, reticle);
    assert.equal(set.options.depthTest, 'always');
    assert.equal(set.store.shows[0], 0);

    display.destroy();
    h.destroy();
  });

  test(`a moving dot reads its position each frame while it draws, never while hidden (${name})`, async () => {
    const h = setup(makeHarness);
    const { engine, display } = h;
    let at = geo.cartesian3.fromDegrees(0, 0, 400_000);
    let reads = 0;
    display.addPoint({
      id: 'rocket-satellite:a',
      position: () => {
        reads++;
        return at;
      },
      sizePx: 6,
      color: rgbaFromCss('#ffd166'),
    });
    await settle();
    h.frame();
    assert.equal(reads, 0, 'not read while the layer is off');
    display.setVisible(true);
    assert.equal(reads, 1, 'read when it starts to draw');
    at = geo.cartesian3.fromDegrees(1, 0, 400_000);
    h.frame();
    assert.equal(reads, 2);
    const [listed] = engine.movers.list();
    const drawn = () => {
      const { positions } = engine.fake.moverSet(listed.id).store;
      return geo.cartesian3.create(positions[0], positions[1], positions[2]);
    };
    assert.ok(geo.cartesian3.equalsEpsilon(drawn(), at, 0, 1e-6));
    display.setVisible(false);
    engine.fake.resetCalls();
    at = geo.cartesian3.fromDegrees(2, 0, 400_000);
    h.frame();
    h.frame();
    assert.equal(reads, 2, 'hidden motion is not read');
    assert.equal(
      engine.fake.renderRequests,
      0,
      'hidden motion must not sustain rendering',
    );
    display.destroy();
    h.destroy();
  });

  test(`mission paths keep Cesium's widths, colours, dashes and straight segments (${name})`, () => {
    const h = setup(makeHarness);
    const { engine, display } = h;
    display.setVisible(true);
    const color = rgbaFromCss('#7bed9f').withAlpha(0.8);
    const transfer = display.addLine({
      id: 'rocket-transfer:a',
      pickId: 'rocket-transfer:a',
      positions: ORBIT,
      widthPx: 1.5,
      color,
      dash: { lengthPx: 6, gapPx: 6 },
    });
    const [listed] = engine.lines.list();

    const { options } = engine.fake.line(listed.id);
    assert.equal(options.widthPx, 1.5);
    assert.equal(options.arc, 'none');
    assert.equal(options.pickId, 'rocket-transfer:a');
    assert.deepEqual(options.dash, {
      kind: 'pixels',
      lengthPx: 6,
      gapPx: 6,
    });
    assert.deepEqual(options.color, color.rgba());
    assert.equal(options.depthFailAlpha, 0);

    transfer.show = false;
    assert.equal(engine.lines.list()[0].shown, false);
    transfer.show = true;
    display.setVisible(false);
    assert.equal(engine.lines.list()[0].shown, false);
    display.setVisible(true);
    assert.equal(engine.lines.list()[0].shown, true);
    transfer.remove();
    assert.deepEqual(engine.lines.list(), []);
    display.destroy();
    h.destroy();
  });

  test(`orbits draw the tactical pattern; a live ring turns by its model matrix (${name})`, () => {
    const h = setup(makeHarness);
    const { engine, display } = h;
    display.setVisible(true);
    const modelMatrix = geo.matrix4.clone(geo.matrix4.IDENTITY);
    const ring = display.addLine({
      id: 'rocket-orbit-ring:a',
      positions: ORBIT,
      widthPx: 3,
      color: rgbaFromCss('#22e6e6').withAlpha(0.95),
      dash: 'tactical',
      modelMatrix,
    });
    const [listed] = engine.lines.list();
    modelMatrix[12] = 42;
    ring.setModelMatrix(modelMatrix);

    const line = engine.fake.line(listed.id);
    assert.deepEqual(line.options.dash, {
      kind: 'tactical',
      groups: 4,
      dashes: 100,
    });
    assert.equal(line.modelMatrix[12], 42);
    assert.equal(line.options.pickId, undefined);

    display.destroy();
    assert.deepEqual(engine.lines.list(), []);
    h.destroy();
  });

  test(`teardown releases every set, line and frame listener (${name})`, async () => {
    const h = setup(makeHarness);
    const { engine, display } = h;
    const before = engine.frames.preRender.numberOfListeners;
    display.setVisible(true);
    display.addPoint({ id: 'rocket-launch:a', position: PAD, sizePx: 5 });
    display.addReticle({
      id: 'rocket-launch:a',
      position: PAD,
      image: reticle,
    });
    display.addLine({ id: 'rocket-orbit:a', positions: ORBIT, widthPx: 3 });
    display.createPad({ id: 'a', lon: -80.6, lat: 28.6 });
    let frames = 0;
    display.on('preRender', () => frames++);
    h.frame();
    assert.equal(frames, 1);
    await settle();
    display.destroy();
    display.destroy();
    assert.deepEqual(engine.movers.list(), []);
    assert.deepEqual(engine.ground.list(), []);
    assert.deepEqual(engine.lines.list(), []);
    h.frame();
    assert.equal(frames, 1);
    assert.equal(display.visible(), false);
    assert.equal(engine.frames.preRender.numberOfListeners, before - 1);
    h.destroy();
  });
}

test('a click on a mission names its element; a click elsewhere or while off names none', () => {
  const engine = createFakeEngine();
  const display = createLaunchesDisplay(engine);
  display.setVisible(true);
  const point = display.addPoint({
    id: 'rocket-launch:a',
    position: PAD,
    sizePx: 5,
  });
  assert.equal(display.ownsPick('rocket-launch:a'), true);
  assert.equal(display.ownsPick('rocket-launch:missing'), false);
  assert.equal(display.ownsPick('other'), false);
  let enabled = true;
  const clicks = [];
  const handler = display.onClick((id) => clicks.push(id), {
    enabled: () => enabled,
  });
  engine.fake.script('pick', { id: 'rocket-launch:a' });
  engine.fake.script('drillPick', [{ id: 'other' }, { id: 'rocket-launch:a' }]);
  engine.fake.input('click', { position: { x: 1, y: 2 } });
  engine.fake.script('pick', { id: 'other' });
  engine.fake.script('drillPick', [{ id: 'rocket-launch:a' }]);
  engine.fake.input('click', { position: { x: 1, y: 2 } });
  engine.fake.script('pick', undefined);
  engine.fake.script('drillPick', []);
  engine.fake.input('click', { position: { x: 1, y: 2 } });
  enabled = false;
  engine.fake.script('pick', { id: 'rocket-launch:a' });
  engine.fake.input('click', { position: { x: 1, y: 2 } });
  assert.deepEqual(clicks, ['rocket-launch:a', 'rocket-launch:a', undefined]);
  handler.destroy();
  enabled = true;
  engine.fake.input('click', { position: { x: 1, y: 2 } });
  assert.equal(clicks.length, 3);
  point.remove();
  assert.equal(display.ownsPick('rocket-launch:a'), false);
  display.destroy();
  engine.destroy();
});

test("the hover cursor is the engine canvas's pointer over a mission", () => {
  const canvas = { style: { cursor: '' } };
  const engine = createFakeEngine({ canvas });
  const display = createLaunchesDisplay(engine);
  display.setVisible(true);
  display.addPoint({ id: 'rocket-launch:a', position: PAD, sizePx: 5 });
  const hover = display.onHover({ enabled: () => true });
  const previousDocument = globalThis.document;
  engine.fake.script('drillPick', [{ id: 'rocket-launch:a' }]);
  engine.fake.input('move', { endPosition: { x: 1, y: 2 } });
  assert.equal(canvas.style.cursor, 'pointer');
  assert.equal(engine.fake.callsOf('picker.drillPick')[0].args[1], 12);
  hover.reset();
  assert.equal(canvas.style.cursor, '');
  hover.destroy();
  engine.fake.input('move', { endPosition: { x: 1, y: 2 } });
  assert.equal(canvas.style.cursor, '');
  assert.equal(globalThis.document, previousDocument);
  display.destroy();
  engine.destroy();
});

for (const makeHarness of GROUND_HARNESSES) {
  test(`launch pads retain radial fills, draping and lifecycle (${makeHarness.name})`, () => {
    const h = makeHarness();
    const display = createLaunchesDisplay(h.engine);
    const pad = display.createPad({ id: 'a', lon: -80.6, lat: 28.6 });
    const id = 'rocket-pad-zone:a';
    const record = h.set(id);
    const { color, ...radial } = LAUNCH_PAD_ZONE_STYLE;
    assert.deepEqual(record.items, [
      {
        center: [-80.6, 28.6],
        radiusM: LAUNCH_PAD_ZONE_RADIUS_M,
        fill: rgbaFromCss(color).rgba(),
        radial,
      },
    ]);
    assert.equal(record.options.drape, 'both');
    assert.equal(record.options.pickable, false);
    assert.equal(record.shown, false);
    display.setVisible(true);
    assert.equal(h.set(id).shown, true);

    pad.show = false;
    display.setVisible(false);
    display.setVisible(true);
    assert.equal(h.set(id).shown, false);
    pad.show = true;
    assert.equal(h.set(id).shown, true);
    assert.equal(h.set(id).commits, 1);
    pad.destroy();
    pad.destroy();
    assert.equal(h.set(id), undefined);
    display.createPad({ id: 'b', lon: 1, lat: 2 });
    display.destroy();
    assert.equal(h.sets(), 0);
    h.destroy();
  });
}
