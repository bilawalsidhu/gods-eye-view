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
import {
  GIZMO_ID_PREFIX,
  closestParamOnAxis,
  createCalibrationGizmo,
  rayPlaneIntersect,
  ringAngle,
  signedAngleDelta,
} from './cctvGizmo.js';
import { FAKE_EVENT_TYPES, fakeInput } from '../input/testDoubles.mjs';
import { bindFakeDraw } from '../testSupport/fakeDrawPort.mjs';
import { fromDegrees } from '../geo/ellipsoid.js';
import { add, distance, negate, normalize, scale } from '../geo/vector.js';

const c3 = (x, y, z) => ({ x, y, z });

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
  const dir = normalize(c3(1, -1, 0));
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
  const nearly = normalize(c3(1, 1e-9, 0));
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
  assert.ok(distance(hit, c3(0, 0, 0)) < 1e-9);
});

test('rayPlaneIntersect: oblique hit resolves correctly', () => {
  const dir = normalize(c3(1, 0, -1));
  const hit = rayPlaneIntersect(c3(0, 0, 5), dir, c3(0, 0, 0), c3(0, 0, 1));
  assert.ok(hit);
  assert.ok(distance(hit, c3(5, 0, 0)) < 1e-9, `got ${JSON.stringify(hit)}`);
});

test('rayPlaneIntersect: grazing ray (|dir·n| < 0.08) returns null', () => {
  // dir almost in-plane: z component 0.05 < 0.08 threshold.
  const dir = normalize(c3(1, 0, -0.05));
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

/**
 * A viewer double drawing through a fake draw port, whose query port picks
 * `picked` and casts the ray `ray` (a ray,
 * or a function of the window position).
 */
function gizmoViewer(t, { picked, ray }) {
  const viewer = {
    scene: {
      canvas: { style: {} },
      screenSpaceCameraController: { enableInputs: true },
    },
  };
  const queries = [];
  const { draw, unbind } = bindFakeDraw(viewer, {
    query: {
      pick: (x, y, window) => (queries.push(['pick', window]), picked()),
      drillPick: (x, y, options) => (queries.push(['drill', options]), []),
      pickRay: (x, y) => (typeof ray === 'function' ? ray(x, y) : ray),
    },
  });
  t.after(unbind);
  return { viewer, draw, queries };
}

const mount = fromDegrees(0, 0, 10);
const east = c3(0, 1, 0); // east at lon 0, lat 0
const gizmoRecord = () => ({
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
});

test('the gizmo draws its parts through the draw port, shown in ADJUST mode only', (t) => {
  const { viewer, draw } = gizmoViewer(t, { picked: () => null, ray: null });
  const { input } = fakeInput(viewer);
  t.after(() => input.destroy());
  const record = gizmoRecord();
  const gizmo = createCalibrationGizmo({
    viewer,
    getActiveRecord: () => record,
    applyPatch() {},
    endPatch() {},
  });
  const lines = draw.find('cctv-gizmo:');
  const points = [...draw.sets.values()].find(
    (set) => set.kind === 'points' && set.spec.id.startsWith('cctv-gizmo:'),
  );
  assert.equal(lines.kind, 'lines');
  assert.equal(lines.items.size, 0, 'nothing drawn before ADJUST');
  gizmo.setEnabled(true);
  assert.deepEqual(
    [...lines.items.keys()],
    ['ring-heading', 'ring-pitch', 'move-east', 'move-north', 'move-up'].map(
      (part) => GIZMO_ID_PREFIX + part,
    ),
  );
  assert.deepEqual(
    [...points.items.keys()],
    [
      'move-east',
      'move-north',
      'move-up',
      'handle-range',
      'handle-fov-l',
      'handle-fov-r',
    ].map((part) => GIZMO_ID_PREFIX + part),
  );
  const ring = lines.items.get(`${GIZMO_ID_PREFIX}ring-heading`);
  assert.equal(ring.mode, '3d');
  assert.equal(ring.widthPx, 3);
  assert.equal(ring.positions.length, 97, 'a closed 96-segment ring');
  assert.ok(Math.abs(ring.style.color[3] - 0.9) < 1e-12);
  assert.ok(Math.abs(ring.depthFailColor[3] - 0.45) < 1e-12);
  const arrow = lines.items.get(`${GIZMO_ID_PREFIX}move-up`);
  assert.equal(arrow.style.kind, 'arrow');
  assert.equal(arrow.widthPx, 12);
  // The up arrow runs 1.6 ring radii (6 m minimum at a 50 m range) up.
  assert.ok(
    distance(arrow.positions[1], add(mount, scale(c3(1, 0, 0), 9.6))) < 1e-6,
  );
  const tip = points.items.get(`${GIZMO_ID_PREFIX}move-up`);
  assert.deepEqual(tip.pos, arrow.positions[1]);
  assert.equal(tip.pixelSize, 14);
  assert.equal(tip.disableDepthTest, Number.POSITIVE_INFINITY);
  assert.ok(
    [...lines.items.values(), ...points.items.values()].every(
      (item) => item.show,
    ),
  );
  gizmo.setEnabled(false);
  assert.ok(
    [...lines.items.values(), ...points.items.values()].every(
      (item) => !item.show,
    ),
    'hidden off ADJUST',
  );
  gizmo.destroy();
  assert.equal(lines.disposed, true);
  assert.equal(points.disposed, true);
});

test('a press after a release Cesium never reported ends the open drag and its camera hold', (t) => {
  let lineSet = null;
  const { viewer, draw, queries } = gizmoViewer(t, {
    picked: () => ({
      set: lineSet,
      id: `${GIZMO_ID_PREFIX}move-up`,
      surface: false,
    }),
    ray: { origin: add(mount, scale(east, 100)), direction: negate(east) },
  });
  const { input, handler } = fakeInput(viewer);
  t.after(() => input.destroy());
  const record = gizmoRecord();
  const ended = [];
  const gizmo = createCalibrationGizmo({
    viewer,
    getActiveRecord: () => record,
    applyPatch() {},
    endPatch: (r) => ended.push(r),
  });
  t.after(() => gizmo.destroy());
  lineSet = draw.find('cctv-gizmo:').spec.id;
  gizmo.setEnabled(true);
  const controller = viewer.scene.screenSpaceCameraController;

  handler.fire(FAKE_EVENT_TYPES.LEFT_DOWN, { position: { x: 5, y: 5 } });
  assert.equal(gizmo.isDragging(), true);
  assert.deepEqual(queries[0], ['pick', { width: 14, height: 14 }]);
  assert.equal(controller.enableInputs, false);
  // The release came with a modifier key held: Cesium raised no LEFT_UP.
  handler.fire(FAKE_EVENT_TYPES.LEFT_DOWN, { position: { x: 5, y: 5 } });
  assert.deepEqual(ended, [record], 'the open drag was committed');
  handler.fire(FAKE_EVENT_TYPES.LEFT_UP, { position: { x: 5, y: 5 } });
  assert.equal(gizmo.isDragging(), false);
  assert.equal(controller.enableInputs, true, 'no hold was stranded');
});

test('a pick of another set or a stray id is no gizmo part', (t) => {
  let picked = null;
  const { viewer, draw } = gizmoViewer(t, {
    picked: () => picked,
    ray: { origin: add(mount, scale(east, 100)), direction: negate(east) },
  });
  const { input, handler } = fakeInput(viewer);
  t.after(() => input.destroy());
  const record = gizmoRecord();
  const gizmo = createCalibrationGizmo({
    viewer,
    getActiveRecord: () => record,
    applyPatch() {},
    endPatch() {},
  });
  t.after(() => gizmo.destroy());
  gizmo.setEnabled(true);
  picked = { set: 'other', id: `${GIZMO_ID_PREFIX}move-up`, surface: false };
  handler.fire(FAKE_EVENT_TYPES.LEFT_DOWN, { position: { x: 5, y: 5 } });
  assert.equal(gizmo.isDragging(), false, 'another set');
  handler.fire(FAKE_EVENT_TYPES.LEFT_UP, { position: { x: 5, y: 5 } });
  picked = {
    set: draw.find('cctv-gizmo:').spec.id,
    id: `${GIZMO_ID_PREFIX}nothing`,
    surface: false,
  };
  handler.fire(FAKE_EVENT_TYPES.LEFT_DOWN, { position: { x: 5, y: 5 } });
  assert.equal(gizmo.isDragging(), false, 'no such part');
});

test('dragging the east arrow moves the camera east by what the pointer travelled', (t) => {
  const up = c3(1, 0, 0); // up at lon 0, lat 0
  let lineSet = null;
  const { viewer, draw } = gizmoViewer(t, {
    picked: () => ({
      set: lineSet,
      id: `${GIZMO_ID_PREFIX}move-east`,
      surface: false,
    }),
    // Straight down onto the east axis, `x` metres east of the mount.
    ray: (x) => ({
      origin: add(add(mount, scale(east, x)), scale(up, 100)),
      direction: negate(up),
    }),
  });
  const { input, handler } = fakeInput(viewer);
  t.after(() => input.destroy());
  const record = gizmoRecord();
  record.camera.calibration = { offsetEastM: 2 };
  const patches = [];
  const gizmo = createCalibrationGizmo({
    viewer,
    getActiveRecord: () => record,
    applyPatch: (patch, pinned) => patches.push([patch, pinned]),
    endPatch() {},
  });
  t.after(() => gizmo.destroy());
  lineSet = draw.find('cctv-gizmo:').spec.id;
  gizmo.setEnabled(true);

  handler.fire(FAKE_EVENT_TYPES.LEFT_DOWN, { position: { x: 5, y: 5 } });
  assert.equal(gizmo.isDragging(), true);
  assert.equal(viewer.scene.canvas.style.cursor, 'grabbing');
  handler.fire(FAKE_EVENT_TYPES.MOUSE_MOVE, {
    startPosition: { x: 5, y: 5 },
    endPosition: { x: 12, y: 5 },
  });
  assert.equal(patches.length, 1);
  const [patch, pinned] = patches[0];
  assert.equal(pinned, record, 'patched on the record dragged');
  assert.ok(Math.abs(patch.offsetEastM - 9) < 1e-6, `${patch.offsetEastM}`);
  handler.fire(FAKE_EVENT_TYPES.LEFT_UP, { position: { x: 12, y: 5 } });
  assert.equal(gizmo.isDragging(), false);
});

test('hovering a handle grows it and shows the grab cursor', (t) => {
  let pointSet = null;
  let over = true;
  const { viewer, draw } = gizmoViewer(t, {
    picked: () =>
      over
        ? {
            set: pointSet,
            id: `${GIZMO_ID_PREFIX}handle-range`,
            surface: false,
          }
        : null,
    ray: null,
  });
  const { input, handler } = fakeInput(viewer);
  t.after(() => input.destroy());
  const record = gizmoRecord();
  const gizmo = createCalibrationGizmo({
    viewer,
    getActiveRecord: () => record,
    applyPatch() {},
    endPatch() {},
  });
  t.after(() => gizmo.destroy());
  const points = [...draw.sets.values()].find(
    (set) => set.kind === 'points' && set.spec.id.startsWith('cctv-gizmo:'),
  );
  pointSet = points.spec.id;
  gizmo.setEnabled(true);
  const size = () =>
    points.items.get(`${GIZMO_ID_PREFIX}handle-range`).pixelSize;
  assert.equal(size(), 13);
  handler.fire(FAKE_EVENT_TYPES.MOUSE_MOVE, {
    startPosition: { x: 5, y: 5 },
    endPosition: { x: 6, y: 5 },
  });
  assert.equal(size(), 17);
  assert.equal(viewer.scene.canvas.style.cursor, 'grab');
});

test('the harness reads each part as drawn, an arrow with its line and tip', (t) => {
  const { viewer } = gizmoViewer(t, { picked: () => null, ray: null });
  const { input } = fakeInput(viewer);
  t.after(() => input.destroy());
  const record = gizmoRecord();
  const gizmo = createCalibrationGizmo({
    viewer,
    getActiveRecord: () => record,
    applyPatch() {},
    endPatch() {},
  });
  t.after(() => gizmo.destroy());
  assert.deepEqual(gizmo.partsForTest(), {}, 'nothing drawn before ADJUST');
  gizmo.setEnabled(true);
  const parts = gizmo.partsForTest();
  const arrow = parts[`${GIZMO_ID_PREFIX}move-east`];
  assert.equal(arrow.positions.length, 2, 'its line');
  assert.deepEqual(arrow.pos, arrow.positions[1], 'its tip');
  assert.equal(arrow.show, true);
  assert.equal(parts[`${GIZMO_ID_PREFIX}ring-heading`].show, true);
  assert.ok(parts[`${GIZMO_ID_PREFIX}handle-range`].pos);
  gizmo.setEnabled(false);
  assert.ok(
    Object.values(gizmo.partsForTest()).every((part) => part.show === false),
  );
});
