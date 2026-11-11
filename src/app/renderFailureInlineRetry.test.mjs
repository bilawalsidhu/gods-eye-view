// Retry in an inline panel whose host stops animation frames, so the panel
// draws from keepPanelRendering's timer. Drives Cesium's real startRenderLoop
// and useDefaultRenderLoop setter (CesiumWidget.prototype).
import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { keepPanelRendering } from './embed.js';
import { installRenderFailureNotice } from '../ui/renderFailure.js';

function setup() {
  const frames = [];
  let tick = null;
  let clock = 0;
  // The host reports the panel hidden: its own animation frames never arrive.
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
  const state = { failure: null, drawn: 0 };
  const scene = {
    renderError: new Cesium.Event(),
    preUpdate: new Cesium.Event(),
    postRender: new Cesium.Event(),
    requestRender() {},
    initializeFrame() {},
    // Scene.render: a failing primitive update raises renderError
    // (tryAndCatchError) and returns; a failing listener throws.
    render() {
      state.drawn += 1;
      this.preUpdate.raiseEvent(this);
      if (state.failure === 'caught')
        this.renderError.raiseEvent(this, new Error('boom'));
      if (state.failure === 'thrown') throw new Error('boom');
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
  const timerFrame = () => {
    clock += 400;
    tick();
  };
  const animationFrames = (n) => {
    for (let frame = 1; frame <= n; frame += 1)
      for (const render of frames.splice(0)) render(frame * 16);
  };
  const restore = () => {
    stop();
    uninstall();
    globalThis.requestAnimationFrame = previousRaf;
    console.error = previousError;
  };
  return { frames, state, store, timerFrame, animationFrames, restore };
}

for (const failure of ['caught', 'thrown']) {
  test(`an error ${failure} in a frame the timer draws: Retry draws again with one render loop`, () => {
    const { frames, state, store, timerFrame, animationFrames, restore } =
      setup();
    try {
      // The host stops animation frames with the loop's next one queued.
      assert.equal(frames.length, 1);
      state.failure = failure;
      timerFrame(); // an error thrown here does not reach the host page
      assert.equal(store.renderFailure?.reason, 'render-error');
      assert.equal(typeof store.renderFailure.retry, 'function');
      state.failure = null;
      store.renderFailure.retry();
      const before = state.drawn;
      timerFrame();
      assert.ok(state.drawn > before, 'the panel draws again after Retry');
      assert.equal(
        store.renderFailure,
        null,
        'a clean frame clears the notice',
      );
      assert.equal(frames.length, 1, 'Retry starts no second loop');
      // The host resumes frames: the globe draws once a frame.
      state.drawn = 0;
      animationFrames(3);
      assert.equal(state.drawn, 3);
    } finally {
      restore();
    }
  });
}

test('an error Scene caught in an animation frame right before the host stopped frames: Retry keeps one render loop', () => {
  const { frames, state, store, timerFrame, animationFrames, restore } =
    setup();
  try {
    state.failure = 'caught';
    animationFrames(1);
    assert.equal(store.renderFailure?.reason, 'render-error');
    assert.equal(frames.length, 1);
    state.failure = null;
    store.renderFailure.retry();
    timerFrame();
    assert.equal(store.renderFailure, null);
    assert.equal(frames.length, 1, 'Retry starts no second loop');
    state.drawn = 0;
    animationFrames(3);
    assert.equal(state.drawn, 3);
  } finally {
    restore();
  }
});
