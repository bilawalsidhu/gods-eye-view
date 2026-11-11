import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';
import { entityRecord } from './entityRecords.js';
import {
  entityFollowTarget,
  followedOf,
  followedPosition,
  isFollowing,
  onFollowChanged,
  resumeFollowing,
  stopFollowing,
} from './followed.js';
import { bindRenderer } from '../render/rendererOf.js';
import { createCameraEvents } from '../render/camera/events.js';
import { createStubRenderer } from '../render/stub/index.js';

/** A camera port that follows, for a viewer bound to a renderer. */
function followingPort() {
  const events = createCameraEvents({ pose: () => ({}), report: () => {} });
  let followed = null;
  return {
    on: (event, cb) => events.on(event, cb),
    get followed() {
      return followed;
    },
    follow(target) {
      if (followed === target) return;
      followed = target;
      events.emit('followChanged');
    },
  };
}

test('what the camera port follows is the target itself', (t) => {
  const viewer = {};
  assert.equal(followedOf(viewer), null, 'nothing without a renderer');
  const camera = followingPort();
  t.after(bindRenderer(viewer, { camera }));
  assert.equal(followedOf(viewer), null);
  assert.equal(isFollowing(viewer), false);
  const target = { key: 'flights:abc', position: () => null };
  camera.follow(target);
  assert.equal(followedOf(viewer), target);
  assert.equal(isFollowing(viewer), true);
});

test('onFollowChanged fires once per change', (t) => {
  const viewer = {};
  const camera = followingPort();
  t.after(bindRenderer(viewer, { camera }));
  const seen = [];
  const off = onFollowChanged(viewer, (f) => seen.push(f?.key ?? null));
  const target = { key: 'flights:abc' };
  camera.follow(target);
  camera.follow(target);
  camera.follow(null);
  off();
  camera.follow({ key: 'after' });
  assert.deepEqual(seen, ['flights:abc', null]);
});

test('stopFollowing ends a port follow', (t) => {
  const viewer = {};
  stopFollowing(viewer);
  const camera = followingPort();
  t.after(bindRenderer(viewer, { camera }));
  camera.follow({ key: 'k' });
  stopFollowing(viewer);
  assert.equal(camera.followed, null);
  stopFollowing(null);
});

test('an entity follow target reads its entity record live', () => {
  const entity = new Cesium.Entity({ id: 'drawn', name: 'N2' });
  const position = () => ({ x: 1, y: 2, z: 3 });
  const target = entityFollowTarget(entity, { position, minRange: 150 });
  assert.equal(target.key, 'entity:drawn');
  entityRecord(entity).trackedId = 'flights:abc';
  entityRecord(entity).labelModel = { title: 'N2' };
  assert.equal(target.key, 'flights:abc');
  assert.equal(target.labelModel.title, 'N2');
  assert.equal(target.entity, entity);
  assert.equal(target.position, position);
  assert.equal(target.minRange, 150);
  const keyed = entityFollowTarget(entity, { key: 'flights:given' });
  assert.equal(keyed.key, 'flights:given', 'a camera field takes the place');
  assert.equal(keyed.labelModel.title, 'N2');
});

test('resumeFollowing follows a port target again', (t) => {
  const viewer = {};
  const camera = followingPort();
  t.after(bindRenderer(viewer, { camera }));
  const target = entityFollowTarget(new Cesium.Entity({ id: 'p' }), {});
  camera.follow(target);
  stopFollowing(viewer);
  resumeFollowing(viewer, target);
  assert.equal(camera.followed, target);
  resumeFollowing(viewer, null);
  assert.equal(camera.followed, target);
});

test('followedPosition reads the display cache', () => {
  const entity = new Cesium.Entity({ id: 'e' });
  const view = entityFollowTarget(entity, {});
  assert.equal(followedPosition({}, view), null, 'none without a cache');
  entityRecord(entity).displayPosition = () => ({ x: 7, y: 8, z: 9 });
  assert.deepEqual(followedPosition({}, view), { x: 7, y: 8, z: 9 });
  assert.equal(followedPosition({}, null), null);
});

test('followedPosition falls back to the target position at scene time', () => {
  const renderer = createStubRenderer();
  const viewer = {};
  bindRenderer(viewer, renderer);
  renderer.frame.setTime(1234);
  const seen = [];
  const target = {
    key: 't',
    frame: 'enu',
    viewFrom: { x: 0, y: 0, z: 1 },
    position: (time) => (seen.push(time), { x: 1, y: 2, z: 3 }),
  };
  assert.deepEqual(followedPosition(viewer, target), { x: 1, y: 2, z: 3 });
  assert.deepEqual(seen, [1234]);
  target.displayPosition = () => ({ x: 4, y: 5, z: 6 });
  assert.deepEqual(followedPosition(viewer, target), { x: 4, y: 5, z: 6 });
});
