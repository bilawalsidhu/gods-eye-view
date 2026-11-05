// An error thrown in the render loop outside Scene's tryAndCatchError
// (a preRender/postRender listener, clock.onTick, resize) must still reach
// the render failure notice. Drives Cesium's real startRenderLoop through the
// CesiumWidget.prototype.useDefaultRenderLoop setter.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { installRenderFailureNotice } from './renderFailure.js';

// What src/app/scene.js passes to the viewer (showRenderLoopErrors).
const SHOW_RENDER_LOOP_ERRORS = false;

test('an error thrown outside tryAndCatchError still shows the notice', () => {
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
      // Scene.render raises preRender outside tryAndCatchError
      // (Scene.js:4439), so a listener's exception propagates.
      render() {
        this.preUpdate.raiseEvent(this);
        throw new TypeError(
          "Cannot read properties of undefined (reading 'x')",
        );
      },
    };
    const panels = [];
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
      showErrorPanel: (...args) => panels.push(args),
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
      render: () => widget.render(),
      resize: () => widget.resize(),
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
    viewer.useDefaultRenderLoop = true; // starts Cesium's loop
    while (frames.length) frames.shift()(16);
    // Cesium's catch stopped the loop.
    assert.equal(widget.useDefaultRenderLoop, false);
    // The user is told, and the error is logged.
    assert.equal(store.renderFailure?.reason, 'render-error');
    assert.equal(logged.length, 1);
    uninstall();
  } finally {
    globalThis.requestAnimationFrame = previousRaf;
  }
});
