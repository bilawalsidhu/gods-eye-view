import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import * as geo from '../../geo/index.js';
import { createCesiumPicker } from './picker.js';
import { createFakeViewer } from './testing/fakeViewer.mjs';

function setup() {
  const viewer = createFakeViewer();
  const { picker } = createCesiumPicker(viewer);
  return { viewer, picker, scene: viewer.scene };
}

test('pick passes a Cesium window position and keeps id and primitive', () => {
  const { viewer, picker, scene } = setup();
  assert.equal(picker.pick(geo.cartesian2.create(1, 2)), undefined);
  const entity = { name: 'entity' };
  const primitive = { name: 'billboard' };
  const raw = { id: entity, primitive };
  scene.pick = (...args) => {
    viewer.calls.push({ name: 'scene.pick', args });
    return raw;
  };
  const picked = picker.pick(geo.cartesian2.create(3, 4), 5, 6);
  assert.equal(picked.id, entity);
  assert.equal(picked.primitive, primitive);
  assert.equal(picked.object, raw, 'the Cesium pick result rides along');
  const [screen, width, height] = viewer.callsOf('scene.pick')[1].args;
  assert.ok(screen instanceof Cesium.Cartesian2);
  assert.deepEqual([screen.x, screen.y, width, height], [3, 4, 5, 6]);
});

test('drillPick passes the limit and normalises every result', () => {
  const { viewer, picker, scene } = setup();
  scene.drillPick = (...args) => {
    viewer.calls.push({ name: 'scene.drillPick', args });
    return [{ id: 'a', primitive: 1 }, { primitive: 2 }];
  };
  const drilled = picker.drillPick(geo.cartesian2.create(1, 1), 3);
  assert.deepEqual(
    drilled.map(({ id, primitive }) => [id, primitive]),
    [
      ['a', 1],
      [undefined, 2],
    ],
  );
  assert.ok('id' in drilled[1]);
  const [screen, limit] = viewer.callsOf('scene.drillPick')[0].args;
  assert.ok(screen instanceof Cesium.Cartesian2);
  assert.equal(limit, 3);
});

test('pickPosition passes a new Cesium.Cartesian2 per call and returns geo', () => {
  const { viewer, picker, scene } = setup();
  const position = picker.pickPosition(geo.cartesian2.create(7, 8));
  assert.ok(!(position instanceof Cesium.Cartesian3));
  assert.deepEqual([position.x, position.y, position.z], [6378137, 1, 2]);
  picker.pickPosition(geo.cartesian2.create(9, 10));
  const [first, second] = viewer
    .callsOf('scene.pickPosition')
    .map((call) => call.args[0]);
  // Cesium caches pickPosition by windowPosition.toString().
  assert.ok(first instanceof Cesium.Cartesian2);
  assert.notEqual(first, second);
  assert.equal(second.toString(), '(9, 10)');
  scene.pickPosition = () => undefined;
  assert.equal(picker.pickPosition(geo.cartesian2.create(1, 1)), undefined);
  scene.pickPosition = () => {
    throw new Error('depth texture missing');
  };
  assert.equal(picker.pickPosition(geo.cartesian2.create(1, 1)), undefined);
});

test('pickPositionSupported follows the scene', () => {
  const { picker, scene } = setup();
  assert.equal(picker.pickPositionSupported, true);
  scene.pickPositionSupported = false;
  assert.equal(picker.pickPositionSupported, false);
  assert.equal(picker.pickPosition(geo.cartesian2.create(1, 1)), undefined);
});
