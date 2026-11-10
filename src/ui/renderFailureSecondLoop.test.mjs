// Retry after an error Scene catches itself (Scene.tryAndCatchError raises
// renderError and returns). CesiumWidget's renderError handler marks the loop
// stopped, but startRenderLoop still queues the loop's next animation frame.
// A Retry that lands before that frame runs must not start a second loop.
// Drives Cesium's real startRenderLoop and useDefaultRenderLoop setter
// (CesiumWidget.prototype).
import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { installRenderFailureNotice } from './renderFailure.js';

function setup({ targetFrameRate } = {}) {
  const frames = [];
  const previousRaf = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = (fn) => frames.push(fn);
  const scene = {
    renderError: new Cesium.Event(),
    preUpdate: new Cesium.Event(),
    preRender: new Cesium.Event(),
    postRender: new Cesium.Event(),
    broken: false,
    drawn: 0,
    requestRender() {},
    initializeFrame() {},
    // Scene.render (Scene.js:4369): an update error is caught by
    // tryAndCatchError, which raises renderError and returns normally.
    render(time) {
      this.drawn += 1;
      this.preUpdate.raiseEvent(this, time);
      if (this.broken) this.renderError.raiseEvent(this, new Error('boom'));
      this.preRender.raiseEvent(this, time);
      this.postRender.raiseEvent(this, time);
    },
  };
  const widget = Object.create(Cesium.CesiumWidget.prototype);
  Object.assign(widget, {
    _scene: scene,
    _clock: { tick() {} },
    _canRender: true,
    _useDefaultRenderLoop: false,
    _renderLoopRunning: false,
    _showRenderLoopErrors: false,
    _targetFrameRate: targetFrameRate,
    isDestroyed: () => false,
    resize() {},
  });
  // CesiumWidget's own renderError handler (CesiumWidget.js:414).
  scene.renderError.addEventListener(() => {
    widget._useDefaultRenderLoop = false;
    widget._renderLoopRunning = false;
  });
  const viewer = {
    scene,
    cesiumWidget: widget,
    canvas: { addEventListener() {}, removeEventListener() {} },
    get useDefaultRenderLoop() {
      return widget.useDefaultRenderLoop;
    },
    set useDefaultRenderLoop(value) {
      widget.useDefaultRenderLoop = value;
    },
  };
  const store = {
    renderFailure: null,
    publishRenderFailure(next) {
      this.renderFailure = next;
    },
  };
  const uninstall = installRenderFailureNotice(viewer, {
    store,
    locationRef: { href: 'https://gev.example/', reload() {}, assign() {} },
    logError() {},
  });
  let time = 0;
  const runFrames = (n) => {
    for (let i = 0; i < n; i += 1) {
      time += 17;
      for (const fn of frames.splice(0)) fn(time);
    }
  };
  const restore = () => {
    uninstall();
    globalThis.requestAnimationFrame = previousRaf;
  };
  return { frames, scene, viewer, store, runFrames, restore };
}

for (const targetFrameRate of [undefined, 60]) {
  test(`targetFrameRate ${targetFrameRate}: Retry before the next frame after an error Scene caught keeps one render loop`, () => {
    const { frames, scene, viewer, store, runFrames, restore } = setup({
      targetFrameRate,
    });
    try {
      viewer.useDefaultRenderLoop = true;
      runFrames(2);
      scene.broken = true;
      runFrames(1);
      assert.equal(store.renderFailure?.reason, 'render-error');
      // The cause is gone; Retry runs (a queued Enter on the focused Retry)
      // before the loop's next animation frame.
      scene.broken = false;
      store.renderFailure.retry();
      assert.equal(frames.length, 1, 'one animation frame queued after Retry');
      scene.drawn = 0;
      runFrames(3);
      assert.equal(store.renderFailure, null);
      assert.equal(scene.drawn, 3, 'the globe draws once a frame');
    } finally {
      restore();
    }
  });
}

test('control: Retry after the next frame ran keeps one render loop', () => {
  const { frames, scene, viewer, store, runFrames, restore } = setup();
  try {
    viewer.useDefaultRenderLoop = true;
    runFrames(2);
    scene.broken = true;
    runFrames(1);
    scene.broken = false;
    runFrames(1);
    assert.equal(frames.length, 0, 'the stopped loop queued nothing');
    store.renderFailure.retry();
    scene.drawn = 0;
    runFrames(3);
    assert.equal(scene.drawn, 3);
  } finally {
    restore();
  }
});

test('a tab hidden and shown again before the next frame after an error Scene caught keeps one render loop', () => {
  const { scene, viewer, runFrames, restore } = setup();
  try {
    viewer.useDefaultRenderLoop = true;
    runFrames(2);
    scene.broken = true;
    runFrames(1);
    scene.broken = false;
    // src/app/tools.js turns the loop off while the tab is hidden and back on
    // when it is shown, before the queued frame runs.
    viewer.useDefaultRenderLoop = false;
    viewer.useDefaultRenderLoop = true;
    scene.drawn = 0;
    runFrames(3);
    assert.equal(scene.drawn, 3, 'the globe draws once a frame');
  } finally {
    restore();
  }
});
