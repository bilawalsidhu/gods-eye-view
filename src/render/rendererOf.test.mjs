import assert from 'node:assert/strict';
import test from 'node:test';
import { bindRenderer, cameraOf, rendererOf } from './rendererOf.js';

test('a scene finds its renderer until it is unbound', () => {
  const scene = {};
  const renderer = { id: 'r' };
  assert.equal(rendererOf(scene), null);
  assert.equal(rendererOf(null), null);
  const unbind = bindRenderer(scene, renderer);
  assert.equal(rendererOf(scene), renderer);
  assert.throws(() => bindRenderer(scene, { id: 'other' }), /already has/);
  unbind();
  assert.equal(rendererOf(scene), null);
});

test('a stale unbind leaves a later binding alone', () => {
  const scene = {};
  const unbindFirst = bindRenderer(scene, { id: 'first' });
  unbindFirst();
  const second = { id: 'second' };
  bindRenderer(scene, second);
  unbindFirst();
  assert.equal(rendererOf(scene), second);
});

test('cameraOf names the missing renderer instead of returning nothing', () => {
  const scene = {};
  assert.throws(() => cameraOf(scene), /no renderer camera/);
  const camera = { pose() {} };
  const unbind = bindRenderer(scene, { camera });
  assert.equal(cameraOf(scene), camera);
  unbind();
});
