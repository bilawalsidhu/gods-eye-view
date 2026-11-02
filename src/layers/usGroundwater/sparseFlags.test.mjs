import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { recordsAtPixel, createRecordPicker } from './recordPicker.js';
const entity = (id, x, y) => ({ id, position: { getValue: () => ({ x, y }) } });
const viewer = { scene: { cartesianToCanvasCoordinates: (p) => p } };
test('coincident source records remain independently selectable in stable order', () => {
  const a = entity('a', 10, 10),
    b = entity('b', 10, 10);
  assert.deepEqual(recordsAtPixel(viewer, [b, a], { x: 10, y: 10 }), [a, b]);
  assert.equal(a.position.getValue().x, 10);
});
test('tolerant picking excludes distant and unprojectable records', () => {
  const a = entity('a', 14, 10),
    b = entity('b', 30, 10);
  assert.deepEqual(
    recordsAtPixel(viewer, [b, a, { id: 'missing' }], { x: 10, y: 10 }),
    [a],
  );
});
test('single record inspection needs no chooser or camera transfer', () => {
  let selected;
  const picker = createRecordPicker((e) => {
    selected = e;
    return true;
  });
  const a = entity('a', 1, 1);
  assert.equal(picker.choose([a]), true);
  assert.equal(selected, a);
  picker.close();
  assert.equal(picker.choose([]), false);
});
