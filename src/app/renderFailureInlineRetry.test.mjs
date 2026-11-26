// Retry in an inline panel whose host stops animation frames, so the panel
// draws from keepPanelRendering's timer. Drives Cesium's real startRenderLoop
// and useDefaultRenderLoop setter (CesiumWidget.prototype), through the
// Cesium frame port.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { keepPanelRendering } from './panelRendering.js';
import { renderLoopFixture } from '../render/cesium/renderLoopFixture.mjs';
import { createSceneFrame } from '../render/cesium/frame.js';

function setup() {
  let tick = null;
  let clock = 0;
  // The host reports the panel hidden: its own animation frames never arrive.
  const windowRef = {
    requestAnimationFrame: () => 1,
    cancelAnimationFrame() {},
    setInterval: (fn) => ((tick = fn), 1),
    clearInterval() {},
  };
  const previousError = console.error;
  console.error = () => {};
  const state = { failure: null, drawn: 0 };
  const scene = {
    renderError: new Cesium.Event(),
    preUpdate: new Cesium.Event(),
    preRender: new Cesium.Event(),
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
  const { frames, widget, viewer, store, runFrames, restore } =
    renderLoopFixture(scene, {
      viewer: {
        isDestroyed: () => false,
        render: () => widget.render(),
        resize: () => widget.resize(),
      },
      notice: { allowReload: false },
    });
  const frame = createSceneFrame(viewer);
  const renderer = { resize: () => viewer.resize(), frame: frame.port };
  const stopPanel = keepPanelRendering(renderer, {
    windowRef,
    now: () => clock,
  });
  const stop = () => {
    stopPanel();
    frame.dispose();
  };
  viewer.useDefaultRenderLoop = true;
  const timerFrame = () => {
    clock += 400;
    tick();
  };
  return {
    frames,
    state,
    store,
    timerFrame,
    animationFrames: runFrames,
    restore: () => {
      stop();
      restore();
      console.error = previousError;
    },
  };
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
