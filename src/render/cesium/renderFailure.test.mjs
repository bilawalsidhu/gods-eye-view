import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { installRenderFailureNotice } from './renderFailure.js';
import { renderLoopFixture } from './renderLoopFixture.mjs';

function fixture(t, options = {}) {
  const canvasListeners = new Map();
  const scene = {
    renderError: new Cesium.Event(),
    preUpdate: new Cesium.Event(),
    postRender: new Cesium.Event(),
    requestRender() {
      this.requests = (this.requests ?? 0) + 1;
    },
  };
  const viewer = {
    scene,
    useDefaultRenderLoop: true,
    canvas: {
      addEventListener: (name, listener) => canvasListeners.set(name, listener),
      removeEventListener: (name, listener) => {
        if (canvasListeners.get(name) === listener)
          canvasListeners.delete(name);
      },
    },
  };
  const store = {
    renderFailure: null,
    published: [],
    publishRenderFailure(next) {
      this.renderFailure = next;
      this.published.push(next);
    },
  };
  const visits = [];
  const locationRef = {
    href: 'https://gev.example/share/AQc?lang=ru#lat=48.8584&lon=2.2945',
    reload: () => visits.push('reload'),
    assign: (url) => visits.push(String(url)),
  };
  const logged = [];
  const uninstall = installRenderFailureNotice(viewer, {
    store,
    locationRef,
    logError: (error) => logged.push(error),
    ...options,
  });
  t.after(uninstall);
  // One Cesium frame: preUpdate, an optional render error, then postRender,
  // which Cesium raises after a failed frame too.
  const frame = (error) => {
    scene.preUpdate.raiseEvent(scene);
    if (error) {
      viewer.useDefaultRenderLoop = false;
      scene.renderError.raiseEvent(scene, error);
    }
    scene.postRender.raiseEvent(scene);
  };
  return {
    viewer,
    scene,
    store,
    visits,
    logged,
    uninstall,
    frame,
    loseContext: () => canvasListeners.get('webglcontextlost')?.({}),
    canvasListeners,
  };
}

test('a render error shows a notice that survives the failed frame', (t) => {
  const f = fixture(t);
  assert.equal(f.store.renderFailure, null);
  const error = new Error('Expected width to be greater than 0');
  f.frame(error);
  const notice = f.store.renderFailure;
  assert.equal(notice.reason, 'render-error');
  assert.equal(notice.detail, 'Expected width to be greater than 0');
  assert.equal(typeof notice.retry, 'function');
  assert.equal(typeof notice.reset, 'function');
  assert.deepEqual(f.logged, [error]);
});

test('Retry restarts the render loop and a clean frame clears the notice', (t) => {
  const f = fixture(t);
  f.frame(new Error('boom'));
  f.store.renderFailure.retry();
  assert.equal(f.viewer.useDefaultRenderLoop, true);
  assert.equal(f.scene.requests, 1);
  assert.ok(f.store.renderFailure, 'the notice waits for a frame');
  f.frame();
  assert.equal(f.store.renderFailure, null);
  // Clearing stops the per-frame listeners.
  assert.equal(f.scene.preUpdate.numberOfListeners, 0);
  assert.equal(f.scene.postRender.numberOfListeners, 0);
});

test('a loop restarted into the same error keeps one notice', (t) => {
  const f = fixture(t);
  f.frame(new Error('boom'));
  const first = f.store.renderFailure;
  f.store.renderFailure.retry();
  f.frame(new Error('boom'));
  assert.equal(f.store.renderFailure, first);
  assert.equal(f.store.published.length, 1);
  f.frame(new Error('other'));
  assert.equal(f.store.renderFailure.detail, 'other');
  assert.ok(!f.store.published.includes(null), 'no new appearance');
});

test('a new failure after recovery is a new appearance', (t) => {
  const f = fixture(t);
  f.frame(new Error('boom'));
  f.store.renderFailure.retry();
  f.frame();
  f.frame(new Error('boom'));
  assert.deepEqual(
    f.store.published.map((notice) => notice?.reason ?? null),
    ['render-error', null, 'render-error'],
  );
});

test('a render error without a value shows no detail', (t) => {
  const f = fixture(t);
  f.viewer.useDefaultRenderLoop = false;
  f.scene.renderError.raiseEvent(f.scene, undefined);
  assert.equal(f.store.renderFailure.reason, 'render-error');
  assert.equal(f.store.renderFailure.detail, '');
});

test('Reset opens the app root without the restored view', (t) => {
  const f = fixture(t);
  f.frame(new Error('boom'));
  f.store.renderFailure.reset();
  assert.deepEqual(f.visits, ['https://gev.example/?lang=ru']);
});

test('a lost context offers a reload and no frame clears it', (t) => {
  const f = fixture(t);
  f.loseContext();
  const notice = f.store.renderFailure;
  assert.equal(notice.reason, 'context-lost');
  assert.equal(notice.detail, '');
  // Cesium's next frame then fails on the dead drawing buffer.
  f.frame(new Error('Expected width to be greater than 0'));
  assert.equal(f.store.renderFailure, notice, 'the notice keeps saying why');
  f.frame();
  assert.ok(f.store.renderFailure, 'a lost context never draws again');
  f.store.renderFailure.retry();
  assert.deepEqual(f.visits, ['reload']);
});

test('a page that must not reload offers neither reload nor reset', (t) => {
  const f = fixture(t, { allowReload: false });
  f.frame(new Error('boom'));
  assert.equal(typeof f.store.renderFailure.retry, 'function');
  assert.equal(f.store.renderFailure.reset, null);
  // Only a reload draws again, which this page must not offer: the notice
  // goes, and the page's own lost-context notice speaks instead.
  f.loseContext();
  assert.equal(f.store.renderFailure, null);
  f.frame(new Error('Expected width to be greater than 0'));
  assert.equal(f.store.renderFailure, null);
});

test('uninstall removes the listeners and the notice', (t) => {
  const f = fixture(t);
  f.frame(new Error('boom'));
  f.uninstall();
  assert.equal(f.store.renderFailure, null);
  assert.equal(f.scene.renderError.numberOfListeners, 0);
  assert.equal(f.scene.postRender.numberOfListeners, 0);
  assert.equal(f.canvasListeners.size, 0);
  f.frame(new Error('later'));
  assert.equal(f.store.renderFailure, null);
});

// Errors thrown in the render loop outside Scene's tryAndCatchError. Drives
// Cesium's real startRenderLoop through the useDefaultRenderLoop setter.
function runLoop(render) {
  const scene = {
    renderError: new Cesium.Event(),
    preUpdate: new Cesium.Event(),
    postRender: new Cesium.Event(),
    requestRender() {},
    initializeFrame() {},
    render,
  };
  const fixture = renderLoopFixture(scene);
  fixture.viewer.useDefaultRenderLoop = true;
  fixture.runFrames(3);
  return { ...fixture, uninstall: fixture.restore };
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

// Retry after an error Scene catches itself: the loop is marked stopped but
// its next frame is still queued, so an early Retry must not start a second
// loop. Drives Cesium's real startRenderLoop and useDefaultRenderLoop setter.
function secondLoopSetup({ targetFrameRate } = {}) {
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
  return { scene, ...renderLoopFixture(scene, { targetFrameRate }) };
}

for (const targetFrameRate of [undefined, 60]) {
  test(`targetFrameRate ${targetFrameRate}: Retry before the next frame after an error Scene caught keeps one render loop`, () => {
    const { frames, scene, viewer, store, runFrames, restore } =
      secondLoopSetup({
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
  const { frames, scene, viewer, store, runFrames, restore } =
    secondLoopSetup();
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
  const { scene, viewer, runFrames, restore } = secondLoopSetup();
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

// Retry after a scene event listener throws. Cesium's Event.raiseEvent has no
// try/finally, so the event stays mid-raise and only queues listener changes.
// Drives Cesium's real Event and startRenderLoop.
function eventRetrySetup() {
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
    const { scene, viewer, store, runFrames, restore } = eventRetrySetup();
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
  const { scene, viewer, store, runFrames, restore } = eventRetrySetup();
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
    const { scene, viewer, store, runFrames, restore } = eventRetrySetup();
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
