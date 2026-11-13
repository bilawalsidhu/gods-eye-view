// Errors thrown in the render loop outside Scene's tryAndCatchError. Drives
// Cesium's real startRenderLoop through the useDefaultRenderLoop setter.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { installRenderFailureNotice } from './renderFailure.js';

// What src/app/scene.js passes to the viewer (showRenderLoopErrors).
const SHOW_RENDER_LOOP_ERRORS = false;

function runLoop(render) {
  const frames = [];
  const previousRaf = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = (fn) => frames.push(fn);
  try {
    const scene = {
      renderError: new Cesium.Event(),
      preUpdate: new Cesium.Event(),
      postRender: new Cesium.Event(),
      requestRender() {},
      initializeFrame() {},
      render,
    };
    const widget = Object.create(Cesium.CesiumWidget.prototype);
    Object.assign(widget, {
      _scene: scene,
      _clock: { tick() {} },
      _canRender: true,
      _useDefaultRenderLoop: false,
      _renderLoopRunning: false,
      _showRenderLoopErrors: SHOW_RENDER_LOOP_ERRORS,
      _targetFrameRate: undefined,
      isDestroyed: () => false,
      resize() {},
      showErrorPanel() {},
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
    const logged = [];
    const uninstall = installRenderFailureNotice(viewer, {
      store,
      locationRef: { href: 'https://gev.example/', reload() {}, assign() {} },
      logError: (error) => logged.push(error),
    });
    viewer.useDefaultRenderLoop = true;
    while (frames.length) frames.shift()(16);
    return { widget, store, logged, uninstall };
  } finally {
    globalThis.requestAnimationFrame = previousRaf;
  }
}

test('an error thrown outside tryAndCatchError still shows the notice', () => {
  // Scene.render raises preRender outside tryAndCatchError (Scene.js:4439),
  // so a listener's exception propagates.
  const { widget, store, logged, uninstall } = runLoop(function () {
    this.preUpdate.raiseEvent(this);
    throw new TypeError("Cannot read properties of undefined (reading 'x')");
  });
  assert.equal(widget.useDefaultRenderLoop, false);
  assert.equal(store.renderFailure?.reason, 'render-error');
  assert.equal(logged.length, 1);
  uninstall();
});

test('an error Scene raised and threw on with rethrowRenderErrors is reported once', () => {
  const { store, logged, uninstall } = runLoop(function () {
    this.preUpdate.raiseEvent(this);
    const error = new Error('boom');
    this.renderError.raiseEvent(this, error);
    throw error;
  });
  assert.equal(store.renderFailure?.detail, 'boom');
  assert.equal(logged.length, 1);
  uninstall();
});
