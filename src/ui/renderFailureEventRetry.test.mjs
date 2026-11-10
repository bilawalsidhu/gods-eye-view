// Retry after an error thrown by a scene event listener. Cesium's
// Event.raiseEvent has no try/finally: a throwing listener leaves the event
// with _invokingListeners = true, so listeners added or removed afterwards are
// only queued (_toAdd/_toRemove) until the next raise of that event completes.
// Drives Cesium's real Event and startRenderLoop (CesiumWidget.prototype).
import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { installRenderFailureNotice } from './renderFailure.js';

function setup() {
  const frames = [];
  const previousRaf = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = (fn) => frames.push(fn);
  // Scene.render as in Scene.js:4369: preUpdate always, preRender/postRender
  // only when a frame is rendered (requestRenderMode idle skips them).
  const scene = {
    renderError: new Cesium.Event(),
    preUpdate: new Cesium.Event(),
    preRender: new Cesium.Event(),
    postRender: new Cesium.Event(),
    requestRenderMode: true,
    _renderRequested: false,
    rendered: 0,
    requestRender() {
      this._renderRequested = true;
    },
    initializeFrame() {},
    render(time) {
      this.preUpdate.raiseEvent(this, time);
      const shouldRender = !this.requestRenderMode || this._renderRequested;
      if (!shouldRender) return;
      this._renderRequested = false;
      this.preRender.raiseEvent(this, time);
      this.rendered += 1;
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
    _targetFrameRate: undefined,
    isDestroyed: () => false,
    resize() {},
  });
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
  const runFrames = (n) => {
    for (let i = 0; i < n; i += 1)
      for (const fn of frames.splice(0)) fn(16 * (i + 1));
  };
  const restore = () => {
    uninstall();
    globalThis.requestAnimationFrame = previousRaf;
  };
  return { frames, scene, widget, viewer, store, runFrames, restore };
}

for (const eventName of ['postRender', 'preUpdate']) {
  test(`idle: a ${eventName} listener that threw once; a successful Retry clears the notice`, () => {
    const { scene, viewer, store, runFrames, restore } = setup();
    try {
      let broken = true;
      scene[eventName].addEventListener(() => {
        if (broken) throw new TypeError('listener failed');
      });
      scene.requestRender();
      viewer.useDefaultRenderLoop = true;
      runFrames(1);
      assert.equal(store.renderFailure?.reason, 'render-error');
      assert.equal(viewer.useDefaultRenderLoop, false);
      broken = false; // the cause goes away
      store.renderFailure.retry();
      const before = scene.rendered;
      runFrames(10); // idle: no camera move, no render request
      assert.ok(scene.rendered > before, 'the globe drew again');
      assert.equal(store.renderFailure, null, 'the notice is cleared');
    } finally {
      restore();
    }
  });
}

test('a throwing postRender listener removed before Retry is not called again', () => {
  const { scene, viewer, store, runFrames, restore } = setup();
  try {
    let calls = 0;
    const remove = scene.postRender.addEventListener(() => {
      calls += 1;
      throw new TypeError('layer listener failed');
    });
    scene.requestRender();
    viewer.useDefaultRenderLoop = true;
    runFrames(1);
    assert.equal(store.renderFailure?.reason, 'render-error');
    remove(); // the user turns the layer off
    store.renderFailure.retry();
    runFrames(5);
    assert.equal(calls, 1, 'the removed listener ran again after Retry');
    assert.equal(viewer.useDefaultRenderLoop, true, 'the loop keeps running');
    assert.equal(store.renderFailure, null, 'the notice is cleared');
  } finally {
    restore();
  }
});

const listenerCount = (event) =>
  [...event._listeners.values()].reduce((sum, scopes) => sum + scopes.size, 0);

test('a listener turned off and on while the loop is stopped runs after Retry', () => {
  const { scene, viewer, store, runFrames, restore } = setup();
  try {
    let broken = true;
    scene.postRender.addEventListener(() => {
      if (broken) throw new TypeError('layer listener failed');
    });
    let calls = 0;
    const frame = () => {
      calls += 1;
    };
    let removeFrame = scene.postRender.addEventListener(frame);
    scene.requestRender();
    viewer.useDefaultRenderLoop = true;
    runFrames(1);
    assert.equal(store.renderFailure?.reason, 'render-error');
    removeFrame(); // another layer is turned off
    removeFrame = scene.postRender.addEventListener(frame); // and on again
    broken = false;
    store.renderFailure.retry();
    calls = 0;
    scene.requestRender();
    runFrames(3);
    assert.ok(calls > 0, 'the re-added listener runs after Retry');
    assert.ok(scene.postRender._listeners.has(frame));
    assert.equal(
      scene.postRender.numberOfListeners,
      listenerCount(scene.postRender),
    );
  } finally {
    restore();
  }
});

test('a listener added, removed and added again while the loop is stopped runs after Retry', () => {
  const { scene, viewer, store, runFrames, restore } = setup();
  try {
    let broken = true;
    scene.postRender.addEventListener(() => {
      if (broken) throw new TypeError('layer listener failed');
    });
    scene.requestRender();
    viewer.useDefaultRenderLoop = true;
    runFrames(1);
    assert.equal(store.renderFailure?.reason, 'render-error');
    let calls = 0;
    const onGroundFrame = () => {
      calls += 1;
    };
    // worldAnnotationRenderer: a ground task starts, times out, the next starts
    scene.postRender.addEventListener(onGroundFrame);
    scene.postRender.removeEventListener(onGroundFrame);
    scene.postRender.addEventListener(onGroundFrame);
    broken = false;
    store.renderFailure.retry();
    scene.requestRender();
    runFrames(3);
    assert.ok(calls > 0, 'the re-added listener runs after Retry');
    assert.equal(
      scene.postRender.numberOfListeners,
      listenerCount(scene.postRender),
    );
  } finally {
    restore();
  }
});
