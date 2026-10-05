import assert from 'node:assert/strict';
import test from 'node:test';
import {HIT_TEST_STATES,reticleFromPose,requestHitTestSource} from '../src/mr-placement.js';

const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const translated = [...identity.slice(0, 12), 0.4, 0.75, -1.2, 1];

test('a hit-test pose becomes a reticle transform', () => {
  const transform = reticleFromPose(translated);
  assert.ok(Math.abs(transform.position.x - 0.4) < 1e-6);
  assert.ok(Math.abs(transform.position.y - 0.75) < 1e-6);
  assert.ok(Math.abs(transform.position.z + 1.2) < 1e-6);
});

test('a missing or malformed pose yields no transform rather than a bad one', () => {
  assert.equal(reticleFromPose(null), null);
  assert.equal(reticleFromPose(undefined), null);
  assert.equal(reticleFromPose([1, 0, 0]), null, 'a short matrix is not a pose');
});

test('a session without hit testing reports unsupported instead of throwing', async () => {
  assert.deepEqual(await requestHitTestSource({}), { source: null, state: HIT_TEST_STATES.unsupported });
  assert.deepEqual(await requestHitTestSource(null), { source: null, state: HIT_TEST_STATES.unsupported });
});

test('a rejected hit-test request degrades instead of failing the session', async () => {
  // Vision Pro exposes immersive-ar without hit testing; the session must still run.
  const session = {
    requestReferenceSpace: async () => ({}),
    requestHitTestSource: async () => { throw new DOMException('NotSupportedError'); },
  };
  const result = await requestHitTestSource(session);
  assert.equal(result.state, HIT_TEST_STATES.unsupported);
  assert.equal(result.source, null);
});

test('a granted hit-test source is reported ready and bound to the viewer space', async () => {
  let requestedSpace = null;
  const viewer = { name: 'viewer' };
  const session = {
    requestReferenceSpace: async (type) => (type === 'viewer' ? viewer : null),
    requestHitTestSource: async (options) => { requestedSpace = options.space; return { cancel() {} }; },
  };
  const result = await requestHitTestSource(session);
  assert.equal(result.state, HIT_TEST_STATES.ready);
  assert.ok(result.source);
  assert.equal(requestedSpace, viewer, 'hit tests are cast from the viewer, not the floor');
});

test('a source that resolves empty is treated as unsupported', async () => {
  const session = { requestReferenceSpace: async () => ({}), requestHitTestSource: async () => null };
  assert.equal((await requestHitTestSource(session)).state, HIT_TEST_STATES.unsupported);
});
