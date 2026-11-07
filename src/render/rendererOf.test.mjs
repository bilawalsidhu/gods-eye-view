import assert from 'node:assert/strict';
import test from 'node:test';
import {
  bindRenderer,
  cameraOf,
  findCamera,
  findCredits,
  provideUnboundCamera,
  provideUnboundCredits,
  rendererOf,
} from './rendererOf.js';

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

test('with no renderer bound, cameraOf builds one camera per scene until a renderer is bound', (t) => {
  t.after(() => provideUnboundCamera(null));
  const built = [];
  provideUnboundCamera((host) => {
    if (!host.camera) return null;
    const entry = { port: { id: built.length }, disposed: 0 };
    entry.dispose = () => (entry.disposed += 1);
    built.push(entry);
    return entry;
  });
  const viewer = { camera: {} };
  assert.equal(cameraOf(viewer), built[0].port);
  assert.equal(cameraOf(viewer), built[0].port, 'kept, not rebuilt');
  assert.equal(built.length, 1);
  assert.throws(
    () => cameraOf({}),
    /no renderer camera/,
    'nothing to build over',
  );
  assert.equal(findCamera({}), null);
  assert.equal(findCamera(null), null);

  const camera = { pose() {} };
  const unbind = bindRenderer(viewer, { camera });
  assert.equal(
    built[0].disposed,
    1,
    'the renderer supersedes the built camera',
  );
  assert.equal(cameraOf(viewer), camera);
  unbind();
  assert.equal(cameraOf(viewer), built[1].port, 'unbound again: a fresh one');
});

test('a destroyed scene gets no built camera, and lets go of the one it had', (t) => {
  t.after(() => provideUnboundCamera(null));
  let disposed = 0;
  provideUnboundCamera(() => ({ port: {}, dispose: () => (disposed += 1) }));
  let destroyed = false;
  const viewer = { isDestroyed: () => destroyed };
  cameraOf(viewer);
  destroyed = true;
  assert.throws(() => cameraOf(viewer), /destroyed/);
  assert.equal(disposed, 1);
  assert.equal(findCamera(viewer), null, 'findCamera answers null instead');
  assert.throws(() => cameraOf(viewer), /destroyed/);
  assert.equal(disposed, 1, 'once');
});

test('with no renderer bound, findCredits builds one port per scene and keeps it working once one is', (t) => {
  t.after(() => provideUnboundCredits(null));
  const built = [];
  provideUnboundCredits((host) => {
    if (!host.creditDisplay) return null;
    const entry = { port: { id: built.length }, disposed: 0, released: 0 };
    entry.dispose = () => (entry.disposed += 1);
    entry.release = () => (entry.released += 1);
    built.push(entry);
    return entry;
  });
  const viewer = { creditDisplay: {} };
  assert.equal(findCredits(viewer), built[0].port);
  assert.equal(findCredits(viewer), built[0].port, 'kept, not rebuilt');
  assert.equal(findCredits({}), null, 'nothing to build over');
  assert.equal(findCredits(null), null);

  const credits = { list: () => [] };
  const unbind = bindRenderer(viewer, { credits });
  assert.equal(findCredits(viewer), credits);
  assert.equal(
    built[0].disposed,
    0,
    'the credits added through the built port stay until their Off',
  );
  assert.equal(built[0].released, 1, 'but it stops following the frames');
  unbind();
  assert.equal(
    findCredits(viewer),
    built[1].port,
    'unbound again: a fresh one',
  );

  let destroyed = false;
  const gone = { creditDisplay: {}, isDestroyed: () => destroyed };
  const port = findCredits(gone);
  destroyed = true;
  assert.equal(findCredits(gone), null);
  assert.equal(built.find((entry) => entry.port === port).disposed, 1);
});
