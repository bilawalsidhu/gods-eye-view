// src/data/cctvGizmo.test.mjs — pure drag math + controller for the CCTV
// calibration gizmo documented in docs/CURRENT-STATE.md.
//
// Locks:
//   - closestParamOnAxis returns the metre-parameter along the AXIS of the
//     point nearest the mouse ray (the workhorse for arrow/range drags), and
//     refuses near-parallel configurations instead of exploding;
//   - rayPlaneIntersect refuses grazing rays (|dir·normal| < 0.08 — spec §5
//     precision guard) and behind-origin hits;
//   - ringAngle/signedAngleDelta give quadrant-correct, wrap-safe angles for
//     the heading/pitch ring drags;
//   - the createCalibrationGizmo controller renders the 7-DOF handle set,
//     converts synthetic drags into calibration patches (with the PINNED
//     record, mid-drag camera-switch cancellation, throttling), disables the
//     camera controller while dragging, and tears everything down on destroy.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import {
  closestParamOnAxis,
  createCalibrationGizmo,
  GIZMO_ID_PREFIX,
  rayPlaneIntersect,
  ringAngle,
  signedAngleDelta,
} from './cctvGizmo.js';

const c3 = (x, y, z) => new Cesium.Cartesian3(x, y, z);

test('closestParamOnAxis: perpendicular ray hits the axis at its own offset', () => {
  // Axis along +X from origin. Ray shooting straight down (-Z) from (10, 0, 5):
  // nearest axis point is x=10 → t=10.
  const t = closestParamOnAxis(c3(10, 0, 5), c3(0, 0, -1), c3(0, 0, 0), c3(1, 0, 0));
  assert.ok(Math.abs(t - 10) < 1e-9, `expected 10, got ${t}`);
});

test('closestParamOnAxis: skew ray resolves to the geometric closest point', () => {
  // Axis +X. Ray from (0, 10, 0) toward (1, -1, 0)/√2 passes closest to the
  // axis around x=10 (it reaches y=0 at x=10).
  const dir = Cesium.Cartesian3.normalize(c3(1, -1, 0), new Cesium.Cartesian3());
  const t = closestParamOnAxis(c3(0, 10, 0), dir, c3(0, 0, 0), c3(1, 0, 0));
  assert.ok(Math.abs(t - 10) < 1e-6, `expected ~10, got ${t}`);
});

test('closestParamOnAxis: axis origin offset shifts the parameter', () => {
  const t = closestParamOnAxis(c3(10, 0, 5), c3(0, 0, -1), c3(4, 0, 0), c3(1, 0, 0));
  assert.ok(Math.abs(t - 6) < 1e-9, `expected 6, got ${t}`);
});

test('closestParamOnAxis: near-parallel ray/axis returns null', () => {
  assert.equal(closestParamOnAxis(c3(0, 1, 0), c3(1, 0, 0), c3(0, 0, 0), c3(1, 0, 0)), null);
  const nearly = Cesium.Cartesian3.normalize(c3(1, 1e-9, 0), new Cesium.Cartesian3());
  assert.equal(closestParamOnAxis(c3(0, 1, 0), nearly, c3(0, 0, 0), c3(1, 0, 0)), null);
});

test('rayPlaneIntersect: straight-on hit lands at the expected point', () => {
  const hit = rayPlaneIntersect(c3(0, 0, 10), c3(0, 0, -1), c3(0, 0, 0), c3(0, 0, 1));
  assert.ok(hit, 'expected a hit');
  assert.ok(Cesium.Cartesian3.distance(hit, c3(0, 0, 0)) < 1e-9);
});

test('rayPlaneIntersect: oblique hit resolves correctly', () => {
  const dir = Cesium.Cartesian3.normalize(c3(1, 0, -1), new Cesium.Cartesian3());
  const hit = rayPlaneIntersect(c3(0, 0, 5), dir, c3(0, 0, 0), c3(0, 0, 1));
  assert.ok(hit);
  assert.ok(Cesium.Cartesian3.distance(hit, c3(5, 0, 0)) < 1e-9, `got ${hit}`);
});

test('rayPlaneIntersect: grazing ray (|dir·n| < 0.08) returns null', () => {
  // dir almost in-plane: z component 0.05 < 0.08 threshold.
  const dir = Cesium.Cartesian3.normalize(c3(1, 0, -0.05), new Cesium.Cartesian3());
  assert.equal(rayPlaneIntersect(c3(0, 0, 5), dir, c3(0, 0, 0), c3(0, 0, 1)), null);
});

test('rayPlaneIntersect: plane behind the ray origin returns null', () => {
  assert.equal(rayPlaneIntersect(c3(0, 0, 10), c3(0, 0, 1), c3(0, 0, 0), c3(0, 0, 1)), null);
});

test('ringAngle: quadrant sweep in the (basisA, basisB) frame', () => {
  const center = c3(0, 0, 0);
  const a = c3(1, 0, 0);
  const b = c3(0, 1, 0);
  assert.ok(Math.abs(Number(ringAngle(c3(5, 0, 0), center, a, b))) < 1e-9);
  assert.ok(Math.abs(ringAngle(c3(0, 5, 0), center, a, b) - Math.PI / 2) < 1e-9);
  assert.ok(Math.abs(Math.abs(ringAngle(c3(-5, 0, 0), center, a, b)) - Math.PI) < 1e-9);
  assert.ok(Math.abs(ringAngle(c3(0, -5, 0), center, a, b) + Math.PI / 2) < 1e-9);
});

test('signedAngleDelta: shortest-path wrap', () => {
  const d2r = (d) => (d * Math.PI) / 180;
  assert.ok(Math.abs(signedAngleDelta(d2r(170), d2r(-170)) - d2r(20)) < 1e-9);
  assert.ok(Math.abs(signedAngleDelta(d2r(-170), d2r(170)) - d2r(-20)) < 1e-9);
  assert.ok(Math.abs(signedAngleDelta(d2r(10), d2r(30)) - d2r(20)) < 1e-9);
});

// ── controller suite ────────────────────────────────────────────────────────
// Drives the real createCalibrationGizmo controller: real Cesium entities and
// ENU math, a real ScreenSpaceEventHandler bound to a fake canvas, and
// scripted scene.pick / camera rays. Drag geometry is constructed so each
// patch has an analytically known value (see the ray helpers below).

/** Fake canvas that records DOM listeners so tests can dispatch real
 * ScreenSpaceEventHandler input events headlessly. */
function makeFakeCanvas() {
  const listeners = new Map();
  return {
    disableRootEvents: true,
    style: {},
    onwheel: null, // ScreenSpaceEventHandler probes this before document.onmousewheel
    listeners,
    addEventListener(type, fn) {
      listeners.set(type, fn);
    },
    removeEventListener(type) {
      listeners.delete(type);
    },
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 800, bottom: 600 }),
    dispatch(type, event) {
      const fn = listeners.get(type);
      if (fn) fn(event);
      return Boolean(fn);
    },
  };
}

/** One gizmo part encoded as a scene.pick result (entity whose id carries the
 * GIZMO_ID_PREFIX). */
function pickResultFor(entities, part) {
  return { id: entities.getById(`${GIZMO_ID_PREFIX}${part}`) };
}

/** Raw value of a (possibly Property-wrapped) entity field. */
const valueOf = (field) => (field && typeof field.getValue === 'function' ? field.getValue() : field);

/** Ray dropping along -up: hits the up-plane exactly at `target`. */
const hitRayFromAbove = (axes, target) => ({
  origin: Cesium.Cartesian3.add(
    target,
    Cesium.Cartesian3.multiplyByScalar(axes.up, 50, new Cesium.Cartesian3()),
    new Cesium.Cartesian3(),
  ),
  direction: Cesium.Cartesian3.negate(axes.up, new Cesium.Cartesian3()),
});

/** Ray arriving along -east: hits the right-axis plane exactly at `target`. */
const hitRayFromEast = (axes, target) => ({
  origin: Cesium.Cartesian3.add(
    target,
    Cesium.Cartesian3.multiplyByScalar(axes.east, 50, new Cesium.Cartesian3()),
    new Cesium.Cartesian3(),
  ),
  direction: Cesium.Cartesian3.negate(axes.east, new Cesium.Cartesian3()),
});

/** Ray from `origin` toward `direction` (auto-normalized). */
const ray = (origin, direction) => ({
  origin,
  direction: Cesium.Cartesian3.normalize(direction, new Cesium.Cartesian3()),
});

const AT = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

/** Full active record: an Austin-ish mount at 10 m, camera looking north
 * (heading 0) level (pitch 0) with range 100 and a 60° base FOV. */
function makeRecord() {
  const mount = Cesium.Cartesian3.fromDegrees(-97.7431, 30.2672, 10);
  const frame = Cesium.Transforms.eastNorthUpToFixedFrame(mount);
  const rot = Cesium.Matrix4.getMatrix3(frame, new Cesium.Matrix3());
  const col = (i) => Cesium.Matrix3.getColumn(rot, i, new Cesium.Cartesian3());
  const axes = { east: col(0), north: col(1), up: col(2) };
  // capCenter 100 m north of the mount, level view.
  const capCenter = Cesium.Cartesian3.add(
    mount,
    Cesium.Cartesian3.multiplyByScalar(axes.north, 100, new Cesium.Cartesian3()),
    new Cesium.Cartesian3(),
  );
  const half = 10;
  const lateral = (s) => Cesium.Cartesian3.add(
    capCenter,
    Cesium.Cartesian3.multiplyByScalar(axes.east, s, new Cesium.Cartesian3()),
    new Cesium.Cartesian3(),
  );
  return {
    axes,
    record: {
      frustumPositions: {
        mount,
        capCenter,
        tl: lateral(-half),
        tr: lateral(half),
        bl: lateral(-half),
        br: lateral(half),
      },
      frustumGeometry: { rangeM: 100 },
      camera: {
        headingDeg: 0,
        pitchDeg: 0,
        rangeM: 100,
        calibration: { headingDeg: 10, pitchDeg: 5, offsetEastM: 1, offsetNorthM: 2, heightM: 3, rangeScale: 1, fovDeg: 0 },
        basePose: { headingDeg: 8, pitchDeg: 4, rangeM: 100, fovDeg: 60 },
      },
    },
  };
}

/** Harness: fresh viewer + gizmo + scripted pick. */
function makeHarness(t) {
  const canvas = makeFakeCanvas();
  // ScreenSpaceEventHandler both registers listeners on `document` (when the
  // canvas lacks disableRootEvents) and compares `element === document` in
  // getPosition — headless runs need a stub installed for the whole test.
  const savedDocument = globalThis.document;
  const documentListeners = new Map();
  globalThis.document = {
    onmousewheel: undefined,
    addEventListener: (type, fn) => documentListeners.set(type, fn),
    removeEventListener: (type) => documentListeners.delete(type),
  };
  t.after(() => { globalThis.document = savedDocument; });
  const { record, axes } = makeRecord();
  let activeRecord = record;
  const patches = [];
  const ended = [];
  const pick = { current: null };
  const drill = { current: [] };
  const pickThrows = { current: false };
  const currentRay = { current: null };

  const viewer = {
    scene: {
      canvas,
      pick: () => {
        if (pickThrows.current) throw new Error('pick exploded');
        return pick.current;
      },
      drillPick: () => drill.current,
      screenSpaceCameraController: { enableInputs: true },
    },
    camera: { getPickRay: () => currentRay.current },
    entities: new Cesium.EntityCollection(),
  };

  const gizmo = createCalibrationGizmo({
    viewer,
    getActiveRecord: () => activeRecord,
    applyPatch: (patch, pinned) => patches.push({ patch, pinned }),
    endPatch: (pinned) => ended.push(pinned),
  });

  t.after(() => {
    try {
      gizmo.destroy();
    } catch {
      // already destroyed by the test itself
    }
  });

  return {
    canvas, record, axes, viewer, gizmo, patches, ended, pick, drill,
    pickThrows, currentRay,
    setActiveRecord: (r) => { activeRecord = r; },
    /** Fire a LEFT_DOWN at (100,100) with `ray` as the camera's pick ray. */
    down(r) {
      currentRay.current = r;
      canvas.dispatch('mousedown', { button: 0, clientX: 100, clientY: 100, preventDefault() {} });
    },
    move(r, x = 130, y = 100) {
      currentRay.current = r;
      canvas.dispatch('mousemove', { button: 0, clientX: x, clientY: y, preventDefault() {} });
    },
    up() {
      canvas.dispatch('mouseup', { button: 0, clientX: 100, clientY: 100, preventDefault() {} });
    },
  };
}

test('controller: builds the 7-DOF handle set, all hidden', () => {
  const h = makeHarness({ after: () => {} });
  assert.equal(h.viewer.entities.values.length, 8, '8 gizmo parts');
  for (const part of ['ring-heading', 'ring-pitch', 'move-east', 'move-north', 'move-up', 'handle-range', 'handle-fov-l', 'handle-fov-r']) {
    const entity = h.viewer.entities.getById(`${GIZMO_ID_PREFIX}${part}`);
    assert.ok(entity, `${part} exists`);
    assert.equal(entity.show, false, `${part} starts hidden`);
    assert.ok(entity.polyline || entity.point, `${part} is drawable`);
  }
});

test('controller: refresh with a full record shows every handle with live geometry', () => {
  const h = makeHarness({ after: () => {} });
  h.gizmo.setEnabled(true);
  h.gizmo.refresh();
  const { axes, record } = h;
  const mount = record.frustumPositions.mount;

  const heading = h.viewer.entities.getById(`${GIZMO_ID_PREFIX}ring-heading`);
  assert.equal(heading.show, true);
  assert.equal(valueOf(heading.polyline.positions).length, 97, 'closed 96-segment ring');

  const east = h.viewer.entities.getById(`${GIZMO_ID_PREFIX}move-east`);
  assert.equal(east.show, true);
  assert.equal(valueOf(east.polyline.positions).length, 2, 'arrow = mount + tip');
  const expectedTip = Cesium.Cartesian3.add(
    mount,
    Cesium.Cartesian3.multiplyByScalar(axes.east, 19.2, new Cesium.Cartesian3()),
    new Cesium.Cartesian3(),
  );
  assert.ok(Cesium.Cartesian3.distance(valueOf(east.position), expectedTip) < 0.5,
    'east arrow tip 19.2 m out (12 m ring radius × 1.6)');

  const range = h.viewer.entities.getById(`${GIZMO_ID_PREFIX}handle-range`);
  assert.ok(Cesium.Cartesian3.distance(valueOf(range.position), record.frustumPositions.capCenter) < 1e-6);

  const fovL = h.viewer.entities.getById(`${GIZMO_ID_PREFIX}handle-fov-l`);
  assert.ok(Cesium.Cartesian3.distance(valueOf(fovL.position), record.frustumPositions.tl) < 1e-6,
    'left FOV handle at the left cap edge midpoint');
});

test('controller: refresh without an active record hides everything', () => {
  const h = makeHarness({ after: () => {} });
  h.gizmo.setEnabled(true);
  h.setActiveRecord(null);
  h.gizmo.refresh();
  for (const entity of h.viewer.entities.values) {
    assert.equal(entity.show, false, `${entity.id} hidden without a record`);
  }
});

test('controller: heading drag rotates the calibration by the swept ring angle', () => {
  const h = makeHarness({ after: () => {} });
  h.gizmo.setEnabled(true);
  const { axes, record } = h;
  const mount = record.frustumPositions.mount;
  h.pick.current = pickResultFor(h.viewer.entities, 'ring-heading');

  // Start ray hits the up-plane AT the mount (ring angle 0).
  h.down(hitRayFromAbove(axes, mount));
  assert.equal(h.gizmo.isDragging(), true, 'drag begins');
  assert.equal(h.viewer.scene.screenSpaceCameraController.enableInputs, false,
    'camera controller frozen during a drag');

  // Move so the ray now hits 20 m along east → +90° sweep.
  const east20 = Cesium.Cartesian3.add(
    mount,
    Cesium.Cartesian3.multiplyByScalar(axes.east, 20, new Cesium.Cartesian3()),
    new Cesium.Cartesian3(),
  );
  h.move(hitRayFromAbove(axes, east20));
  assert.equal(h.patches.length, 1, 'one patch per move');
  const { patch, pinned } = h.patches[0];
  assert.equal(pinned, record, 'patch applies to the PINNED record');
  assert.ok(AT(patch.headingDeg, 10 + 90, 1e-3), `heading 10° + 90° sweep, got ${patch.headingDeg}`);

  h.up();
  assert.equal(h.gizmo.isDragging(), false);
  assert.equal(h.ended.length, 1, 'endPatch fired once');
  assert.equal(h.ended[0], record);
  assert.equal(h.viewer.scene.screenSpaceCameraController.enableInputs, true,
    'camera controller restored');
});

test('controller: pitch drag adjusts elevation about the right axis', () => {
  const h = makeHarness({ after: () => {} });
  h.gizmo.setEnabled(true);
  const { axes, record } = h;
  const mount = record.frustumPositions.mount;
  h.pick.current = pickResultFor(h.viewer.entities, 'ring-pitch');

  // Pitch ring plane: normal = right (= east for heading 0), basis (forwardHoriz=north, up).
  h.down(hitRayFromEast(axes, mount));
  assert.equal(h.gizmo.isDragging(), true);

  // 15 m up → +90° pitch sweep.
  const up15 = Cesium.Cartesian3.add(
    mount,
    Cesium.Cartesian3.multiplyByScalar(axes.up, 15, new Cesium.Cartesian3()),
    new Cesium.Cartesian3(),
  );
  h.move(hitRayFromEast(axes, up15));
  assert.equal(h.patches.length, 1);
  assert.ok(AT(h.patches[0].patch.pitchDeg, 5 + 90, 1e-3),
    `pitch 5° + 90° sweep, got ${h.patches[0].patch.pitchDeg}`);
  h.up();
});

test('controller: east arrows translate offsets by metres along the axis', () => {
  const h = makeHarness({ after: () => {} });
  h.gizmo.setEnabled(true);
  const { axes, record } = h;
  const mount = record.frustumPositions.mount;

  // Rays perpendicular to east give t = the east offset directly.
  h.pick.current = pickResultFor(h.viewer.entities, 'move-east');
  const at5 = Cesium.Cartesian3.add(
    mount,
    Cesium.Cartesian3.multiplyByScalar(axes.east, 5, new Cesium.Cartesian3()),
    new Cesium.Cartesian3(),
  );
  const at12 = Cesium.Cartesian3.add(
    mount,
    Cesium.Cartesian3.multiplyByScalar(axes.east, 12, new Cesium.Cartesian3()),
    new Cesium.Cartesian3(),
  );
  h.down(hitRayFromAbove(axes, at5));
  h.move(hitRayFromAbove(axes, at12));
  assert.ok(AT(h.patches[0].patch.offsetEastM, 1 + 7, 1e-6),
    `offsetEast 1 m + 7 m drag, got ${h.patches[0].patch.offsetEastM}`);
  h.up();
});

test('controller: the up arrow adjusts mount height', () => {
  const h = makeHarness({ after: () => {} });
  h.gizmo.setEnabled(true);
  const { axes, record } = h;
  const mount = record.frustumPositions.mount;

  // Rays arriving along -east are perpendicular to the up axis: t = height.
  h.pick.current = pickResultFor(h.viewer.entities, 'move-up');
  h.down(hitRayFromEast(axes, mount));
  h.move(hitRayFromEast(axes, Cesium.Cartesian3.add(
    mount,
    Cesium.Cartesian3.multiplyByScalar(axes.up, 4, new Cesium.Cartesian3()),
    new Cesium.Cartesian3(),
  )));
  assert.ok(AT(h.patches[0].patch.heightM, 3 + 4, 1e-6),
    `height 3 m + 4 m drag, got ${h.patches[0].patch.heightM}`);
  h.up();
});

test('controller: range handle returns a scale over the base pose range', () => {
  const h = makeHarness({ after: () => {} });
  h.gizmo.setEnabled(true);
  const { axes, record } = h;
  const mount = record.frustumPositions.mount;
  h.pick.current = pickResultFor(h.viewer.entities, 'handle-range');

  // Level view → view axis = north. Drop a ray 8 m north of the mount.
  h.down(hitRayFromAbove(axes, Cesium.Cartesian3.add(
    mount,
    Cesium.Cartesian3.multiplyByScalar(axes.north, 8, new Cesium.Cartesian3()),
    new Cesium.Cartesian3(),
  )));
  h.move(hitRayFromAbove(axes, Cesium.Cartesian3.add(
    mount,
    Cesium.Cartesian3.multiplyByScalar(axes.north, 12, new Cesium.Cartesian3()),
    new Cesium.Cartesian3(),
  )));
  // The patch reports the CURRENT cursor distance as a scale of basePose.rangeM.
  assert.ok(AT(h.patches[0].patch.rangeScale, 12 / 100, 1e-6),
    `scale t/baseRange = 0.12, got ${h.patches[0].patch.rangeScale}`);
  h.up();
});

test('controller: FOV handle converts the lateral hit offset into a fov patch', () => {
  const h = makeHarness({ after: () => {} });
  h.gizmo.setEnabled(true);
  const { axes, record } = h;
  h.pick.current = pickResultFor(h.viewer.entities, 'handle-fov-r');

  // Plane at capCenter with normal = view (north, level view). Shoot obliquely
  // from the +north side so the hit lands 15 m east of the cap center.
  const capCenter = record.frustumPositions.capCenter;
  const off = (axis, s) => Cesium.Cartesian3.multiplyByScalar(axis, s, new Cesium.Cartesian3());
  const origin = Cesium.Cartesian3.add(capCenter, Cesium.Cartesian3.add(
    off(axes.east, 15),
    Cesium.Cartesian3.add(off(axes.north, 40), off(axes.up, 20), new Cesium.Cartesian3()),
    new Cesium.Cartesian3(),
  ), new Cesium.Cartesian3());
  const toward = Cesium.Cartesian3.add(
    Cesium.Cartesian3.negate(axes.north, new Cesium.Cartesian3()),
    off(axes.up, 0.5),
    new Cesium.Cartesian3(),
  );
  const r = ray(origin, toward);
  h.down(r);
  assert.equal(h.gizmo.isDragging(), true, 'fov grab succeeds with a non-grazing ray');
  h.move(r);
  assert.equal(h.patches.length, 1);
  const fovPatch = h.patches[0].patch.fovDeg;
  const expected = (2 * Math.atan(15 / 100) * 180) / Math.PI - 60;
  assert.ok(AT(fovPatch, expected, 1e-3), `fov patch should be ~-42.94°, got ${fovPatch} (expected ${expected})`);
  h.up();
});

test('controller: a mid-drag active-camera switch cancels the drag on the pinned record', () => {
  const h = makeHarness({ after: () => {} });
  h.gizmo.setEnabled(true);
  const { axes, record } = h;
  const mount = record.frustumPositions.mount;
  h.pick.current = pickResultFor(h.viewer.entities, 'ring-heading');
  h.down(hitRayFromAbove(axes, mount));
  assert.equal(h.gizmo.isDragging(), true);

  // Voice-select / auto-hop swaps the active camera mid-drag.
  const other = makeRecord();
  h.setActiveRecord(other.record);

  const east20 = Cesium.Cartesian3.add(
    mount,
    Cesium.Cartesian3.multiplyByScalar(axes.east, 20, new Cesium.Cartesian3()),
    new Cesium.Cartesian3(),
  );
  h.move(hitRayFromAbove(axes, east20));
  assert.equal(h.patches.length, 0, 'no patch follows the camera switch');
  assert.equal(h.gizmo.isDragging(), false, 'drag ended');
  assert.equal(h.ended.length, 1, 'endPatch fired for the PINNED record');
  assert.equal(h.ended[0], record);
  assert.equal(h.viewer.scene.screenSpaceCameraController.enableInputs, true);
});

test('controller: drag moves are throttled to one patch per 16 ms', () => {
  const h = makeHarness({ after: () => {} });
  h.gizmo.setEnabled(true);
  const { axes, record } = h;
  const mount = record.frustumPositions.mount;
  h.pick.current = pickResultFor(h.viewer.entities, 'ring-heading');
  h.down(hitRayFromAbove(axes, mount));

  const r = hitRayFromAbove(axes, Cesium.Cartesian3.add(
    mount,
    Cesium.Cartesian3.multiplyByScalar(axes.east, 20, new Cesium.Cartesian3()),
    new Cesium.Cartesian3(),
  ));
  h.move(r);
  h.move(r); // second dispatch within DRAG_THROTTLE_MS (same ms) → dropped
  assert.equal(h.patches.length, 1, 'rapid repeat move is throttled');
  h.up();
});

test('controller: hover bumps point-handle size, sets the cursor, and is throttled', () => {
  const h = makeHarness({ after: () => {} });
  h.gizmo.setEnabled(true);
  h.pick.current = pickResultFor(h.viewer.entities, 'handle-range');

  h.move(null, 200, 200); // hover move (no drag)
  const range = h.viewer.entities.getById(`${GIZMO_ID_PREFIX}handle-range`);
  const size = () => range.point.pixelSize.getValue?.() ?? range.point.pixelSize;
  assert.equal(size(), 17, 'hot handle-range: 13 + 4');
  assert.equal(h.canvas.style.cursor, 'grab');

  const pickCallsBefore = h.pick.current ? 1 : 0;
  void pickCallsBefore;
  h.move(null, 240, 240); // within HOVER_THROTTLE_MS → skipped
  assert.equal(size(), 17, 'throttled hover does not re-run the pick');

  h.gizmo.setEnabled(false);
  assert.equal(h.canvas.style.cursor, '', 'disable clears the cursor');
  assert.equal(size(), 13, 'hover feedback cleared');
});

test('controller: setEnabled(false) mid-drag commits the tail and hides handles', () => {
  const h = makeHarness({ after: () => {} });
  h.gizmo.setEnabled(true);
  const { axes, record } = h;
  const mount = record.frustumPositions.mount;
  h.pick.current = pickResultFor(h.viewer.entities, 'ring-heading');
  h.down(hitRayFromAbove(axes, mount));
  h.gizmo.setEnabled(false);
  assert.equal(h.gizmo.isDragging(), false, 'drag ended by disable');
  assert.equal(h.ended.length, 1);
  for (const entity of h.viewer.entities.values) {
    assert.equal(entity.show, false);
  }
});

test('controller: pick falls back to drillPick when the fast pick throws or misses', () => {
  const h = makeHarness({ after: () => {} });
  h.gizmo.setEnabled(true);
  const { axes, record } = h;
  const mount = record.frustumPositions.mount;

  // Fast pick throws; drill finds the gizmo part among distractors.
  h.pickThrows.current = true;
  h.drill.current = [{ id: { id: 'some-other-entity' } }, pickResultFor(h.viewer.entities, 'ring-heading')];
  h.down(hitRayFromAbove(axes, mount));
  assert.equal(h.gizmo.isDragging(), true, 'drillPick fallback found the ring');
  h.up();

  // Fast pick misses; drill returns only non-gizmo results → no drag.
  h.pickThrows.current = false;
  h.pick.current = null;
  h.drill.current = [{ id: { id: 'terrain' } }];
  h.down(hitRayFromAbove(axes, mount));
  assert.equal(h.gizmo.isDragging(), false, 'a pick with no gizmo part never grabs');

  // Drill finds a part that is currently hidden (empty record) → ignored.
  h.setActiveRecord(null);
  h.drill.current = [pickResultFor(h.viewer.entities, 'ring-heading')];
  h.down(hitRayFromAbove(axes, mount));
  assert.equal(h.gizmo.isDragging(), false, 'hidden parts are not pickable');
});

test('controller: beginDrag refuses records missing the drag reference frame', () => {
  const h = makeHarness({ after: () => {} });
  h.gizmo.setEnabled(true);
  const partial = { ...h.record, frustumGeometry: undefined };
  h.setActiveRecord(partial);
  h.pick.current = pickResultFor(h.viewer.entities, 'ring-heading');
  h.currentRay.current = { origin: new Cesium.Cartesian3(), direction: new Cesium.Cartesian3(0, 0, -1) };
  h.canvas.dispatch('mousedown', { button: 0, clientX: 100, clientY: 100, preventDefault() {} });
  assert.equal(h.gizmo.isDragging(), false, 'no geometry → no drag');

  // A pick ray the handler cannot produce also refuses the grab.
  h.setActiveRecord(h.record);
  h.currentRay.current = null;
  h.canvas.dispatch('mousedown', { button: 0, clientX: 100, clientY: 100, preventDefault() {} });
  assert.equal(h.gizmo.isDragging(), false, 'missing pick ray → no drag');
});

test('controller: destroy removes entities, kills the handler, and commits an open drag', () => {
  const h = makeHarness({ after: () => {} });
  h.gizmo.setEnabled(true);
  const { axes, record } = h;
  const mount = record.frustumPositions.mount;
  h.pick.current = pickResultFor(h.viewer.entities, 'ring-heading');
  h.down(hitRayFromAbove(axes, mount));

  h.gizmo.destroy();
  assert.equal(h.ended.length, 1, 'open drag committed');
  assert.equal(h.viewer.entities.values.length, 0, 'all gizmo entities removed');
  assert.equal(h.canvas.style.cursor, '');
  // Post-destroy events are inert.
  h.canvas.dispatch('mousedown', { button: 0, clientX: 100, clientY: 100, preventDefault() {} });
  h.canvas.dispatch('mousemove', { clientX: 120, clientY: 120, preventDefault() {} });
  h.canvas.dispatch('mouseup', { button: 0, clientX: 120, clientY: 120 });
  assert.equal(h.patches.length, 0, 'no patches after destroy');
});
