// The Directions display on the engine contract, on the fake engine and on
// the Cesium engine (real Cesium point and billboard collections and the
// engine's ground batches over fake primitives): the route's flowing
// dashes, width, colour and drape, and the render it holds; the maneuver dots' style, anchoring, selection
// and picks; the A and B markers at the surface with their letters; show and
// hide through the layer; and what teardown leaves.

import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import * as geo from '../../../geo/index.js';
import { GROUND_HARNESSES } from '../../../testSupport/groundDisplayEngines.mjs';
import { createApplicationDirectionsLayer } from '../../../data/directions.js';
import {
  DIRECTIONS_SET_IDS as IDS,
  createDirectionsDisplay,
  stepPickId,
} from './display.js';
import { DIRECTIONS_ROUTE_COLOR } from './style.js';
import { getRenderGovernorDiagnostics } from '../../../renderGovernor.js';
import { rgbaFromCss } from '../../shared/color.js';

const near = (actual, expected, label, tolerance = 1e-6) =>
  assert.ok(
    Math.abs(actual - expected) < tolerance,
    `${label}: ${actual} vs ${expected}`,
  );
const nearAll = (actual, expected, label, tolerance) =>
  expected.forEach((value, index) =>
    near(actual[index], value, `${label}[${index}]`, tolerance),
  );
const ROUTE = rgbaFromCss(DIRECTIONS_ROUTE_COLOR);
const ROUTE_RGB = [ROUTE.red, ROUTE.green, ROUTE.blue];
const A = { lat: 60.1699, lon: 24.9384 };
const B = { lat: 60.2055, lon: 24.6559 };
const MID = { lat: (A.lat + B.lat) / 2, lon: (A.lon + B.lon) / 2 };
const payload = {
  ok: true,
  distanceM: 21479,
  durationS: 1478,
  geometry: [
    [A.lon, A.lat],
    [MID.lon, MID.lat],
    [B.lon, B.lat],
  ],
  steps: [
    { instruction: 'Head out', distanceM: 8, durationS: 1, ...A },
    { instruction: 'Turn right', distanceM: 236, durationS: 39, ...MID },
    { instruction: 'Arrive', distanceM: 0, durationS: 0, ...B },
  ],
};
const settle = async () => {
  for (let i = 0; i < 5; i++)
    await new Promise((resolve) => setImmediate(resolve));
};

/** A document whose canvases draw nothing (for the letters' atlas). */
function installDocument(t) {
  const saved = globalThis.document;
  const context = new Proxy({}, { get: () => () => {}, set: () => true });
  globalThis.document = {
    createElement: () => ({ getContext: () => context }),
    addEventListener() {},
    removeEventListener() {},
  };
  t.after(() => {
    if (saved === undefined) delete globalThis.document;
    else globalThis.document = saved;
  });
}

// What the display gave each mover set: its options and every instance's
// fields, merged as set() merges them, up to setCount.
function recordMovers(engine) {
  const sets = new Map();
  const createSet = engine.movers.createSet.bind(engine.movers);
  engine.movers.createSet = (options) => {
    const set = createSet(options);
    const record = { options, rows: [], count: 0, live: true };
    sets.set(options.id, record);
    const { set: write, setCount, destroy } = set;
    set.set = (index, fields) => {
      write(index, fields);
      record.rows[index] = { ...record.rows[index], ...fields };
    };
    set.setCount = (count) => {
      setCount(count);
      record.count = count;
    };
    set.destroy = () => {
      destroy();
      record.live = false;
    };
    return set;
  };
  return (id) => {
    const record = sets.get(id);
    return record?.live ? record : undefined;
  };
}

// The Cesium point drawing instance `index` of mover set `id`.
function cesiumPoint(viewer, id, index) {
  const items = (collection) =>
    Array.from({ length: collection?.length ?? 0 }, (_, i) =>
      collection.get(i),
    );
  for (const root of items(viewer.scene.primitives))
    for (const child of items(root))
      if (child.gevMoverSet === id) return child.get(index);
  return undefined;
}

function fixture(t, makeHarness, { document = true } = {}) {
  if (document) installDocument(t);
  const h = makeHarness();
  if (h.viewer)
    h.viewer.creditDisplay ??= {
      addStaticCredit() {},
      removeStaticCredit() {},
    };
  const movers = recordMovers(h.engine);
  let floor = 0;
  const requests = [];
  const layer = createApplicationDirectionsLayer({
    source: {
      getRoute: () => new Promise((resolve) => requests.push(resolve)),
    },
    groundFloor: {
      GROUND_FLOOR_LIFT_M: 2,
      cachedGroundFloor: () => floor,
      warmGroundFloor() {},
    },
    createRenderer: createDirectionsDisplay,
  });
  const cards = [];
  layer._setOverlayHostForTest({
    setEntries: (id, entries) => cards.push(...entries),
    setVisible() {},
    clearSource() {},
  });
  layer.init(null, { engine: h.engine });
  layer.enable();
  t.after(() => {
    layer.destroy();
    h.destroy();
  });
  return {
    ...h,
    layer,
    movers,
    cards,
    setFloor(value) {
      floor = value;
    },
    async route() {
      layer.placeEndpoint('a', A);
      layer.placeEndpoint('b', B);
      requests.at(-1)(payload);
      await settle();
    },
  };
}

test('the display needs a globe engine', () => {
  assert.throws(() => createDirectionsDisplay(null), TypeError);
});

for (const makeHarness of GROUND_HARNESSES) {
  const { name } = makeHarness();

  test(`the route is one 9 px corridor draped on terrain and tiles whose dashes flow toward B, holding the render (${name})`, async (t) => {
    const f = fixture(t, makeHarness);
    await f.route();
    const set = f.set(IDS.route);
    assert.equal(set.options.kind, 'corridor');
    assert.equal(set.options.drape, 'both');
    assert.equal(set.options.pickable, false);
    assert.equal(set.shown, true);
    assert.equal(set.items.length, 1);
    const [item] = set.items;
    assert.equal(item.widthPx, 9);
    assert.deepEqual(item.positions, payload.geometry);
    nearAll(item.color, [...ROUTE_RGB, 0.95], 'colour');
    // The route flow material: 64 cells lit for 46 %, 18 % between, 0.9
    // emission, 0.55 cells a second toward the destination.
    assert.deepEqual(
      { ...item.dash },
      { cells: 64, duty: 0.46, speed: 0.55, gapAlpha: 0.18, emission: 0.9 },
    );
    assert.equal(
      f.engine.ground.list().find(({ id }) => id === IDS.route).animated,
      true,
    );
    assert.ok(
      getRenderGovernorDiagnostics().holds.includes('directions'),
      'a drawn route holds continuous render',
    );
    if (f.cesium) {
      const { fills, lines } = f.primitives(IDS.route);
      assert.equal(fills.length, 0);
      assert.equal(lines.length, 1, 'one ground polyline batch');
      assert.equal(
        lines[0].options.classificationType,
        Cesium.ClassificationType.BOTH,
      );
      const { uniforms } = lines[0].options.appearance.material;
      assert.equal(uniforms.dashCells, 64);
      near(uniforms.dashDuty, 0.46, 'duty');
      near(uniforms.dashSpeed, 0.55, 'speed');
      near(uniforms.dashGap, 0.18, 'gap');
      near(uniforms.dashEmission, 0.9, 'emission');
      near(uniforms.color.alpha, 0.95, 'alpha');
    }
    f.layer.setParams({ clear: true });
    assert.equal(f.set(IDS.route), undefined);
    assert.ok(
      !getRenderGovernorDiagnostics().holds.includes('directions'),
      'a cleared route releases it',
    );
  });

  test(`maneuver dots are 8 px white over the scene with a 2 px route outline, hidden until anchored (${name})`, async (t) => {
    const f = fixture(t, makeHarness);
    f.setFloor(null);
    await f.route();
    const steps = f.movers(IDS.steps);
    assert.equal(steps.options.kind, 'point');
    assert.equal(steps.options.depthTest, 'always');
    assert.equal(steps.options.pickable, true);
    assert.equal(steps.options.order, 0);
    assert.equal(steps.options.point.sizePx, 8);
    assert.equal(steps.options.point.outlinePx, 2);
    nearAll(steps.options.point.outlineColor, [...ROUTE_RGB, 1], 'outline');
    // Departure and arrival have no dot; the turn's cell is still cold.
    assert.equal(steps.count, 1);
    assert.equal(steps.rows[0].show, false);
    assert.equal(steps.rows[0].pickId, stepPickId(1));
    // Once the ground floor answers, the dot stands on it.
    f.setFloor(30);
    await new Promise((resolve) => setTimeout(resolve, 450));
    const anchored = f.movers(IDS.steps).rows[0];
    assert.equal(anchored.show, true);
    nearAll(anchored.color, [1, 1, 1, 0.95], 'dot colour');
    const at = geo.cartographic.fromCartesian(anchored.position);
    near(at.height, 32, 'floor + lift', 1e-3);
    near(geo.math.toDegrees(at.longitude), MID.lon, 'dot lon');
    if (f.cesium) {
      const point = cesiumPoint(f.viewer, IDS.steps, 0);
      assert.equal(point.pixelSize, 8);
      assert.equal(point.outlineWidth, 2);
      assert.equal(point.disableDepthTestDistance, Number.POSITIVE_INFINITY);
      assert.equal(point.show, true);
    }
  });

  test(`a click on a dot selects it at 13 px and opens its card; a click elsewhere clears it (${name})`, async (t) => {
    const f = fixture(t, makeHarness);
    await f.route();
    f.click({ id: stepPickId(1) });
    await settle();
    assert.equal(f.layer.getRowControls().list.items[1].active, true);
    near(f.movers(IDS.steps).rows[0].scale, 13 / 8, 'selected scale');
    assert.equal(f.cards.at(-1).id, 'directions-step-1');
    if (f.cesium)
      assert.equal(cesiumPoint(f.viewer, IDS.steps, 0).pixelSize, 13);
    f.click(undefined);
    await settle();
    assert.equal(f.layer.getRowControls().list.items[1].active, false);
    assert.equal(f.movers(IDS.steps).rows[0].scale, 1);
  });

  test(`A and B are 14 px discs with a black outline and their letters, at the surface (${name})`, async (t) => {
    const f = fixture(t, makeHarness);
    if (!f.cesium) f.engine.fake.script('sampleHeight', () => 120);
    f.layer.placeEndpoint('a', A);
    const markers = f.movers(IDS.markers);
    assert.equal(markers.options.kind, 'point');
    assert.equal(markers.options.depthTest, 'always');
    assert.equal(markers.options.order, 1);
    assert.equal(markers.options.point.sizePx, 14);
    assert.equal(markers.options.point.outlinePx, 2);
    assert.deepEqual(markers.options.point.outlineColor, [0, 0, 0, 1]);
    const a = rgbaFromCss('#5dff9f');
    nearAll(markers.rows[0].color, [a.red, a.green, a.blue, 1], 'A colour');
    assert.equal(markers.rows[0].show, true);
    assert.equal(markers.rows[1].show, false, 'B is not placed yet');
    if (!f.cesium)
      near(
        geo.cartographic.fromCartesian(markers.rows[0].position).height,
        120,
        'A on the sampled surface',
        1e-3,
      );
    const letters = f.movers(IDS.letters);
    assert.equal(letters.options.kind, 'sprite');
    assert.equal(letters.options.order, 2);
    assert.equal(letters.options.depthTest, 'always');
    assert.equal(letters.rows[0].cell, 'a');
    assert.equal(letters.rows[0].show, true);
    assert.deepEqual(letters.rows[0].position, markers.rows[0].position);
    f.layer.placeEndpoint('b', B);
    const b = rgbaFromCss('#ff6b6b');
    nearAll(
      f.movers(IDS.markers).rows[1].color,
      [b.red, b.green, b.blue, 1],
      'B colour',
    );
    assert.equal(f.movers(IDS.letters).rows[1].cell, 'b');
    // CLEAR takes both away.
    f.layer.setParams({ clear: true });
    assert.equal(f.movers(IDS.markers).rows[0].show, false);
    assert.equal(f.movers(IDS.markers).rows[1].show, false);
  });

  test(`disabling hides and clears everything; destroying leaves no sets and no listeners (${name})`, async (t) => {
    const f = fixture(t, makeHarness);
    await f.route();
    assert.equal(f.listeners(), 1, 'one click listener');
    f.layer.disable();
    assert.equal(f.set(IDS.route), undefined, 'the route is gone');
    assert.equal(f.movers(IDS.steps).count, 0);
    assert.equal(f.listeners(), 0);
    f.layer.enable();
    assert.equal(f.listeners(), 1);
    f.layer.detachRenderer();
    assert.equal(f.engine.movers.list().length, 0);
    assert.equal(f.sets(), 0);
    assert.equal(f.listeners(), 0);
  });

  test(`without a document the markers draw without letters (${name})`, (t) => {
    const saved = globalThis.document;
    delete globalThis.document;
    t.after(() => {
      if (saved !== undefined) globalThis.document = saved;
    });
    const f = fixture(t, makeHarness, { document: false });
    f.layer.placeEndpoint('a', A);
    assert.equal(f.movers(IDS.letters), undefined);
    assert.equal(f.movers(IDS.markers).rows[0].show, true);
  });
}

test('an engine switch redraws the route, dots and markers on the new engine only', async (t) => {
  const [makeFake, makeCesium] = GROUND_HARNESSES;
  const f = fixture(t, makeFake);
  await f.route();
  const next = makeCesium();
  next.viewer.creditDisplay ??= {
    addStaticCredit() {},
    removeStaticCredit() {},
  };
  const movers = recordMovers(next.engine);
  t.after(() => next.destroy());
  f.layer.suspendCamera();
  f.layer.detachRenderer();
  f.layer.attachRenderer(null, { engine: next.engine });
  f.layer.resumeCamera();
  assert.equal(f.engine.movers.list().length, 0);
  assert.equal(f.sets(), 0);
  assert.equal(next.set(IDS.route).items.length, 1);
  assert.equal(movers(IDS.steps).count, 1);
  assert.equal(movers(IDS.markers).rows[0].show, true);
  assert.equal(movers(IDS.markers).rows[1].show, true);
  f.layer.detachRenderer();
});
