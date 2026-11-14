import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { installRenderFailureNotice } from './renderFailure.js';

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
