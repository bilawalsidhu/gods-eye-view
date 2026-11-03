import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { createCountRenderer, WELL_DETAIL_HEIGHT } from './countRenderer.js';
const view = {
  schemaVersion: 1,
  kind: 'gev-well-count-view',
  total: 900,
  degrees: 2,
  coverageComplete: false,
  cells: [{ bounds: [0, 0, 2, 2], center: [1, 1], count: 900 }],
};
test('count evidence never allocates a representative well or enables clusters', () => {
  const ds = new Cesium.CustomDataSource();
  const viewer = {
    scene: { postRender: new Cesium.Event() },
    camera: {
      positionCartographic: { height: 10000 },
      moveEnd: new Cesium.Event(),
      flyTo() {
        throw Error('unexpected flight');
      },
    },
  };
  const renderer = createCountRenderer(viewer);
  renderer.draw(view, ds);
  assert.equal(ds.entities.values.length, 0);
  assert.equal(ds.clustering.enabled, false);
  assert.equal(renderer.zoom({ id: 'fake' }), false);
  renderer.clear();
  renderer.clear();
});
test('exact record positions survive and obey the outer visibility gate', () => {
  const ds = new Cesium.CustomDataSource();
  const entity = ds.entities.add({
    id: 'record',
    position: Cesium.Cartesian3.fromDegrees(1, 1),
  });
  const frame = new Cesium.Event();
  const viewer = {
    scene: { postRender: frame },
    camera: {
      positionCartographic: { height: 10000 },
      moveEnd: new Cesium.Event(),
    },
  };
  const renderer = createCountRenderer(viewer);
  renderer.draw({ ...view, cells: [] }, ds, true);
  assert.equal(ds.entities.values[0], entity);
  assert.equal(ds.show, true);
  viewer.camera.positionCartographic.height = WELL_DETAIL_HEIGHT + 1;
  frame.raiseEvent();
  assert.equal(ds.show, false);
  viewer.camera.positionCartographic.height = 10000;
  frame.raiseEvent();
  assert.equal(ds.show, true);
  renderer.clear();
  assert.equal(frame.numberOfListeners, 0);
});

test('record actions publish current entities without DOM ownership and release on broad views', () => {
  const ds = new Cesium.CustomDataSource();
  const add = () =>
    ds.entities.add({
      id: 'same',
      name: 'record',
      position: Cesium.Cartesian3.fromDegrees(1, 1),
      billboard: { image: 'fixture' },
    });
  add();
  const frame = new Cesium.Event();
  const viewer = {
    scene: {
      postRender: frame,
      canvas: { clientWidth: 1000, clientHeight: 800 },
      cartesianToCanvasCoordinates: () => ({ x: 500, y: 400 }),
    },
    camera: {
      positionCartographic: { height: 10000 },
      moveEnd: new Cesium.Event(),
    },
  };
  let presentation, selected;
  const renderer = createCountRenderer(viewer, {
    publishRecords: (view) => {
      presentation = view;
    },
    onSelectRecord: (entity) => {
      selected = entity;
    },
  });
  renderer.draw({ ...view, cells: [] }, ds, true);
  assert.deepEqual(presentation.records, [{ id: 'same', label: 'record' }]);
  presentation.focus('same', true);
  assert.equal(ds.entities.getById('same').billboard.scale.getValue(), 1.8);
  ds.entities.removeAll();
  const replacement = add();
  renderer.draw({ ...view, cells: [] }, ds, true);
  presentation.select('same');
  assert.equal(selected, replacement);
  viewer.camera.positionCartographic.height = WELL_DETAIL_HEIGHT + 1;
  frame.raiseEvent();
  assert.equal(presentation, null);
  renderer.clear();
  assert.equal(frame.numberOfListeners, 0);
});
