import test from 'node:test';
import assert from 'node:assert/strict';
import { createCesiumRender, RENDER_OWNER } from './render.js';
import { createFakeViewer } from './testing/fakeViewer.mjs';

test('request goes through the injected requestRender with a reason', () => {
  const viewer = createFakeViewer();
  const reasons = [];
  const { render } = createCesiumRender(viewer, {
    requestRender: (reason) => reasons.push(reason),
  });
  render.request();
  render.request('world-overlay');
  assert.deepEqual(reasons, [RENDER_OWNER, 'world-overlay']);
  assert.equal(viewer.callsOf('scene.requestRender').length, 0);
});

test('creation disables time-driven renders and preserves the current mode', () => {
  const viewer = createFakeViewer();
  viewer.scene.maximumRenderTimeChange = 0.5;
  viewer.scene.requestRenderMode = false;
  createCesiumRender(viewer);
  assert.equal(viewer.scene.requestRenderMode, false);
  assert.equal(viewer.scene.maximumRenderTimeChange, Infinity);
});

test('render mode, requests and destruction affect only the owning scene', () => {
  const first = createFakeViewer();
  const second = createFakeViewer();
  const a = createCesiumRender(first);
  const b = createCesiumRender(second);
  a.render.setContinuous(true);
  b.render.setContinuous(true);
  assert.equal(a.render.isContinuous(), true);
  assert.equal(b.render.isContinuous(), true);
  a.render.setContinuous(false);
  assert.equal(a.render.isContinuous(), false);
  assert.equal(b.render.isContinuous(), true);
  a.render.request('world-overlay');
  assert.equal(first.callsOf('scene.requestRender').length, 1);
  assert.equal(second.callsOf('scene.requestRender').length, 0);
  a.destroy();
  assert.equal(b.render.isContinuous(), true);
  b.destroy();
  assert.equal(b.render.isContinuous(), false);
});
