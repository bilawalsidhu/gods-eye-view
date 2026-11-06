import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';
import { entityRecord } from './entityRecords.js';
import {
  followedOf,
  isFollowing,
  onFollowChanged,
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
