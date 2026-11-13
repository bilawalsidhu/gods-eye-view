// Retry after a scene event listener throws. Cesium's Event.raiseEvent has no
// try/finally, so the event stays mid-raise and only queues listener changes.
// Drives Cesium's real Event and startRenderLoop.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { installRenderFailureNotice } from './renderFailure.js';
import { renderLoopFixture } from './renderLoopFixture.mjs';

function setup() {
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
  return { scene, ...renderLoopFixture(scene) };
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

// While the loop is stopped, a layer turned off and on again, or a ground
// task in worldAnnotationRenderer that starts, times out and starts again.
const RESUBSCRIBE = {
  'turned off and on': (event, listener) => {
    event.removeEventListener(listener);
    event.addEventListener(listener);
  },
  'added, removed and added again': (event, listener) => {
    event.addEventListener(listener);
    event.removeEventListener(listener);
    event.addEventListener(listener);
  },
};

for (const [name, resubscribe] of Object.entries(RESUBSCRIBE)) {
  test(`a listener ${name} while the loop is stopped runs after Retry`, () => {
    const { scene, viewer, store, runFrames, restore } = setup();
    try {
      let broken = true;
      scene.postRender.addEventListener(() => {
        if (broken) throw new TypeError('layer listener failed');
      });
      let calls = 0;
      const listener = () => {
        calls += 1;
      };
      if (name === 'turned off and on')
        scene.postRender.addEventListener(listener);
      scene.requestRender();
      viewer.useDefaultRenderLoop = true;
      runFrames(1);
      assert.equal(store.renderFailure?.reason, 'render-error');
      resubscribe(scene.postRender, listener);
      broken = false;
      store.renderFailure.retry();
      calls = 0;
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
}

// Every event a listener's error can cut short is finished when the error
// surfaces, so a listener added at once is subscribed.
const FRAME_EVENTS = {
  'scene.preUpdate': (v) => v.scene.preUpdate,
  'scene.postUpdate': (v) => v.scene.postUpdate,
  'scene.preRender': (v) => v.scene.preRender,
  'scene.postRender': (v) => v.scene.postRender,
  'camera.changed': (v) => v.scene.camera.changed,
  'camera.moveStart': (v) => v.scene.camera.moveStart,
  'camera.moveEnd': (v) => v.scene.camera.moveEnd,
  'clock.onTick': (v) => v.clock.onTick,
  'clock.onStop': (v) => v.clock.onStop,
  'globe.tileLoadProgressEvent': (v) => v.scene.globe.tileLoadProgressEvent,
  'tileset.loadProgress': (v) => v.scene.primitives.get(0).loadProgress,
  'tileset.allTilesLoaded': (v) => v.scene.primitives.get(0).allTilesLoaded,
  'tileset.initialTilesLoaded': (v) =>
    v.scene.primitives.get(0).initialTilesLoaded,
};

for (const [name, pick] of Object.entries(FRAME_EVENTS)) {
  test(`a listener that throws in ${name} leaves it finished`, () => {
    const events = () => ({
      changed: new Cesium.Event(),
      moveStart: new Cesium.Event(),
      moveEnd: new Cesium.Event(),
    });
    const tileset = {
      loadProgress: new Cesium.Event(),
      allTilesLoaded: new Cesium.Event(),
      initialTilesLoaded: new Cesium.Event(),
    };
    const viewer = {
      scene: {
        renderError: new Cesium.Event(),
        preUpdate: new Cesium.Event(),
        postUpdate: new Cesium.Event(),
        preRender: new Cesium.Event(),
        postRender: new Cesium.Event(),
        camera: events(),
        globe: { tileLoadProgressEvent: new Cesium.Event() },
        primitives: { length: 1, get: () => tileset },
      },
      clock: { onTick: new Cesium.Event(), onStop: new Cesium.Event() },
      canvas: { addEventListener() {}, removeEventListener() {} },
      cesiumWidget: {
        _renderLoopRunning: false,
        render: () => pick(viewer).raiseEvent(),
      },
    };
    const store = { publishRenderFailure() {} };
    const uninstall = installRenderFailureNotice(viewer, {
      store,
      locationRef: { href: 'https://gev.example/', reload() {}, assign() {} },
      logError() {},
    });
    try {
      const event = pick(viewer);
      event.addEventListener(() => {
        throw new TypeError('listener failed');
      });
      assert.throws(() => viewer.cesiumWidget.render(), TypeError);
      assert.equal(event._invokingListeners, false);
      const listener = () => {};
      event.addEventListener(listener);
      assert.ok(event._listeners.has(listener));
    } finally {
      uninstall();
    }
  });
}
