import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { createCalibrationGizmo } from '../../data/cctvGizmo.js';
import { createCesiumCctvGizmoRenderer } from './render/cesiumGizmo.js';

function setup(t, initialInputs = true) {
  const actions = new Map();
  const entities = new Cesium.EntityCollection();
  const controller = { enableInputs: initialInputs };
  const canvas = new EventTarget();
  canvas.style = {};
  canvas.ownerDocument = { defaultView: new EventTarget() };
  let picked = null;
  let destroys = 0;
  const viewer = {
    entities,
    scene: {
      canvas,
      screenSpaceCameraController: controller,
      pick: () => picked,
      drillPick: () => [],
    },
    camera: {
      getPickRay: ({ x }) => ({
        origin: new Cesium.Cartesian3(6378237, x, 0),
        direction: new Cesium.Cartesian3(-1, 0, 0),
      }),
    },
  };
  const renderer = createCesiumCctvGizmoRenderer(viewer, {
    createEventHandler: () => ({
      setInputAction: (listener, type) => actions.set(type, listener),
      destroy() {
        destroys++;
        actions.clear();
      },
    }),
  });
  const p = (x, y, z) => new Cesium.Cartesian3(x, y, z);
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
  const patches = [],
    ends = [];
  const gizmo = createCalibrationGizmo({
    renderer,
    getActiveRecord: () => active,
    applyPatch: (patch, pinned) => patches.push({ patch, pinned }),
    endPatch: (pinned) => ends.push(pinned),
  });
  t.after(() => gizmo.destroy());
  gizmo.setEnabled(true);
  const event = (type, x = 10) =>
    actions.get(Cesium.ScreenSpaceEventType[type])?.({
      position: { x, y: 0 },
      endPosition: { x, y: 0 },
    });
  return {
    gizmo,
    renderer,
    record,
    entities,
    controller,
    patches,
    ends,
    canvas,
    event,
    choose: (entity = entities.getById('cctv-gizmo-move-east')) => {
      picked = { id: entity };
    },
    switchCamera: () => {
      active = { ...record };
    },
    destroys: () => destroys,
  };
}

for (const initial of [false, true]) {
  for (const ending of ['release', 'disable', 'destroy', 'selection']) {
    test(`gizmo ${ending} restores initial camera input ${initial} and ends only the pinned record`, (t) => {
      const h = setup(t, initial);
      h.choose();
      h.event('LEFT_DOWN');
      assert.equal(h.gizmo.isDragging(), true);
      assert.equal(h.controller.enableInputs, false);
      if (ending === 'selection') {
        h.switchCamera();
        h.event('MOUSE_MOVE', 25);
      } else {
        h.event('MOUSE_MOVE', 25);
        assert.equal(h.patches.length, 1);
        assert.equal(h.patches[0].pinned, h.record);
        assert.ok(Math.abs(h.patches[0].patch.offsetEastM - 15) < 1e-8);
        if (ending === 'release') h.event('LEFT_UP');
        if (ending === 'disable') h.gizmo.setEnabled(false);
        if (ending === 'destroy') h.gizmo.destroy();
      }
      assert.equal(h.controller.enableInputs, initial);
      assert.deepEqual(h.ends, [h.record]);
      assert.equal(h.gizmo.isDragging(), false);
      h.event('LEFT_UP');
      assert.equal(h.ends.length, 1);
      if (ending === 'selection') assert.equal(h.patches.length, 0);
    });
  }
}

test('native gizmo requires the exact owned entity, not a sibling with its ID', (t) => {
  const h = setup(t);
  const own = h.entities.getById('cctv-gizmo-move-east');
  h.choose({ id: own.id });
  h.event('LEFT_DOWN');
  assert.equal(h.gizmo.isDragging(), false);
  h.choose();
  h.event('LEFT_DOWN');
  assert.equal(h.gizmo.isDragging(), true);
});

test('gizmo builds eight owned handles with pinned native geometry and releases only those', (t) => {
  const h = setup(t);
  const now = Cesium.JulianDate.now();
  assert.equal(h.entities.values.length, 8);
  for (const entity of h.entities.values) assert.equal(entity.show, true);
  const heading = h.entities
    .getById('cctv-gizmo-ring-heading')
    .polyline.positions.getValue(now);
  assert.equal(heading.length, 97);
  assert.ok(
    Math.abs(
      Cesium.Cartesian3.distance(heading[0], h.record.frustumPositions.mount) -
        12,
    ) < 1e-8,
  );
  const east = h.entities.getById('cctv-gizmo-move-east');
  assert.equal(east.polyline.width.getValue(now), 12);
  assert.equal(east.polyline.material.getType(now), 'PolylineArrow');
  assert.ok(Math.abs(east.position.getValue(now).y - 19.2) < 1e-8);
  const sibling = h.entities.add({ id: 'foreign' });
  h.gizmo.destroy();
  h.gizmo.destroy();
  assert.deepEqual(h.entities.values, [sibling]);
  assert.equal(h.destroys(), 1);
});

for (const event of ['pointercancel', 'blur']) {
  test(`gizmo ${event} ends a pinned drag and releases the camera`, (t) => {
    const h = setup(t);
    h.choose();
    h.event('LEFT_DOWN');
    const target =
      event === 'blur' ? h.canvas.ownerDocument.defaultView : h.canvas;
    target.dispatchEvent(new Event(event));
    assert.equal(h.gizmo.isDragging(), false);
    assert.equal(h.controller.enableInputs, true);
    assert.deepEqual(h.ends, [h.record]);
    h.gizmo.destroy();
    target.dispatchEvent(new Event(event));
    assert.equal(h.ends.length, 1);
  });
}

test('a duplicate down cannot overwrite the original camera-input state', (t) => {
  const h = setup(t);
  h.choose();
  h.event('LEFT_DOWN');
  h.event('LEFT_DOWN');
  h.event('LEFT_UP');
  assert.equal(h.controller.enableInputs, true);
  assert.deepEqual(h.ends, [h.record]);
});

test('native gizmo never deletes an unrelated entity with a reserved handle ID', (t) => {
  const h = setup(t);
  const id = 'cctv-gizmo-move-east';
  const own = h.entities.getById(id);
  h.entities.remove(own);
  const sibling = h.entities.add({ id });
  assert.throws(
    () => h.renderer.createPoint('move-east', Cesium.Color.RED, 10),
    /owned|already|exists/i,
  );
  assert.equal(h.entities.getById(id), sibling);
  h.choose(own);
  h.event('LEFT_DOWN');
  assert.equal(h.gizmo.isDragging(), false);
  h.gizmo.destroy();
  assert.equal(h.entities.getById(id), sibling);
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
