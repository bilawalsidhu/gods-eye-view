// src/data/cctvGizmo.test.mjs — pure drag math for the CCTV calibration gizmo
// (docs/superpowers/specs/2026-07-05-cctv-viewshed-gizmo-design.md §3c).
//
// Locks:
//   - closestParamOnAxis returns the metre-parameter along the AXIS of the
//     point nearest the mouse ray (the workhorse for arrow/range drags), and
//     refuses near-parallel configurations instead of exploding;
//   - rayPlaneIntersect refuses grazing rays (|dir·normal| < 0.08 — spec §5
//     precision guard) and behind-origin hits;
//   - ringAngle/signedAngleDelta give quadrant-correct, wrap-safe angles for
//     the heading/pitch ring drags;
//   - the controller ends an open drag, and its camera hold, on the next press.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import {
  GIZMO_ID_PREFIX,
  closestParamOnAxis,
  createCalibrationGizmo,
  rayPlaneIntersect,
  ringAngle,
  signedAngleDelta,
} from './cctvGizmo.js';
import { FAKE_EVENT_TYPES, fakeInput } from '../input/testDoubles.mjs';

const c3 = (x, y, z) => new Cesium.Cartesian3(x, y, z);

test('closestParamOnAxis: perpendicular ray hits the axis at its own offset', () => {
  // Axis along +X from origin. Ray shooting straight down (-Z) from (10, 0, 5):
  // nearest axis point is x=10 → t=10.
  const t = closestParamOnAxis(
    c3(10, 0, 5),
    c3(0, 0, -1),
    c3(0, 0, 0),
    c3(1, 0, 0),
  );
  assert.ok(Math.abs(t - 10) < 1e-9, `expected 10, got ${t}`);
});

test('closestParamOnAxis: skew ray resolves to the geometric closest point', () => {
  // Axis +X. Ray from (0, 10, 0) toward (1, -1, 0)/√2 passes closest to the
  // axis around x=10 (it reaches y=0 at x=10).
  const dir = Cesium.Cartesian3.normalize(
    c3(1, -1, 0),
    new Cesium.Cartesian3(),
  );
  const t = closestParamOnAxis(c3(0, 10, 0), dir, c3(0, 0, 0), c3(1, 0, 0));
  assert.ok(Math.abs(t - 10) < 1e-6, `expected ~10, got ${t}`);
});

test('closestParamOnAxis: axis origin offset shifts the parameter', () => {
  const t = closestParamOnAxis(
    c3(10, 0, 5),
    c3(0, 0, -1),
    c3(4, 0, 0),
    c3(1, 0, 0),
  );
  assert.ok(Math.abs(t - 6) < 1e-9, `expected 6, got ${t}`);
});

test('closestParamOnAxis: near-parallel ray/axis returns null', () => {
  assert.equal(
    closestParamOnAxis(c3(0, 1, 0), c3(1, 0, 0), c3(0, 0, 0), c3(1, 0, 0)),
    null,
  );
  const nearly = Cesium.Cartesian3.normalize(
    c3(1, 1e-9, 0),
    new Cesium.Cartesian3(),
  );
  assert.equal(
    closestParamOnAxis(c3(0, 1, 0), nearly, c3(0, 0, 0), c3(1, 0, 0)),
    null,
  );
});

test('rayPlaneIntersect: straight-on hit lands at the expected point', () => {
  const hit = rayPlaneIntersect(
    c3(0, 0, 10),
    c3(0, 0, -1),
    c3(0, 0, 0),
    c3(0, 0, 1),
  );
  assert.ok(hit, 'expected a hit');
  assert.ok(Cesium.Cartesian3.distance(hit, c3(0, 0, 0)) < 1e-9);
});

test('rayPlaneIntersect: oblique hit resolves correctly', () => {
  const dir = Cesium.Cartesian3.normalize(
    c3(1, 0, -1),
    new Cesium.Cartesian3(),
  );
  const hit = rayPlaneIntersect(c3(0, 0, 5), dir, c3(0, 0, 0), c3(0, 0, 1));
  assert.ok(hit);
  assert.ok(Cesium.Cartesian3.distance(hit, c3(5, 0, 0)) < 1e-9, `got ${hit}`);
});

test('rayPlaneIntersect: grazing ray (|dir·n| < 0.08) returns null', () => {
  // dir almost in-plane: z component 0.05 < 0.08 threshold.
  const dir = Cesium.Cartesian3.normalize(
    c3(1, 0, -0.05),
    new Cesium.Cartesian3(),
  );
  assert.equal(
    rayPlaneIntersect(c3(0, 0, 5), dir, c3(0, 0, 0), c3(0, 0, 1)),
    null,
  );
});

test('rayPlaneIntersect: plane behind the ray origin returns null', () => {
  assert.equal(
    rayPlaneIntersect(c3(0, 0, 10), c3(0, 0, 1), c3(0, 0, 0), c3(0, 0, 1)),
    null,
  );
});

test('ringAngle: quadrant sweep in the (basisA, basisB) frame', () => {
  const center = c3(0, 0, 0);
  const a = c3(1, 0, 0);
  const b = c3(0, 1, 0);
  assert.ok(Math.abs(ringAngle(c3(5, 0, 0), center, a, b) - 0) < 1e-9);
  assert.ok(
    Math.abs(ringAngle(c3(0, 5, 0), center, a, b) - Math.PI / 2) < 1e-9,
  );
  assert.ok(
    Math.abs(Math.abs(ringAngle(c3(-5, 0, 0), center, a, b)) - Math.PI) < 1e-9,
  );
  assert.ok(
    Math.abs(ringAngle(c3(0, -5, 0), center, a, b) + Math.PI / 2) < 1e-9,
  );
});

test('signedAngleDelta: shortest-path wrap', () => {
  const d2r = (d) => (d * Math.PI) / 180;
  assert.ok(Math.abs(signedAngleDelta(d2r(170), d2r(-170)) - d2r(20)) < 1e-9);
  assert.ok(Math.abs(signedAngleDelta(d2r(-170), d2r(170)) - d2r(-20)) < 1e-9);
  assert.ok(Math.abs(signedAngleDelta(d2r(10), d2r(30)) - d2r(20)) < 1e-9);
});

test('a press after a release Cesium never reported ends the open drag and its camera hold', (t) => {
  const viewer = {
    entities: {
      byId: new Map(),
      getById(id) {
        return this.byId.get(id);
      },
      add(options) {
        this.byId.set(options.id, options);
        return options;
      },
      remove(entity) {
        this.byId.delete(entity.id);
      },
    },
    scene: {
      canvas: { style: {} },
      screenSpaceCameraController: { enableInputs: true },
      pick: () => ({ id: { id: `${GIZMO_ID_PREFIX}move-up` } }),
      drillPick: () => [],
    },
  };
  const mount = Cesium.Cartesian3.fromDegrees(0, 0, 10);
  const east = new Cesium.Cartesian3(0, 1, 0); // east at lon 0, lat 0
  viewer.camera = {
    getPickRay: () => ({
      origin: Cesium.Cartesian3.add(
        mount,
        Cesium.Cartesian3.multiplyByScalar(east, 100, new Cesium.Cartesian3()),
        new Cesium.Cartesian3(),
      ),
      direction: Cesium.Cartesian3.negate(east, new Cesium.Cartesian3()),
    }),
  };
  const { input, handler } = fakeInput(viewer);
  t.after(() => input.destroy());
  const record = {
    frustumPositions: {
      mount,
      capCenter: mount,
      tl: mount,
      tr: mount,
      bl: mount,
      br: mount,
    },
    frustumGeometry: { rangeM: 50 },
    camera: {
      headingDeg: 0,
      pitchDeg: 0,
      rangeM: 50,
      calibration: {},
      basePose: {},
    },
  };
  const ended = [];
  const gizmo = createCalibrationGizmo({
    viewer,
    getActiveRecord: () => record,
    applyPatch() {},
    endPatch: (r) => ended.push(r),
  });
  t.after(() => gizmo.destroy());
  gizmo.setEnabled(true);
  const controller = viewer.scene.screenSpaceCameraController;

  handler.fire(FAKE_EVENT_TYPES.LEFT_DOWN, { position: { x: 5, y: 5 } });
  assert.equal(gizmo.isDragging(), true);
  assert.equal(controller.enableInputs, false);
  // The release came with a modifier key held: Cesium raised no LEFT_UP.
  handler.fire(FAKE_EVENT_TYPES.LEFT_DOWN, { position: { x: 5, y: 5 } });
  assert.deepEqual(ended, [record], 'the open drag was committed');
  handler.fire(FAKE_EVENT_TYPES.LEFT_UP, { position: { x: 5, y: 5 } });
  assert.equal(gizmo.isDragging(), false);
  assert.equal(controller.enableInputs, true, 'no hold was stranded');
});
