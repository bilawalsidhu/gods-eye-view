import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import test from 'node:test';
import { bindRenderer, findFrame, frameOf } from '../rendererOf.js';
import { renderNow } from './frame.js';

/** A viewer whose scene raises its phases when `tick` is called. */
function fakeViewer() {
  // The camera, as Cesium saw it at its last frame: unmoved since.
  const camera = {
    position: new Cesium.Cartesian3(2e7, 0, 0),
    direction: new Cesium.Cartesian3(-1, 0, 0),
    up: new Cesium.Cartesian3(0, 0, 1),
    right: new Cesium.Cartesian3(0, 1, 0),
    transform: Cesium.Matrix4.IDENTITY,
    frustum: { equalsEpsilon: () => true },
  };
  const scene = {
    camera,
    _view: { _cameraClone: camera },
    maximumRenderTimeChange: Infinity,
    preUpdate: new Cesium.Event(),
    preRender: new Cesium.Event(),
    postRender: new Cesium.Event(),
    requestRenderMode: true,
    requests: 0,
    forced: 0,
    requestRender() {
      this.requests += 1;
      this._renderRequested = true;
    },
    forceRender() {
      this.forced += 1;
      scene.preRender.raiseEvent(scene);
      scene.postRender.raiseEvent(scene);
    },
  };
  const clock = {
    currentTime: Cesium.JulianDate.fromDate(new Date(Date.UTC(2026, 0, 1))),
  };
  const tick = () => {
    scene._renderRequested = false;
    scene.preUpdate.raiseEvent(scene, clock.currentTime);
    scene.preRender.raiseEvent(scene, clock.currentTime);
    scene.postRender.raiseEvent(scene, clock.currentTime);
  };
  return { scene, clock, tick, useDefaultRenderLoop: true };
}

test('a viewer of its own, with no renderer bound, runs frames through a built port over its loop', async () => {
  const viewer = fakeViewer();
  const frame = frameOf(viewer);
  assert.equal(findFrame(viewer), frame, 'one per viewer');
  assert.equal(viewer.scene.requestRenderMode, true, 'its loop left alone');
  assert.equal(frame.mode(), 'demand');

  const seen = [];
  const offs = ['preUpdate', 'preRender', 'postRender'].map((phase) =>
    frame.on(phase, (t) => seen.push([phase, t.frame, t.time])),
  );
  viewer.tick();
  const t0 = Date.UTC(2026, 0, 1);
  assert.deepEqual(seen, [
    ['preUpdate', 1, t0],
    ['preRender', 1, t0],
    ['postRender', 1, t0],
  ]);
  assert.throws(() => frame.on('postUpdate', () => {}), TypeError);

  frame.requestRender('mine');
  assert.equal(viewer.scene.requests, 1);
  assert.deepEqual(frame.diagnostics().pendingReasons, ['mine']);
  viewer.tick();
  assert.deepEqual(frame.diagnostics().pendingReasons, []);

  // A hold asks for the next frame as each one ends, until released.
  const release = frame.holdContinuous('spin');
  const before = viewer.scene.requests;
  viewer.tick();
  assert.equal(viewer.scene.requests, before + 1, 'asked again after a frame');
  assert.deepEqual(frame.diagnostics().holds, ['spin']);
  release();
  release();
  const after = viewer.scene.requests;
  viewer.tick();
  assert.equal(viewer.scene.requests, after, 'released: no more asking');

  const once = frame.renderOnce();
  viewer.tick();
  await once;
  frame.renderNow();
  assert.equal(viewer.scene.forced, 1);
  frame.setTime(Date.UTC(2026, 5, 1));
  assert.equal(frame.time(), Date.UTC(2026, 5, 1));
  frame.suspend(true);
  assert.equal(viewer.useDefaultRenderLoop, false);
  assert.equal(frame.diagnostics().suspended, true);
  frame.suspend(false);
  frame.setTargetFps(30);
  assert.equal(viewer.targetFrameRate, 30);

  // A renderer bound later replaces it: its listeners hear nothing more.
  const unbind = bindRenderer(viewer, { frame: { id: 'renderer' } });
  assert.equal(findFrame(viewer).id, 'renderer');
  seen.length = 0;
  viewer.tick();
  assert.deepEqual(seen, []);
  unbind();
  offs.forEach((off) => off());
});

test('nothing to run frames over, no port', () => {
  assert.equal(findFrame({ scene: {} }), null);
  assert.throws(() => frameOf({ scene: {} }), /no renderer to run frames/);
});

test('a built frame port says whether a tick draws as its listeners ask, keeps reasons asked mid-draw, and stops once replaced', async () => {
  const viewer = fakeViewer();
  const { scene } = viewer;
  // Ticks that do not draw: preUpdate only.
  const idle = () => {
    scene._renderRequested = false;
    scene.preUpdate.raiseEvent(scene, viewer.clock.currentTime);
  };
  const frame = frameOf(viewer);
  const told = [];
  let kept = null;
  let ask = false;
  frame.on('preUpdate', () => {
    if (ask) frame.requestRender('first');
  });
  frame.on('preUpdate', (t) => {
    told.push(t.rendering);
    kept = t;
  });
  idle();
  assert.deepEqual(told, [false], 'nothing asked: no draw');
  ask = true;
  scene._renderRequested = false;
  scene.preUpdate.raiseEvent(scene, viewer.clock.currentTime);
  assert.deepEqual(told, [false, true], 'an earlier listener asked');
  scene.preRender.raiseEvent(scene);
  assert.equal(kept.rendering, true, 'and it drew: settled');
  ask = false;

  // A reason given while a frame draws waits for the next.
  const off = frame.on('preRender', () => frame.requestRender('later'));
  scene.postRender.raiseEvent(scene);
  frame.requestRender('first');
  viewer.tick();
  assert.deepEqual(frame.diagnostics().pendingReasons, ['later']);
  off();

  const unbind = bindRenderer(viewer, { frame: { id: 'renderer' } });
  await frame.renderOnce();
  const requests = scene.requests;
  frame.requestRender('gone');
  frame.holdContinuous('gone')();
  assert.equal(scene.requests, requests, 'a replaced port asks for nothing');
  unbind();
});

test('a built frame port counts holds per reason, times out a wait, and settles waits as it goes', async () => {
  const viewer = fakeViewer();
  const { scene } = viewer;
  viewer.useDefaultRenderLoop = false;
  const frame = frameOf(viewer);
  const a = frame.holdContinuous('spin');
  const b = frame.holdContinuous('spin');
  a();
  let requests = scene.requests;
  viewer.tick();
  assert.equal(scene.requests, requests + 1, 'one hold left: still held');
  b();
  requests = scene.requests;
  viewer.tick();
  assert.equal(scene.requests, requests, 'none left');

  await assert.rejects(frame.renderOnce({ timeoutMs: 1 }), /timed out/);
  // The owner's own loop: suspended and resumed, it stays theirs.
  frame.suspend(true);
  frame.suspend(false);
  assert.equal(viewer.useDefaultRenderLoop, false);
  frame.setTargetFps(0);
  assert.equal(viewer.targetFrameRate, undefined);

  const waiting = frame.renderOnce();
  const unbind = bindRenderer(viewer, { frame: { id: 'renderer' } });
  await waiting;
  unbind();
});

test('renderNow throws the error Cesium raises on renderError', () => {
  const listeners = new Set();
  const failure = new Error('worker failed');
  let fail = false;
  const scene = {
    renderError: {
      addEventListener: (cb) => (listeners.add(cb), () => listeners.delete(cb)),
    },
    forceRender() {
      if (fail) for (const cb of listeners) cb(scene, failure);
    },
  };
  const owner = { scene, clock: { currentTime: 'now' } };
  renderNow(owner);
  fail = true;
  assert.throws(() => renderNow(owner), failure);
  assert.equal(listeners.size, 0, 'it stops listening either way');
});

test('renderNow ifDue runs a frame of the widget’s own loop, as its render() does', () => {
  const listeners = new Set();
  const failure = new Error('worker failed');
  const calls = [];
  let fail = false;
  const scene = {
    renderError: {
      addEventListener: (cb) => (listeners.add(cb), () => listeners.delete(cb)),
    },
    forceRender: () => calls.push('forceRender'),
  };
  // The widget's render(): the camera's flight and input, the clock's
  // tick, then a draw if one is due.
  const owner = {
    scene,
    clock: { currentTime: 'now' },
    render() {
      calls.push('render');
      if (fail) for (const cb of listeners) cb(scene, failure);
    },
  };
  renderNow(owner, { ifDue: true });
  assert.deepEqual(calls, ['render']);
  fail = true;
  assert.throws(() => renderNow(owner, { ifDue: true }), failure);
  assert.equal(listeners.size, 0);
});
