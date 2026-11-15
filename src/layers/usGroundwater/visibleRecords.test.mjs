import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { createVisibleRecords, WELL_DETAIL_HEIGHT } from './visibleRecords.js';

function scene({ project = () => ({ x: 500, y: 400 }) } = {}) {
  const frame = new Cesium.Event();
  return {
    frame,
    viewer: {
      scene: {
        postRender: frame,
        canvas: { clientWidth: 1000, clientHeight: 800 },
        cartesianToCanvasCoordinates: project,
      },
      camera: { positionCartographic: { height: 10000 } },
    },
  };
}
const addRecord = (ds, id = 'same') =>
  ds.entities.add({
    id,
    name: 'record',
    position: Cesium.Cartesian3.fromDegrees(1, 1),
    billboard: { image: 'fixture' },
  });

test('record positions obey the outer detail-height gate', () => {
  const ds = new Cesium.CustomDataSource();
  const entity = addRecord(ds, 'record');
  const { viewer, frame } = scene();
  const records = createVisibleRecords(viewer);
  records.track(ds);
  assert.equal(ds.entities.values[0], entity);
  assert.equal(ds.show, true);
  viewer.camera.positionCartographic.height = WELL_DETAIL_HEIGHT + 1;
  frame.raiseEvent();
  assert.equal(ds.show, false);
  viewer.camera.positionCartographic.height = 10000;
  frame.raiseEvent();
  assert.equal(ds.show, true);
  records.clear();
  assert.equal(frame.numberOfListeners, 0);
});

test('frames with an unchanged camera do no projection work', () => {
  const ds = new Cesium.CustomDataSource();
  addRecord(ds);
  let projections = 0;
  const { viewer, frame } = scene({
    project: () => (projections++, { x: 1, y: 1 }),
  });
  const records = createVisibleRecords(viewer);
  records.track(ds);
  const afterTrack = projections;
  for (let i = 0; i < 10; i++) frame.raiseEvent();
  assert.equal(projections, afterTrack);
  viewer.camera.positionCartographic.height = 9000;
  frame.raiseEvent();
  assert.equal(projections, afterTrack + 1);
  records.clear();
});

test('record actions publish current entities and release on broad views', () => {
  const ds = new Cesium.CustomDataSource();
  addRecord(ds);
  const { viewer, frame } = scene();
  let presentation, selected;
  const records = createVisibleRecords(viewer, {
    publishRecords: (view) => {
      presentation = view;
    },
    onSelectRecord: (entity) => {
      selected = entity;
    },
  });
  records.track(ds);
  assert.deepEqual(presentation.records, [{ id: 'same', label: 'record' }]);
  presentation.focus('same', true);
  assert.equal(ds.entities.getById('same').billboard.scale.getValue(), 1.8);
  ds.entities.removeAll();
  const replacement = addRecord(ds);
  records.track(ds);
  presentation.select('same');
  assert.equal(selected, replacement);
  viewer.camera.positionCartographic.height = WELL_DETAIL_HEIGHT + 1;
  frame.raiseEvent();
  assert.equal(presentation, null);
  records.clear();
  assert.equal(frame.numberOfListeners, 0);
});
