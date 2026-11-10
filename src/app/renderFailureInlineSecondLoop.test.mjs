// Retry in an inline panel after an error Scene catches itself in an
// animation frame, when the host stops frames right after it. The loop's next
// animation frame is still queued, so Retry must not start a second loop.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { keepPanelRendering } from './embed.js';
import { installRenderFailureNotice } from '../ui/renderFailure.js';

test('Retry in a panel whose host stopped frames right after an error Scene caught in an animation frame keeps one render loop', () => {
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
    // The error comes in an animation frame; Scene catches it, and the loop
    // still queues its next frame. Then the host stops animation frames.
    broken = true;
    for (const render of frames.splice(0)) render(16);
    assert.equal(store.renderFailure?.reason, 'render-error');
    assert.equal(frames.length, 1);
    broken = false;
    clock = 400;
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
