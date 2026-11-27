import test from 'node:test';
import assert from 'node:assert/strict';
import * as governor from '../../renderGovernor.js';
import { framePortFor } from '../../testSupport/fakeFramePort.mjs';
import { createProjection } from './projection.js';

test('a playing CCTV video is not capped by a 15 fps satellites hold', (t) => {
  governor._resetRenderGovernorForTest();
  governor.setFrameRateCap(60);
  const scene = { requestRenderMode: false, requestRender() {} };
  governor.installRenderGovernor(framePortFor(scene));
  const queue = [];
  const orig = [
    globalThis.requestAnimationFrame,
    globalThis.cancelAnimationFrame,
  ];
  globalThis.requestAnimationFrame = (s) => queue.push(s);
  globalThis.cancelAnimationFrame = () => queue.splice(0);
  t.after(() => {
    [globalThis.requestAnimationFrame, globalThis.cancelAnimationFrame] = orig;
    governor._resetRenderGovernorForTest();
  });
  governor.holdContinuousRender('satellites', { maxFps: 15 });
  assert.equal(scene.targetFps, 15);
  const video = {
    readyState: 4,
    paused: false,
    videoWidth: 640,
    videoHeight: 360,
  };
  const record = {
    camera: { id: 'c', name: 'c' },
    projection: {
      mode: 'video',
      video,
      plane: { id: 'p', show: true, source: { video } },
    },
  };
  const state = {
    _viewer: {},
    _enabled: true,
    _showProjection: true,
    _projectionRaf: 0,
    _activeCameraId: 'c',
  };
  const parts = {
    model: {
      projectionLoopIsNeeded: () => true,
      safeNumber: (v, f) => (Number.isFinite(v) ? v : f),
    },
    rendering: { refreshCctvFocusStyles() {} },
    selection: { getActiveRecord: () => record },
    frames: { refreshProjectionTextures() {} },
    drawSets: { writePlane() {} },
  };
  const projection = createProjection({
    state,
    services: { render: governor },
    parts,
    source: {},
  });
  projection.startProjectionLoop();
  for (let i = 0; i < 3; i++) queue.shift()?.();
  assert.equal(
    scene.targetFps,
    60,
    `video plays at ${scene.targetFps} fps under a 60 fps Display cap`,
  );
  projection.stopProjectionLoop();
});

test('the video hold goes when the video pauses, stalls, hides, or the loop stops', (t) => {
  governor._resetRenderGovernorForTest();
  governor.setFrameRateCap(60);
  const scene = { requestRenderMode: false, requestRender() {} };
  governor.installRenderGovernor(framePortFor(scene));
  const queue = [];
  const orig = [
    globalThis.requestAnimationFrame,
    globalThis.cancelAnimationFrame,
  ];
  globalThis.requestAnimationFrame = (s) => queue.push(s);
  globalThis.cancelAnimationFrame = () => queue.splice(0);
  t.after(() => {
    [globalThis.requestAnimationFrame, globalThis.cancelAnimationFrame] = orig;
    governor._resetRenderGovernorForTest();
  });
  governor.holdContinuousRender('satellites', { maxFps: 15 });
  const video = { readyState: 4, paused: false, ended: false };
  const plane = { id: 'p', show: true, source: { video } };
  const record = {
    camera: { id: 'c', name: 'c' },
    projection: { mode: 'video', video, plane },
  };
  const state = {
    _viewer: {},
    _enabled: true,
    _showProjection: true,
    _projectionRaf: 0,
    _activeCameraId: 'c',
  };
  const parts = {
    model: { projectionLoopIsNeeded: () => true },
    rendering: { refreshCctvFocusStyles() {} },
    selection: { getActiveRecord: () => record },
  };
  const projection = createProjection({
    state,
    services: { render: governor },
    parts,
    source: {},
  });
  const held = () =>
    governor.getRenderGovernorDiagnostics().holds.includes('cctv-projection');
  const step = () => queue.shift()?.();
  projection.startProjectionLoop();
  step();
  assert.equal(held(), true, 'playing');
  video.paused = true;
  step();
  assert.equal(held(), false, 'paused');
  assert.equal(scene.targetFps, 15);
  video.paused = false;
  step();
  assert.equal(held(), true, 'playing again');
  video.readyState = 2;
  step();
  assert.equal(held(), false, 'stalled');
  video.readyState = 4;
  step();
  plane.show = false;
  step();
  assert.equal(held(), false, 'hidden');
  plane.show = true;
  step();
  assert.equal(held(), true);
  projection.stopProjectionLoop();
  assert.equal(held(), false, 'stopped');
  assert.equal(scene.targetFps, 15);
});
