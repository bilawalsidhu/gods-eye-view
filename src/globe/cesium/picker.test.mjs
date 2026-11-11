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
  const drilled = picker.drillPick(geo.cartesian2.create(1, 1), 3, 5, 7);
  assert.deepEqual(
    drilled.map(({ id, primitive }) => [id, primitive]),
    [
      ['a', 1],
      [undefined, 2],
    ],
  );
  assert.ok('id' in drilled[1]);
  const [screen, limit, width, height] =
    viewer.callsOf('scene.drillPick')[0].args;
  assert.ok(screen instanceof Cesium.Cartesian2);
  assert.deepEqual([limit, width, height], [3, 5, 7]);
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

test('pick results carry 3D tile content for surface checks', () => {
  const { picker, scene } = setup();
  const content = { name: 'tile content' };
  const tileset = { isCesium3DTileset: true };
  scene.pick = () => ({ content, primitive: tileset });
  const picked = picker.pick(geo.cartesian2.create(1, 1));
  assert.equal(picked.content, content);
  assert.equal(picked.id, undefined);
  assert.equal(picked.primitive, tileset);
  scene.pick = () => ({ id: 'entity', primitive: {} });
  assert.equal(picker.pick(geo.cartesian2.create(1, 1)).content, undefined);
});

test('pickGlobe asks the globe along the camera pick ray and returns geo', () => {
  const { viewer, picker, scene } = setup();
  const hit = picker.pickGlobe(geo.cartesian2.create(3, 4));
  assert.ok(!(hit instanceof Cesium.Cartesian3));
  assert.deepEqual([hit.x, hit.y, hit.z], [6378137, 3, 4]);
  const [screen] = viewer.callsOf('camera.getPickRay')[0].args;
  assert.ok(screen instanceof Cesium.Cartesian2);
  assert.equal(screen.toString(), '(3, 4)');
  const [ray, pickedScene] = viewer.callsOf('globe.pick')[0].args;
  assert.ok(ray instanceof Cesium.Ray);
  assert.equal(pickedScene, scene);
  scene.globe.pick = () => undefined;
  assert.equal(picker.pickGlobe(geo.cartesian2.create(1, 1)), undefined);
  scene.globe.pick = () => {
    throw new Error('no ray');
  };
  assert.equal(picker.pickGlobe(geo.cartesian2.create(1, 1)), undefined);
  scene.globe = undefined;
  assert.equal(picker.pickGlobe(geo.cartesian2.create(1, 1)), undefined);
});

test('a follow-proxy top pick falls through to the first pick under it with an id', () => {
  const viewer = createFakeViewer();
  const proxy = { primitive: 'proxy-point', id: { gevFollowProxy: true } };
  const tile = { primitive: 'tileset', content: {} };
  const flight = { primitive: 'flight-billboard', id: 'ae01ce' };
  const { picker } = createCesiumPicker(viewer);
  viewer.scene.pick = () => proxy;
  viewer.scene.drillPick = () => [proxy, tile, flight];
  assert.equal(picker.pick(geo.cartesian2.create(1, 1)).id, 'ae01ce');
  assert.deepEqual(
    picker.drillPick(geo.cartesian2.create(1, 1)).map((p) => p.primitive),
    ['tileset', 'flight-billboard'],
    'the follow proxy is never picked',
  );
  // Nothing under it with an id: the first kept result (a tile).
  viewer.scene.drillPick = () => [proxy, tile];
  assert.equal(picker.pick(geo.cartesian2.create(1, 1)).primitive, 'tileset');
  viewer.scene.drillPick = () => [proxy];
  assert.equal(picker.pick(geo.cartesian2.create(1, 1)), undefined);
});

test('picks of movers and lines name their owner and instance and return the pickId', () => {
  const viewer = createFakeViewer();
  const billboard = { name: 'billboard' };
  const polyline = { name: 'line primitive' };
  // Cesium's own id on the billboard is stale; the pickId comes from identify.
  viewer.scene.pick = () => ({ primitive: billboard, id: 'stale' });
  viewer.scene.drillPick = () => [
    { primitive: billboard, id: 'stale' },
    { primitive: polyline, id: 'orbit' },
    { primitive: {}, id: 'other' },
  ];
  const { picker } = createCesiumPicker(viewer, {
    identify: (raw) =>
      raw.primitive === billboard
        ? { owner: 'flights', instance: 7, id: 'ae01ce', pickable: true }
        : raw.primitive === polyline
          ? { owner: 'orbit-25544', id: 'orbit' }
          : null,
  });
  const picked = picker.pick({ x: 1, y: 2 });
  assert.equal(picked.id, 'ae01ce');
  assert.equal(picked.owner, 'flights');
  assert.equal(picked.instance, 7);
  assert.equal(picked.object.id, 'stale', 'the Cesium result rides along');
  const drilled = picker.drillPick({ x: 1, y: 2 }, 5);
  assert.deepEqual(
    drilled.map(({ id, owner, instance }) => [id, owner, instance]),
    [
      ['ae01ce', 'flights', 7],
      ['orbit', 'orbit-25544', undefined],
      ['other', undefined, undefined],
    ],
  );
  assert.equal('instance' in drilled[1], false);
});

test('picks of an unpickable set or an instance behind the horizon are dropped', () => {
  const viewer = createFakeViewer();
  const quiet = { primitive: 'quiet-billboard', id: 'q' };
  const behind = { primitive: 'far-billboard', id: 'f' };
  const proxy = { primitive: 'proxy-point', id: { gevFollowProxy: true } };
  const tile = { primitive: 'tileset', content: {} };
  const flight = { primitive: 'flight-billboard', id: 'raw' };
  const { picker } = createCesiumPicker(viewer, {
    identify: (picked) =>
      picked === quiet
        ? { owner: 'quiet', instance: 0, id: 'q', pickable: false }
        : picked === behind
          ? { owner: 'flights', instance: 1, id: 'f', visible: false }
          : picked === flight
            ? { owner: 'flights', instance: 3, id: 'ae01ce', visible: true }
            : null,
  });
  viewer.scene.pick = () => quiet;
  viewer.scene.drillPick = () => [quiet, behind, proxy, tile, flight];
  const picked = picker.pick(geo.cartesian2.create(1, 1));
  assert.equal(picked.id, 'ae01ce', 'the first kept pick under it with an id');
  assert.equal(picked.owner, 'flights');
  assert.deepEqual(
    picker.drillPick(geo.cartesian2.create(1, 1)).map((p) => p.primitive),
    ['tileset', 'flight-billboard'],
  );
  // Nothing under it with an id: the first kept result (a tile).
  viewer.scene.pick = () => behind;
  viewer.scene.drillPick = () => [behind, tile];
  assert.equal(picker.pick(geo.cartesian2.create(1, 1)).primitive, 'tileset');
});
