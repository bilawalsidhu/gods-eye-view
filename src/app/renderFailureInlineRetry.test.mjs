// Retry in an inline panel whose host stopped animation frames: the panel
// draws from keepPanelRendering's timer, so Retry must make that timer draw
// again, or the notice offers a Retry that does nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { keepPanelRendering } from './embed.js';
import { installRenderFailureNotice } from '../ui/renderFailure.js';

test('Retry resumes the inline panel timer after a render error', () => {
  let tick = null;
  let clock = 0;
  // The host reports the panel hidden: animation frames never arrive.
  const windowRef = {
    requestAnimationFrame: () => 1,
    cancelAnimationFrame() {},
    setInterval: (fn) => ((tick = fn), 1),
    clearInterval() {},
  };
  const previousRaf = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = () => 1;
  const previousError = console.error;
  console.error = () => {};
  try {
    let broken = true;
    let drawn = 0;
    const scene = {
      renderError: new Cesium.Event(),
      preUpdate: new Cesium.Event(),
      postRender: new Cesium.Event(),
      requestRender() {},
    };
    const viewer = {
      scene,
      canvas: { addEventListener() {}, removeEventListener() {} },
      useDefaultRenderLoop: true,
      isDestroyed: () => false,
      resize() {},
      // Scene.render: a failing primitive update raises renderError
      // (tryAndCatchError), and postRender is still raised.
      render() {
        drawn += 1;
        scene.preUpdate.raiseEvent(scene);
        if (broken) scene.renderError.raiseEvent(scene, new Error('boom'));
        scene.postRender.raiseEvent(scene);
      },
    };
    // CesiumWidget._onRenderError stops the default loop.
    scene.renderError.addEventListener(() => {
      viewer.useDefaultRenderLoop = false;
    });
    const store = {
      renderFailure: null,
      publishRenderFailure(next) {
        this.renderFailure = next;
      },
    };
    const uninstall = installRenderFailureNotice(viewer, {
      store,
      allowReload: false,
      locationRef: { href: 'https://gev.example/', reload() {}, assign() {} },
      logError() {},
    });
    const stop = keepPanelRendering(viewer, { windowRef, now: () => clock });
    clock = 400;
    tick();
    assert.equal(store.renderFailure?.reason, 'render-error');
    assert.equal(typeof store.renderFailure.retry, 'function');
    // The cause goes away and the user presses Retry.
    broken = false;
    store.renderFailure.retry();
    const before = drawn;
    for (let i = 0; i < 5; i += 1) {
      clock += 33;
      tick();
    }
    assert.ok(drawn > before, 'the panel draws again after Retry');
    assert.equal(store.renderFailure, null, 'a clean frame clears the notice');
    stop();
    uninstall();
  } finally {
    globalThis.requestAnimationFrame = previousRaf;
    console.error = previousError;
  }
});

test('Retry in a panel whose host stopped frames keeps one render loop', () => {
  const frames = [];
  let tick = null;
  let clock = 0;
  const windowRef = {
    requestAnimationFrame: () => 1,
    cancelAnimationFrame() {},
    setInterval: (fn) => ((tick = fn), 1),
    clearInterval() {},
  };
  const previousRaf = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = (fn) => frames.push(fn);
  const previousError = console.error;
  console.error = () => {};
  try {
    let broken = false;
    let drawn = 0;
    const scene = {
      renderError: new Cesium.Event(),
      preUpdate: new Cesium.Event(),
      postRender: new Cesium.Event(),
      requestRender() {},
      initializeFrame() {},
      render() {
        drawn += 1;
        this.preUpdate.raiseEvent(this);
        if (broken) this.renderError.raiseEvent(this, new Error('boom'));
        this.postRender.raiseEvent(this);
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
    // CesiumWidget's own renderError handler, which marks the loop stopped.
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
      isDestroyed: () => false,
      render: () => widget.render(),
      resize: () => widget.resize(),
    };
    const store = {
      renderFailure: null,
      publishRenderFailure(next) {
        this.renderFailure = next;
      },
    };
    const uninstall = installRenderFailureNotice(viewer, {
      store,
      allowReload: false,
      locationRef: { href: 'https://gev.example/', reload() {}, assign() {} },
      logError() {},
    });
    const stop = keepPanelRendering(viewer, { windowRef, now: () => clock });
    viewer.useDefaultRenderLoop = true;
    // The host stops animation frames with the loop's next one queued.
    assert.equal(frames.length, 1);
    broken = true;
    clock = 400;
    tick();
    assert.equal(store.renderFailure?.reason, 'render-error');
    broken = false;
    store.renderFailure.retry();
    clock += 33;
    tick();
    assert.equal(store.renderFailure, null);
    assert.equal(frames.length, 1, 'Retry starts no second loop');
    // The host resumes frames: the globe draws once a frame.
    drawn = 0;
    for (let frame = 1; frame <= 3; frame += 1)
      for (const render of frames.splice(0)) render(frame * 16);
    assert.equal(drawn, 3);
    stop();
    uninstall();
  } finally {
    globalThis.requestAnimationFrame = previousRaf;
    console.error = previousError;
  }
});
