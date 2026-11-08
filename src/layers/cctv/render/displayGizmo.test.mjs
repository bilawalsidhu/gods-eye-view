// Layer display behavior on the fake engine.

import test from 'node:test';
import assert from 'node:assert/strict';
import * as geo from '../../../geo/index.js';
import { createCalibrationGizmo } from '../../../data/cctvGizmo.js';
import { CCTV_HARNESSES } from '../../../testSupport/cctvEngines.mjs';
import { IDLE_CAMERA_COLOR } from '../policy.js';
import { createCctvDisplay } from './display.js';

const p = (x, y, z) => geo.cartesian3.fromElements(x, y, z);
const near = (actual, expected, label) =>
  assert.ok(Math.abs(actual - expected) < 1e-5, `${label}: ${actual}`);

function setup(makeHarness, t) {
  const harness = makeHarness();
  const display = createCctvDisplay(harness.engine, { state: {} });
  display.attach();
  // A fixed ray per screen x: along -X from 100 m over the mount.
  harness.engine.camera.pickRay = ({ x }) => ({
    origin: p(6378237, x, 0),
    direction: p(-1, 0, 0),
  });
  const renderer = display.createGizmoRenderer();
  const record = {
    camera: {
      headingDeg: 0,
      pitchDeg: 0,
      rangeM: 100,
      calibration: {
        headingDeg: 0,
        pitchDeg: 0,
        offsetEastM: 0,
        offsetNorthM: 0,
        heightM: 0,
        rangeScale: 1,
        fovDeg: 0,
      },
      basePose: { rangeM: 100, fovDeg: 60 },
    },
    frustumGeometry: { rangeM: 100 },
    frustumPositions: {
      mount: p(6378137, 0, 0),
      capCenter: p(6378137, 0, 100),
      tl: p(6378150, -20, 100),
      tr: p(6378150, 20, 100),
      bl: p(6378124, -20, 100),
      br: p(6378124, 20, 100),
    },
  };
  let active = record;
  const patches = [];
  const ends = [];
  const gizmo = createCalibrationGizmo({
    renderer,
    getActiveRecord: () => active,
    applyPatch: (patch, pinned) => patches.push({ patch, pinned }),
    endPatch: (pinned) => ends.push(pinned),
  });
  t.after(() => {
    gizmo.destroy();
    display.destroy();
    harness.destroy();
  });
  gizmo.setEnabled(true);
  const event = (type, x = 10) =>
    harness.fire(type, {
      position: { x, y: 0 },
      startPosition: { x, y: 0 },
      endPosition: { x, y: 0 },
    });
  return {
    ...harness,
    display,
    gizmo,
    renderer,
    record,
    patches,
    ends,
    event,
    choose: (target = { line: 'cctv-gizmo-move-east' }) =>
      harness.scriptPicks(target),
    switchCamera: () => {
      active = { ...record };
    },
  };
}

for (const makeHarness of CCTV_HARNESSES) {
  const { name } = makeHarness();

  for (const ending of ['release', 'disable', 'destroy', 'selection']) {
    test(`a gizmo ${ending} hands the camera back and ends only the pinned record (${name})`, (t) => {
      const h = setup(makeHarness, t);
      h.choose();
      h.event('down');
      assert.equal(h.gizmo.isDragging(), true);
      assert.deepEqual(h.cameraInputs(), [false]);
      if (ending === 'selection') {
        h.switchCamera();
        h.event('move', 25);
      } else {
        h.event('move', 25);
        assert.equal(h.patches.length, 1);
        assert.equal(h.patches[0].pinned, h.record);
        assert.ok(Math.abs(h.patches[0].patch.offsetEastM - 15) < 1e-8);
        if (ending === 'release') h.event('up');
        if (ending === 'disable') h.gizmo.setEnabled(false);
        if (ending === 'destroy') h.gizmo.destroy();
      }
      assert.deepEqual(h.cameraInputs(), [false, true]);
      assert.deepEqual(h.ends, [h.record]);
      assert.equal(h.gizmo.isDragging(), false);
      h.event('up');
      assert.equal(h.ends.length, 1);
      if (ending === 'selection') assert.equal(h.patches.length, 0);
    });
  }

  test(`gizmo input uses its window and drill to reach an overlapping handle (${name})`, (t) => {
    const h = setup(makeHarness, t);
    h.choose();
    const calls = [];
    const drill = h.engine.picker.drillPick;
    h.engine.picker.pick = (at, width, height) => {
      calls.push(['pick', width, height]);
      return { id: 'foreign', owner: 'foreign' };
    };
    h.engine.picker.drillPick = (at, limit, width, height) => {
      calls.push(['drill', limit, width, height]);
      return drill(at, limit, width, height);
    };
    h.event('down');
    assert.equal(h.gizmo.isDragging(), true);
    assert.deepEqual(calls, [
      ['pick', 14, 14],
      ['drill', 6, 14, 14],
    ]);
    h.event('up');
  });

  test(`the gizmo needs its own handle, not a sibling with its id (${name})`, (t) => {
    const h = setup(makeHarness, t);
    const sibling = h.engine.lines.createLine({
      id: 'sibling',
      pickId: 'cctv-gizmo-move-east',
      widthPx: 1,
      color: [1, 1, 1, 1],
    });
    sibling.setPositions([p(6378137, 0, 0), p(6378137, 1, 0)]);
    h.choose({ line: 'sibling' });
    h.event('down');
    assert.equal(h.gizmo.isDragging(), false);
    h.choose({ set: 'cctv-gizmo-points', index: 0 });
    h.event('down');
    assert.equal(h.gizmo.isDragging(), true, 'an arrow tip drags its arrow');
    sibling.destroy();
  });

  test(`the gizmo draws eight handles and releases only those (${name})`, (t) => {
    const h = setup(makeHarness, t);
    const foreign = h.engine.lines.createLine({
      id: 'foreign',
      widthPx: 1,
      color: [1, 1, 1, 1],
    });
    const lines = h.engine.lines.list().filter(({ id }) => id !== 'foreign');
    assert.deepEqual(
      lines.map(({ id }) => id),
      [
        'cctv-gizmo-ring-heading',
        'cctv-gizmo-ring-pitch',
        'cctv-gizmo-move-east',
        'cctv-gizmo-move-north',
        'cctv-gizmo-move-up',
      ],
    );
    assert.ok(lines.every(({ shown }) => shown));
    assert.equal(lines[0].points, 97);
    const [points] = h.engine.movers.list();
    assert.deepEqual(
      { id: points.id, kind: points.kind, count: points.count },
      { id: 'cctv-gizmo-points', kind: 'point', count: 6 },
    );
    {
      const ring = h.engine.fake.line('cctv-gizmo-ring-heading');
      assert.ok(
        Math.abs(
          geo.cartesian3.distance(
            p(...ring.positions.slice(0, 3)),
            h.record.frustumPositions.mount,
          ) - 12,
        ) < 1e-6,
      );
      const east = h.lineState('cctv-gizmo-move-east');
      assert.equal(east.widthPx, 12);
      assert.equal(east.arrow, true);
      assert.ok(Math.abs(east.depthFailAlpha - 0.45) < 1e-6);
      const heading = h.lineState('cctv-gizmo-ring-heading');
      assert.ok(Math.abs(heading.color[3] - 0.9) < 1e-6);
      assert.ok(Math.abs(heading.depthFailAlpha - 0.5) < 1e-6);
      const set = h.engine.fake.moverSet('cctv-gizmo-points');
      assert.equal(set.options.depthTest, 'always');
      assert.equal(set.options.order, 100);
      assert.deepEqual(set.options.point.outlineColor, [0, 0, 0, 0.7]);
      assert.equal(set.options.point.outlinePx, 2);
      assert.equal(set.store.pickIds[0], 'cctv-gizmo-move-east');
      assert.ok(Math.abs(set.store.positions[1] - 19.2) < 1e-6);
      near(set.store.scales[0] * set.options.point.sizePx, 14, 'tip size');
      near(set.store.scales[3] * set.options.point.sizePx, 13, 'range size');
    }
    h.gizmo.destroy();
    h.gizmo.destroy();
    assert.deepEqual(
      h.engine.lines.list().map(({ id }) => id),
      ['foreign'],
    );
    assert.equal(h.engine.movers.list().length, 0);
    assert.equal(h.canvas.style.cursor, '');
    foreign.destroy();
  });

  test(`hovering a handle grows it and shows the grab cursor (${name})`, (t) => {
    const h = setup(makeHarness, t);
    h.choose({ set: 'cctv-gizmo-points', index: 3 });
    h.event('move');
    assert.equal(h.canvas.style.cursor, 'grab');
    const size = (index) =>
      h.engine.fake.moverSet('cctv-gizmo-points').store.scales[index] * 10;
    near(size(3), 17, 'the hovered range handle');
    near(size(0), 10, 'an arrow tip takes the handle size');
    near(size(4), 10, 'a field-of-view handle');
  });

  for (const cancel of ['pointercancel', 'blur']) {
    test(`a ${cancel} ends a pinned drag and releases the camera (${name})`, (t) => {
      const h = setup(makeHarness, t);
      h.choose();
      h.event('down');
      const target =
        cancel === 'blur' ? h.canvas.ownerDocument.defaultView : h.canvas;
      target.dispatchEvent(new Event(cancel));
      assert.equal(h.gizmo.isDragging(), false);
      assert.deepEqual(h.cameraInputs(), [false, true]);
      assert.deepEqual(h.ends, [h.record]);
      h.gizmo.destroy();
      target.dispatchEvent(new Event(cancel));
      assert.equal(h.ends.length, 1);
    });
  }

  test(`a second down cannot start another drag (${name})`, (t) => {
    const h = setup(makeHarness, t);
    h.choose();
    h.event('down');
    h.event('down');
    h.event('up');
    assert.deepEqual(h.cameraInputs(), [false, true]);
    assert.deepEqual(h.ends, [h.record]);
  });

  test(`a handle id another owner holds stops the gizmo cleanly (${name})`, (t) => {
    const h = setup(makeHarness, t);
    assert.throws(
      () => h.renderer.createPoint('move-east', IDLE_CAMERA_COLOR, 10),
      /already owned/,
    );
    h.gizmo.destroy();
    const sibling = h.engine.lines.createLine({
      id: 'cctv-gizmo-move-east',
      widthPx: 1,
      color: [1, 1, 1, 1],
    });
    assert.throws(
      () =>
        createCalibrationGizmo({
          renderer: h.display.createGizmoRenderer(),
          getActiveRecord: () => null,
          applyPatch() {},
          endPatch() {},
        }),
      /already exists/,
    );
    assert.deepEqual(
      h.engine.lines.list().map(({ id }) => id),
      ['cctv-gizmo-move-east'],
    );
    assert.equal(h.engine.movers.list().length, 0);
    sibling.destroy();
  });

  test(`a destroyed gizmo drops its input and listeners (${name})`, (t) => {
    const h = setup(makeHarness, t);
    let cancels = 0;
    let moves = 0;
    h.renderer.on('cancel', () => cancels++);
    h.renderer.on('move', () => moves++);
    h.canvas.dispatchEvent(new Event('pointercancel'));
    h.canvas.ownerDocument.defaultView.dispatchEvent(new Event('blur'));
    h.event('move');
    assert.equal(cancels, 2);
    assert.equal(moves, 1);
    h.renderer.setCursor('grabbing');
    h.gizmo.destroy();
    h.canvas.dispatchEvent(new Event('pointercancel'));
    h.event('move');
    assert.equal(cancels, 2);
    assert.equal(moves, 1);
    assert.equal(h.canvas.style.cursor, '');
    assert.throws(
      () => h.renderer.createPoint('new', IDLE_CAMERA_COLOR, 10),
      /destroyed/,
    );
  });
}

test("an arrow's shaft goes when its tip cannot be drawn", (t) => {
  const [makeHarness] = CCTV_HARNESSES;
  const harness = makeHarness();
  t.after(() => harness.destroy());
  const display = createCctvDisplay(harness.engine, { state: {} });
  harness.engine.movers.createSet = () => {
    throw new Error('allocation failed');
  };
  const renderer = display.createGizmoRenderer();
  const color = { withAlpha: () => color, rgba: () => [1, 1, 1, 1], alpha: 1 };
  assert.throws(
    () => renderer.createLine('east', color, 8, true),
    /allocation failed/,
  );
  assert.equal(harness.engine.lines.list().length, 0);
  display.destroy();
});

test('a handle construction failure releases already-created resources', () => {
  const handles = new Set();
  let destroys = 0;
  const renderer = {
    createLine(part) {
      if (part === 'move-east') throw new Error('ID already owned');
      const handle = { part };
      handles.add(handle);
      return handle;
    },
    destroy() {
      destroys++;
      handles.clear();
    },
  };
  assert.throws(() => createCalibrationGizmo({ renderer }), /already owned/);
  assert.equal(handles.size, 0);
  assert.equal(destroys, 1);
});
