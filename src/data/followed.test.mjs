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

/** A viewer whose `trackedEntity` behaves as Cesium's setter does. */
function trackingViewer() {
  const trackedEntityChanged = new Cesium.Event();
  let tracked;
  return {
    trackedEntityChanged,
    get trackedEntity() {
      return tracked;
    },
    set trackedEntity(value) {
      if (tracked === value) return;
      tracked = value;
      trackedEntityChanged.raiseEvent(value);
    },
  };
}

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

test('a layer’s own tracked entity is seen through its entity record', () => {
  const viewer = trackingViewer();
  assert.equal(followedOf(viewer), null);
  assert.equal(isFollowing(viewer), false);
  const entity = new Cesium.Entity({ id: 'e1', name: 'N1' });
  const record = entityRecord(entity);
  record.trackedId = 'flights:abc';
  record.displayPosition = () => ({ x: 1, y: 2, z: 3 });
  record.sprite = { width: 28 };
  viewer.trackedEntity = entity;
  const followed = followedOf(viewer);
  assert.equal(followed, followedOf(viewer), 'the same view each time');
  assert.equal(followed.key, 'flights:abc');
  assert.equal(followed.name, 'N1');
  assert.deepEqual(followed.displayPosition(), { x: 1, y: 2, z: 3 });
  assert.equal(followed.sprite.width, 28);
  assert.equal(followed.entity, entity);
  viewer.trackedEntity = new Cesium.Entity({ id: 'plain' });
  assert.equal(followedOf(viewer).key, 'entity:plain', 'no tracked id');
});

test('a port follow comes before any tracked entity, and is the target itself', (t) => {
  const viewer = trackingViewer();
  const camera = followingPort();
  t.after(bindRenderer(viewer, { camera }));
  viewer.trackedEntity = new Cesium.Entity({ id: 'helper' });
  const target = { key: 'flights:abc', position: () => null };
  camera.follow(target);
  assert.equal(followedOf(viewer), target);
});

test('onFollowChanged fires once per change, from either source', (t) => {
  const viewer = trackingViewer();
  const camera = followingPort();
  t.after(bindRenderer(viewer, { camera }));
  const seen = [];
  const off = onFollowChanged(viewer, (f) => seen.push(f?.key ?? null));
  const target = { key: 'flights:abc' };
  // A port follow on Cesium sets trackedEntity too: still one change.
  camera.follow(target);
  // Ending it, Cesium clears its tracking before the port announces.
  viewer.trackedEntity = undefined;
  camera.follow(null);
  const entity = new Cesium.Entity({ id: 'legacy' });
  viewer.trackedEntity = entity;
  viewer.trackedEntity = entity;
  off();
  viewer.trackedEntity = undefined;
  assert.deepEqual(seen, ['flights:abc', null, 'entity:legacy']);
});

test('stopFollowing ends a port follow, or a layer’s own tracking', (t) => {
  const viewer = trackingViewer();
  viewer.trackedEntity = new Cesium.Entity({ id: 'legacy' });
  stopFollowing(viewer);
  assert.equal(viewer.trackedEntity, undefined);
  const camera = followingPort();
  t.after(bindRenderer(viewer, { camera }));
  camera.follow({ key: 'k' });
  stopFollowing(viewer);
  assert.equal(camera.followed, null);
  stopFollowing(null);
});

test('a renderer bound after subscribing is still heard', (t) => {
  const viewer = { trackedEntityChanged: new Cesium.Event() };
  const seen = [];
  onFollowChanged(viewer, (f) => seen.push(f?.key ?? null));
  const camera = followingPort();
  t.after(bindRenderer(viewer, { camera }));
  // Any change re-resolves the port; a Cesium follow raises one.
  viewer.trackedEntityChanged.raiseEvent();
  camera.follow({ key: 'k' });
  camera.follow(null);
  assert.deepEqual(seen, ['k', null]);
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

test('resumeFollowing follows a port target again, or re-tracks an entity', (t) => {
  const viewer = trackingViewer();
  const entity = new Cesium.Entity({ id: 'legacy' });
  viewer.trackedEntity = entity;
  const legacy = followedOf(viewer);
  stopFollowing(viewer);
  resumeFollowing(viewer, legacy);
  assert.equal(viewer.trackedEntity, entity);
  assert.equal(followedOf(viewer), legacy);
  viewer.trackedEntity = undefined;
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

test('followedPosition prefers the display cache over the entity position', () => {
  const at = new Cesium.Cartesian3(4, 5, 6);
  const viewer = { clock: { currentTime: Cesium.JulianDate.now() } };
  const entity = new Cesium.Entity({ id: 'e', position: at });
  const view = entityFollowTarget(entity, {});
  assert.deepEqual(followedPosition(viewer, view), at);
  entityRecord(entity).displayPosition = () => ({ x: 7, y: 8, z: 9 });
  assert.deepEqual(followedPosition(viewer, view), { x: 7, y: 8, z: 9 });
  assert.equal(followedPosition(viewer, null), null);
});
