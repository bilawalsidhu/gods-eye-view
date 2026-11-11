// Layer display behavior on the fake engine.

import test from 'node:test';
import assert from 'node:assert/strict';

import * as geo from '../../../geo/index.js';
import { viewshedColors } from '../../../data/cctvViewshed.js';
import { createFakeEngine } from '../../../globe/testing/fakeEngine.js';
import { CCTV_HARNESSES } from '../../../testSupport/cctvEngines.mjs';
import {
  ACTIVE_CAMERA_COLOR,
  IDLE_CAMERA_COLOR,
  IDLE_COVERAGE_CENTER_MUTED,
  IDLE_COVERAGE_COLOR,
  IDLE_COVERAGE_EDGE_MUTED,
  PLANE_OUTLINE_COLOR,
} from '../policy.js';
import { createCctvDisplay, planeOutline } from './display.js';

const p = (x, y, z) => geo.cartesian3.fromElements(x, y, z);
const POSITIONS = {
  mount: p(6378137, 0, 10),
  tl: p(6378137, 100, 40),
  tr: p(6378137, 140, 40),
  br: p(6378137, 140, 0),
  bl: p(6378137, 100, 0),
  capCenter: p(6378137, 120, 20),
};
const SHAPE = { halfW: 20, halfH: 11.25 };
const near = (actual, expected, label, tolerance = 1e-6) =>
  assert.ok(
    Math.abs(actual - expected) < tolerance,
    `${label}: ${actual} vs ${expected}`,
  );
const sameRgba = (actual, color, label) =>
  color
    .rgba()
    .forEach((value, index) =>
      near(actual[index], value, `${label}[${index}]`),
    );

function setup(makeHarness, t, services = {}) {
  const harness = makeHarness();
  const state = { _recordById: new Map(), _projectionEntities: [] };
  const display = createCctvDisplay(harness.engine, { state, services });
  display.attach();
  t.after(() => {
    display.destroy();
    harness.destroy();
  });
  return { ...harness, display, state };
}

const recordFor = (state, id, extra = {}) => {
  const record = { camera: { id }, coverageEntities: [], ...extra };
  state._recordById.set(id, record);
  return record;
};

for (const makeHarness of CCTV_HARNESSES) {
  const { name } = makeHarness();

  test(`markers are one always-on-top sprite set written once a frame (${name})`, async (t) => {
    const h = setup(makeHarness, t);
    h.display.createMarkers();
    assert.throws(() => h.display.createMarkers(), /already exist/);
    const position = p(6378137, 10, 20);
    const marker = h.display.createMarker({ id: 'a' }, position);
    const other = h.display.createMarker({ id: 'b' }, POSITIONS.mount);
    assert.equal(marker.width, 24);
    assert.equal(marker.color, IDLE_CAMERA_COLOR);
    position.y = 99;
    assert.equal(marker.position.y, 10, 'the marker keeps its own copy');
    const [listed] = h.engine.movers.list();
    assert.deepEqual(
      { id: listed.id, kind: listed.kind, count: listed.count },
      { id: 'cctv', kind: 'sprite', count: 0 },
      'nothing is written before the frame',
    );
    h.frame();
    assert.equal(h.engine.movers.list()[0].count, 2);
    marker.color = ACTIVE_CAMERA_COLOR;
    marker.scale = 1.25;
    h.display.setMarkersVisible(false);
    h.display.restoreOrder();
    await h.settle();
    {
      const set = h.engine.fake.moverSet('cctv');
      assert.equal(set.options.order, 1, 'the sprite slot above shipwrecks');
      assert.equal(set.options.depthTest, 'always');
      assert.equal(set.options.pickable, true);
      assert.equal(set.options.sprite.sizePx, 24);
      assert.deepEqual(
        [...set.options.sprite.scaleByDistance],
        [350, 1.25, 4_000_000, 0.42],
      );
      assert.equal(set.store.scales[0], 1.25);
      assert.equal(set.store.shows[0], 0);
      assert.equal(set.store.pickIds[1], 'b');
      const commits = set.commits;
      marker.color = marker.color.withAlpha(marker.color.alpha);
      marker.position = { ...marker.position };
      other.show = true;
      h.frame();
      assert.equal(
        h.engine.fake.moverSet('cctv').commits,
        commits,
        'unchanged writes commit nothing',
      );
    }
  });

  test(`coverage is five lines that roll back a partial build (${name})`, (t) => {
    const h = setup(makeHarness, t);
    const foreign = h.engine.lines.createLine({
      id: 'cctv-a-ray-br',
      widthPx: 1,
      color: [1, 1, 1, 1],
    });
    assert.throws(() => h.display.createCoverage('a', POSITIONS), /exists/);
    assert.deepEqual(
      h.engine.lines.list().map(({ id }) => id),
      ['cctv-a-ray-br'],
    );
    foreign.destroy();
    const lines = h.display.createCoverage('a', POSITIONS);
    assert.deepEqual(
      lines.map((line) => [line.id, line._coverageRole, line.cameraId]),
      [
        ['cctv-a-ray-tl', 'edge', 'a'],
        ['cctv-a-ray-tr', 'edge', 'a'],
        ['cctv-a-ray-br', 'edge', 'a'],
        ['cctv-a-ray-bl', 'edge', 'a'],
        ['cctv-a-cap', 'cap', 'a'],
      ],
    );
    assert.ok(
      lines.every((line) => line.show),
      'shown as created',
    );
    assert.deepEqual(lines[4].polyline.positions, [
      POSITIONS.tl,
      POSITIONS.tr,
      POSITIONS.br,
      POSITIONS.bl,
      POSITIONS.tl,
    ]);
    const moved = { ...POSITIONS, tl: p(6378137, 90, 45) };
    h.display.updateCoverage({ coverageEntities: lines }, moved);
    assert.deepEqual(lines[0].polyline.positions, [moved.mount, moved.tl]);
    assert.equal(lines[4].polyline.positions[0], moved.tl);
    {
      const line = h.lineState('cctv-a-cap');
      assert.equal(line.widthPx, 1.2);
      assert.equal(line.arc, 'geodesic');
      assert.equal(line.pickId, 'cctv-a-cap');
      sameRgba(line.color, IDLE_COVERAGE_COLOR, 'idle colour');
    }
    h.display.hideCoverage({ coverageEntities: lines });
    assert.ok(lines.every((line) => !line.show));
    h.display.removeCoverageEntity(lines[0]);
    h.display.removeCoverage({ coverageEntities: lines });
    assert.equal(h.engine.lines.list().length, 0);
  });

  test(`coverage styles keep Cesium's widths, dash and depth fail (${name})`, (t) => {
    const h = setup(makeHarness, t);
    const [edge, , , , cap] = h.display.createCoverage('a', POSITIONS);
    const hue = viewshedColors(210);
    // The layer's styles (../rendering.js) for an active, viewshed-hued
    // estimated bearing behind the plane, then idle ones.
    const style = (line, input) =>
      h.display.styleLine(line, { visible: true, dashed: false, ...input });
    style(edge, {
      width: 1.8,
      tint: hue.lineActive,
      dashed: true,
      depthFail: hue.line.withAlpha(0.18),
    });
    {
      const line = h.lineState(edge.id);
      assert.deepEqual(line.dash, { kind: 'pixels', lengthPx: 8, gapPx: 8 });
      assert.equal(line.widthPx, 1.8);
      near(line.depthFailAlpha, 0.18 / hue.lineActive.alpha, 'depth fail');
      sameRgba(line.color, hue.lineActive, 'active hue');
    }
    style(cap, { visible: false, width: 1, tint: IDLE_COVERAGE_CENTER_MUTED });
    assert.equal(cap.show, false);
    style(edge, { width: 0.9, tint: IDLE_COVERAGE_EDGE_MUTED });
    {
      const line = h.lineState(edge.id);
      assert.equal(line.dash, null);
      assert.equal(line.depthFailAlpha, 0);
      assert.equal(line.widthPx, 0.9);
      h.engine.fake.resetCalls();
      const before = h.engine.fake.line(edge.id);
      style(edge, { width: 0.9, tint: hue.line.withAlpha(0.6) });
      assert.equal(
        h.engine.fake.line(edge.id),
        before,
        'a colour change keeps the line',
      );
      sameRgba(h.lineState(edge.id).color, hue.line.withAlpha(0.6), 'idle hue');
    }
  });

  test(`picks need this layer's own markers, lines and planes (${name})`, async (t) => {
    const h = setup(makeHarness, t);
    const record = recordFor(h.state, 'a');
    h.display.createMarkers();
    record.billboard = h.display.createMarker({ id: 'a' }, POSITIONS.mount);
    h.frame();
    await h.settle();
    h.scriptPicks({ set: 'cctv', index: 0 });
    assert.equal(
      h.display.extractPickedCameraId(h.display.pick({ x: 1, y: 1 })),
      'a',
    );
    assert.equal(
      h.display.extractPickedCameraId({ id: 'a', owner: 'sibling' }),
      null,
      'a sibling with the camera id is not this layer',
    );
    record.coverageEntities = h.display.createCoverage('a', POSITIONS);
    h.scriptPicks({ line: 'cctv-a-cap' });
    assert.equal(
      h.display.extractPickedCameraId(h.display.pick({ x: 1, y: 1 })),
      'a',
    );
    record.coverageEntities[4].show = false;
    assert.equal(
      h.display.extractPickedCameraId({
        id: 'cctv-a-cap',
        owner: 'cctv-a-cap',
      }),
      null,
      'a hidden line is not picked',
    );
    record.coverageEntities[4].show = true;
    const stray = h.display.createCoverage('b', POSITIONS);
    assert.equal(
      h.display.extractPickedCameraId({ id: stray[0].id, owner: stray[0].id }),
      null,
      'a line no record owns is not a camera',
    );
    h.display.removeCoverageEntity(record.coverageEntities[4]);
    assert.equal(
      h.display.extractPickedCameraId({
        id: 'cctv-a-cap',
        owner: 'cctv-a-cap',
      }),
      null,
    );
    assert.equal(h.display.extractPickedCameraId(undefined), null);
  });

  test(`the monitor plane, its outline and material (${name})`, (t) => {
    const h = setup(makeHarness, t);
    const record = recordFor(h.state, 'a');
    const orientation = geo.quaternion.fromAxisAngle(
      geo.cartesian3.normalize(p(1, 2, 3), geo.cartesian3.create()),
      0.75,
      geo.quaternion.create(),
    );
    const runtime = { cameraId: 'a', planeMaterial: null };
    runtime.planeMaterial = h.display.createPlaneMaterial({ width: 8 });
    const plane = h.display.createPlane(
      { camera: { id: 'a' } },
      runtime,
      SHAPE,
      POSITIONS,
      orientation,
    );
    runtime.planeEntity = plane;
    assert.equal(plane.show, false);
    assert.equal(plane.outline.show, false);
    h.display.setPlaneVisible(runtime, true);
    assert.equal(plane.outline.show, true);
    const corners = plane.outline.polyline.positions;
    const rotation = geo.matrix3.fromQuaternion(
      orientation,
      geo.matrix3.create(),
    );
    for (const [index, [x, y]] of [
      [-1, 1],
      [1, 1],
      [1, -1],
      [-1, -1],
      [-1, 1],
    ].entries()) {
      const expected = geo.cartesian3.add(
        geo.matrix3.multiplyByVector(
          rotation,
          p(x * SHAPE.halfW, y * SHAPE.halfH, 0),
          geo.cartesian3.create(),
        ),
        POSITIONS.capCenter,
        geo.cartesian3.create(),
      );
      near(geo.cartesian3.distance(corners[index], expected), 0, 'corner');
    }
    {
      const outline = h.lineState('cctv-a-plane-outline');
      assert.equal(outline.widthPx, 1);
      assert.equal(outline.pickId, 'cctv-a-plane');
      sameRgba(outline.color, PLANE_OUTLINE_COLOR, 'outline colour');
      record.projection = runtime;
    }
    h.scriptPicks({ line: 'cctv-a-plane-outline' });
    assert.equal(
      h.display.extractPickedCameraId(h.display.pick({ x: 1, y: 1 })),
      'a',
      'the outline picks its camera',
    );
    const moved = { ...POSITIONS, capCenter: p(6378140, 120, 20) };
    h.display.updatePlane(runtime, SHAPE, moved, orientation);
    near(
      plane.outline.polyline.positions[0].x - corners[0].x,
      3,
      'the outline moves with the plane',
    );
    const material = runtime.planeMaterial;
    h.display.removePlane(runtime);
    assert.equal(material.disposed, true);
    assert.equal(h.engine.lines.list().length, 0);
  });

  test(`the viewshed volume and the activation probe's ray (${name})`, (t) => {
    const mesh = [];
    const h = setup(makeHarness, t, {
      mesh: { sampleMeshFloorCells: (...args) => mesh.push(args) },
    });
    const record = recordFor(h.state, 'a', { frustumPositions: POSITIONS });
    const markerSet = h.display.createMarkers();
    record.billboard = h.display.createMarker({ id: 'a' }, POSITIONS.mount);
    h.display.createMarker({ id: 'b' }, POSITIONS.tl);
    record.coverageEntities = h.display.createCoverage('a', POSITIONS);
    const volume = h.display.createVolume(record, viewshedColors(30).fill);
    h.display.sampleMeshFloorCells([{ lat: 0, lon: 0 }], {
      excludeObjects: [...record.coverageEntities, record.billboard],
    });
    const [[target, , { excludeObjects }]] = mesh;
    assert.equal(target, h.engine);
    assert.ok(excludeObjects.includes(markerSet), 'the marker set');
    assert.ok(
      record.coverageEntities.every(({ line }) =>
        excludeObjects.includes(line),
      ),
      'the engine lines',
    );
    assert.equal(excludeObjects.length, 6);
    const direction = p(0, 1, 0);
    {
      assert.equal(
        h.display.obstructionRay(POSITIONS.mount, direction, [], 30),
        undefined,
        'no ray pick on an engine without one',
      );
      let ray;
      h.engine.surface.raycast = (query) => {
        ray = query;
        return { position: POSITIONS.tl, distance: 5 };
      };
      assert.ok(
        h.display.obstructionRay(
          POSITIONS.mount,
          direction,
          record.coverageEntities,
          30,
        ),
      );
      assert.equal(ray.far, 30);
      assert.equal(ray.exclude.length, 6);
      assert.equal(volume.positions, POSITIONS);
    }
  });

  test(`a clean click reaches the layer; a drag does not (${name})`, (t) => {
    const h = setup(makeHarness, t);
    const clicks = [];
    const moves = [];
    const remove = h.display.bindClick((click) => clicks.push(click.position), {
      onMouseMove: (movement) => moves.push(movement.endPosition),
    });
    const press = (to) => {
      h.fire('down', { position: { x: 10, y: 10 } });
      h.fire('move', { startPosition: { x: 10, y: 10 }, endPosition: to });
      h.fire('up', { position: to });
      h.fire('click', { position: to });
    };
    press({ x: 12, y: 11 });
    press({ x: 60, y: 10 });
    assert.equal(clicks.length, 1);
    assert.deepEqual({ ...clicks[0] }, { x: 12, y: 11 });
    assert.equal(moves.length, 2);
    remove();
    press({ x: 12, y: 11 });
    assert.equal(clicks.length, 1);
  });

  test(`focus, credit and teardown (${name})`, (t) => {
    const credits = [];
    const h = setup(makeHarness, t, {
      credits: {
        showOsmCredit: (...args) => credits.push(['show', ...args]),
        hideOsmCredit: (...args) => credits.push(['hide', ...args]),
      },
    });
    let flight;
    h.engine.camera.flyToSphere = (sphere, options) => {
      flight = { sphere, options };
    };
    h.display.focus(
      { position: POSITIONS.mount, camera: { headingDeg: 84, rangeM: 126 } },
      0.1,
    );
    assert.deepEqual(flight, {
      sphere: { center: POSITIONS.mount, radius: 45.36 },
      options: {
        heading: (84 * Math.PI) / 180,
        pitch: (-22 * Math.PI) / 180,
        range: 280,
        duration: 0.2,
        easing: 'cubicInOut',
      },
    });
    h.display.showCredit();
    h.display.showCredit();
    assert.deepEqual(credits, [['show', h.engine, 'cctv']]);
    let moves = 0;
    h.display.onMoveEnd(() => moves++);
    h.engine.camera.moveEnd.raiseEvent();
    assert.equal(moves, 1);
    h.display.createMarkers();
    h.display.createMarker({ id: 'a' }, POSITIONS.mount);
    h.display.createCoverage('a', POSITIONS);
    const runtime = { planeMaterial: h.display.createPlaneMaterial(null) };
    runtime.planeEntity = h.display.createPlane(
      { camera: { id: 'a' } },
      runtime,
      SHAPE,
      POSITIONS,
      { x: 0, y: 0, z: 0, w: 1 },
    );
    h.display.createVolume(
      { frustumPositions: POSITIONS },
      viewshedColors(1).fill,
    );
    h.display.createGizmoRenderer().createPoint('range', IDLE_CAMERA_COLOR, 10);
    assert.equal(h.display.ready, true);
    h.display.destroy();
    h.display.destroy();
    assert.equal(h.display.ready, false);
    h.engine.camera.moveEnd.raiseEvent();
    assert.equal(moves, 1);
    assert.deepEqual(credits.at(-1), ['hide', h.engine, 'cctv']);
    assert.equal(h.engine.lines.list().length, 0);
    assert.equal(h.engine.movers.list().length, 0);
  });
}

test('the plane outline closes on its first corner', () => {
  const corners = planeOutline(
    { halfW: 2, halfH: 1 },
    { capCenter: p(10, 0, 0) },
    { x: 0, y: 0, z: 0, w: 1 },
  );
  assert.equal(corners.length, 5);
  assert.equal(corners[0], corners[4]);
  assert.deepEqual({ ...corners[0] }, { x: 8, y: 1, z: 0 });
  assert.deepEqual({ ...corners[2] }, { x: 12, y: -1, z: 0 });
});

test('the display draws and picks a plane on the fake engine', (t) => {
  const engine = createFakeEngine();
  t.after(() => engine.destroy());
  const state = { _recordById: new Map(), _projectionEntities: [] };
  const display = createCctvDisplay(engine, { state });
  display.attach();
  const record = recordFor(state, 'a');
  const runtime = { planeMaterial: display.createPlaneMaterial(null) };
  runtime.planeEntity = display.createPlane(
    { camera: { id: 'a' } },
    runtime,
    SHAPE,
    POSITIONS,
    { x: 0, y: 0, z: 0, w: 1 },
  );
  record.projection = runtime;
  const picked = { id: 'cctv-a-plane', owner: 'cctv-a-plane' };
  assert.equal(display.extractPickedCameraId(picked), null, 'hidden');
  display.setPlaneVisible(runtime, true);
  assert.equal(engine.fake.mesh(picked.id).show, true);
  assert.equal(display.extractPickedCameraId(picked), 'a');
  display.destroy();
  assert.deepEqual(engine.meshes.list(), []);
});
