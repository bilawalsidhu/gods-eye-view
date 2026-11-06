// The Space Missions display on the engine contract, on the fake engine and
// on the Cesium engine (real Cesium collections and polylines over a stub
// scene: they draw nothing but hold what the engine writes): the dots and the
// reticle as Cesium's entity points and billboards drew them, their per-frame
// positions, the mission paths' dashes, the tactical orbits and their model
// matrix, the pad zone's rim, the layer's switch, clicks, the hover cursor
// and teardown.

import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import * as geo from '../../../geo/index.js';
import { createFakeEngine } from '../../../globe/testing/fakeEngine.js';
import { createCesiumMoversEngine } from '../../../testSupport/cesiumMoversEngine.mjs';
import { dashPattern } from '../../../globe/cesium/lines.js';
import { rgbaFromCss } from '../../shared/color.js';
import { LAUNCH_PAD_ZONE_RADIUS_M, LAUNCH_PAD_ZONE_STYLE } from '../policy.js';
import {
  PAD_RIM_RADIUS_M,
  createLaunchesDisplay,
  padRimColor,
} from './display.js';

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const reticle = { width: 48, height: 48, getContext: () => null };

function fakeHarness() {
  const engine = createFakeEngine({ canvas: { style: { cursor: '' } } });
  return {
    name: 'the fake engine',
    engine,
    frame: () => engine.fake.frame(),
    destroy: () => engine.destroy(),
  };
}

function cesiumHarness() {
  const { engine, viewer, ...rest } = createCesiumMoversEngine();
  viewer.scene.globe.getHeight = () => 7;
  return {
    name: 'the Cesium engine',
    cesium: true,
    engine,
    viewer,
    ...rest,
    destroy: () => engine.destroy(),
  };
}

const HARNESSES = [fakeHarness, cesiumHarness];

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

test('the display needs a globe engine', () => {
  assert.throws(() => createLaunchesDisplay(null), TypeError);
});

test("the pad zone's rim is the middle of the style's rim band in the rim's colour", () => {
  near(
    PAD_RIM_RADIUS_M,
    LAUNCH_PAD_ZONE_RADIUS_M *
      ((LAUNCH_PAD_ZONE_STYLE.rimStart + LAUNCH_PAD_ZONE_STYLE.rimEnd) / 2),
    'radius',
  );
  const [red, green, blue] = rgbaFromCss(LAUNCH_PAD_ZONE_STYLE.color).rgba();
  const gain = 1 + LAUNCH_PAD_ZONE_STYLE.emission;
  assert.deepEqual(padRimColor(), [
    Math.min(1, red * gain),
    Math.min(1, green * gain),
    Math.min(1, blue * gain),
    LAUNCH_PAD_ZONE_STYLE.rimAlpha,
  ]);
});

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
    if (h.cesium) {
      const point = h.primitive(five.id).get(0);
      assert.equal(point.pixelSize, 5);
      assert.equal(point.outlineWidth, 0);
      assert.equal(point.disableDepthTestDistance, Number.POSITIVE_INFINITY);
      assert.equal(point.id, 'rocket-launch:a');
      assert.equal(point.show, true);
      assert.ok(Cesium.Cartesian3.equals(point.position, PAD));
      near(point.color.green, color.green, 'green');
      assert.equal(h.primitive(four.id).get(0).pixelSize, 4);
    } else {
      const set = engine.fake.moverSet(five.id);
      assert.equal(set.options.point.sizePx, 5);
      assert.equal(set.options.point.outlinePx, 0);
      assert.equal(set.options.depthTest, 'always');
      assert.equal(set.options.pickable, true);
      assert.equal(set.store.pickIds[0], 'rocket-launch:a');
      near(set.store.colors[1], color.green, 'green');
    }
    pad.show = false;
    await settle();
    if (h.cesium) assert.equal(h.primitive(five.id).get(0).show, false);
    else assert.equal(engine.fake.moverSet(five.id).store.shows[0], 0);
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
    if (h.cesium) {
      const billboard = h.primitive(listed.id).get(0);
      assert.equal(billboard.width, 24);
      assert.equal(billboard.height, 24);
      assert.equal(
        billboard.disableDepthTestDistance,
        Number.POSITIVE_INFINITY,
      );
      assert.equal(billboard.id, 'rocket-launch:a');
      assert.equal(billboard.show, false);
    } else {
      const set = engine.fake.moverSet(listed.id);
      assert.equal(set.options.sprite.sizePx, 24);
      assert.equal(set.options.sprite.atlas.canvas, reticle);
      assert.equal(set.options.depthTest, 'always');
      assert.equal(set.store.shows[0], 0);
    }
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
      if (h.cesium) return h.primitive(listed.id).get(0).position;
      const { positions } = engine.fake.moverSet(listed.id).store;
      return geo.cartesian3.create(positions[0], positions[1], positions[2]);
    };
    assert.ok(geo.cartesian3.equalsEpsilon(drawn(), at, 0, 1e-6));
    display.setVisible(false);
    if (!h.cesium) engine.fake.resetCalls();
    at = geo.cartesian3.fromDegrees(2, 0, 400_000);
    h.frame();
    h.frame();
    assert.equal(reads, 2, 'hidden motion is not read');
    if (!h.cesium)
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
    if (h.cesium) {
      const primitive = h.primitive(listed.id);
      const { geometry, id } = primitive.geometryInstances;
      assert.equal(geometry._width, 1.5);
      assert.equal(geometry._arcType, Cesium.ArcType.NONE);
      assert.equal(id, 'rocket-transfer:a');
      const { material } = primitive.appearance;
      assert.equal(material.type, 'PolylineDash');
      // Cesium's dashLength 24 px with 0xf0f0: 6 px on, 6 px off.
      assert.equal(material.uniforms.dashLength, 12);
      assert.equal(material.uniforms.dashPattern, dashPattern(6, 6));
      assert.equal(material.uniforms.dashPattern, 0xff00);
      near(material.uniforms.color.alpha, 0.8, 'alpha');
      assert.equal(primitive.depthFailAppearance, undefined);
    } else {
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
    }
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
    if (h.cesium) {
      const primitive = h.primitive(listed.id);
      const { material } = primitive.appearance;
      assert.equal(material.type, 'GevLineTactical');
      assert.equal(material.uniforms.groupCount, 4);
      assert.equal(material.uniforms.dashCount, 100);
      near(material.uniforms.color.alpha, 0.95, 'alpha');
      assert.equal(primitive.geometryInstances.geometry._width, 3);
      assert.equal(primitive.modelMatrix[12], 42);
      // The live ring is not picked (Cesium's polyline collection).
      assert.equal(primitive.allowPicking, false);
    } else {
      const line = engine.fake.line(listed.id);
      assert.deepEqual(line.options.dash, {
        kind: 'tactical',
        groups: 4,
        dashes: 100,
      });
      assert.equal(line.modelMatrix[12], 42);
      assert.equal(line.options.pickId, undefined);
    }
    display.destroy();
    assert.deepEqual(engine.lines.list(), []);
    h.destroy();
  });

  test(`the pad zone is its rim on the terrain, drawn over the scene, not picked (${name})`, () => {
    const h = setup(makeHarness);
    const { engine, display } = h;
    if (!h.cesium) engine.fake.script('terrainHeight', 7);
    display.setVisible(true);
    const zone = display.createPad({ id: 'a', lon: -80.6, lat: 28.6 });
    assert.equal(zone.heightM, 7);
    assert.equal(
      engine.fake?.callsOf('surface.sampleHeight').length ?? 0,
      0,
      'no tile height is sampled',
    );
    const [listed] = engine.lines.list();
    assert.equal(listed.points, 129, 'a closed ring');
    const center = geo.cartesian3.fromDegrees(-80.6, 28.6, 7);
    const ringPoint = (flat, index) =>
      geo.cartesian3.create(
        flat[index * 3],
        flat[index * 3 + 1],
        flat[index * 3 + 2],
      );
    if (h.cesium) {
      const primitive = h.primitive(listed.id);
      assert.equal(primitive.allowPicking, false);
      const positions = primitive.geometryInstances.geometry._positions;
      near(
        Cesium.Cartesian3.distance(positions[0], center),
        PAD_RIM_RADIUS_M,
        'rim radius',
        1e-3,
      );
      const { color } = primitive.appearance.material.uniforms;
      near(color.alpha, LAUNCH_PAD_ZONE_STYLE.rimAlpha, 'rim alpha');
      near(
        primitive.depthFailAppearance.material.uniforms.color.alpha,
        LAUNCH_PAD_ZONE_STYLE.rimAlpha,
        'drawn where the scene hides it',
      );
    } else {
      const line = engine.fake.line(listed.id);
      assert.equal(line.options.pickId, undefined);
      assert.equal(line.options.depthFailAlpha, 1);
      assert.deepEqual(line.options.color, padRimColor());
      near(
        geo.cartesian3.distance(ringPoint(line.positions, 0), center),
        PAD_RIM_RADIUS_M,
        'rim radius',
        1e-3,
      );
      near(
        geo.cartesian3.distance(ringPoint(line.positions, 64), center),
        PAD_RIM_RADIUS_M,
        'rim radius',
        1e-3,
      );
    }
    zone.show = false;
    assert.equal(engine.lines.list()[0].shown, false);
    zone.show = true;
    assert.equal(engine.lines.list()[0].shown, true);
    zone.destroy();
    zone.destroy();
    assert.deepEqual(engine.lines.list(), []);
    display.destroy();
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
  display.addPoint({ id: 'rocket-launch:a', position: PAD, sizePx: 5 });
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
