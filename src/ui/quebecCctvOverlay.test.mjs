import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import * as Cesium from 'cesium';
import { createQuebecCctvOverlay } from './quebecCctvOverlay.js';

const MEDIA_URL =
  'https://www.quebec511.info/Carte/Fenetres/camera.ashx?id=3735&format=mp4';

const CAMERA = Object.freeze({
  id: 'qc-511-3735',
  sourceKind: 'quebec-511-browser',
  name: 'Route 136 at rue Panet',
  lat: 45.51651,
  lon: -73.5502,
  positionSource: 'MTQ georeferenced point',
  browserMediaUrl: MEDIA_URL,
  sourceUrl:
    'https://www.quebec511.info/Carte/Fenetres/FenetreVideo.html?id=3735',
});

/**
 * Mount the overlay in a happy-dom window with recorded media loads, timers
 * and postRender listeners. `play` decides what each play() returns.
 */
function mountOverlay(t, { play = () => Promise.resolve() } = {}) {
  const window = new Window({ url: 'http://localhost:4173/' });
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  globalThis.window = window;
  globalThis.document = window.document;
  const loads = [];
  window.HTMLMediaElement.prototype.load = function () {
    if (this.getAttribute('src')) loads.push(this.getAttribute('src'));
  };
  window.HTMLMediaElement.prototype.play = function () {
    return play(this);
  };
  window.HTMLMediaElement.prototype.pause = function () {};
  const intervals = new Map();
  let nextTimer = 1;
  window.setInterval = (fn) => {
    const id = nextTimer++;
    intervals.set(id, fn);
    return id;
  };
  window.clearInterval = (id) => intervals.delete(id);
  const renderListeners = new Set();
  const viewer = {
    camera: {
      positionWC: Cesium.Cartesian3.fromDegrees(-73.5502, 45.51651, 1000),
    },
    scene: {
      canvas: { clientWidth: 800, clientHeight: 600 },
      cartesianToCanvasCoordinates: () => null,
      postRender: {
        addEventListener(fn) {
          renderListeners.add(fn);
          return () => renderListeners.delete(fn);
        },
      },
    },
  };
  const overlay = createQuebecCctvOverlay(viewer);
  t.after(() => {
    overlay?.dispose();
    globalThis.window = previousWindow;
    globalThis.document = previousDocument;
    window.close();
  });
  const [live, still] = window.document.querySelectorAll('video');
  return {
    window,
    overlay,
    loads,
    intervals,
    renderListeners,
    live,
    still,
    note: () => window.document.querySelector('.qci-note').textContent,
    label: () => window.document.querySelector('.qci-marker-label').textContent,
    playButton: () => window.document.querySelector('.qci-play'),
  };
}

test('selecting a Québec camera contacts Québec 511 only after Play', (t) => {
  const ui = mountOverlay(t);
  assert.equal(ui.renderListeners.size, 0, 'no per-frame work before a camera');

  ui.overlay.setCamera(CAMERA);
  assert.deepEqual(ui.loads, [], 'selection alone loads no 511 media');
  assert.equal(ui.intervals.size, 0, 'and starts no refresh timer');
  assert.equal(ui.playButton().hidden, false);
  assert.match(ui.note(), /sees your IP address/);
  assert.equal(ui.renderListeners.size, 1);

  ui.playButton().click();
  assert.deepEqual(ui.loads, [MEDIA_URL, MEDIA_URL], 'live player and map still');
  assert.equal(ui.playButton().hidden, true);
  assert.equal(ui.intervals.size, 1);

  // A different camera never inherits playback.
  ui.loads.length = 0;
  ui.overlay.setCamera({
    ...CAMERA,
    id: 'qc-511-4103',
    browserMediaUrl: MEDIA_URL.replace('3735', '4103'),
  });
  assert.deepEqual(ui.loads, []);
  assert.equal(ui.intervals.size, 0);
  assert.equal(ui.playButton().hidden, false);

  ui.overlay.setCamera(null);
  assert.equal(ui.renderListeners.size, 0, 'deselect drops the per-frame listener');
});

test('a camera without browser media shows only its provider link', (t) => {
  const ui = mountOverlay(t);
  ui.overlay.setCamera({ ...CAMERA, browserMediaUrl: '' });
  assert.equal(ui.playButton().hidden, true);
  assert.deepEqual(ui.loads, []);
  const link = ui.window.document.querySelector('.qci-panel a');
  assert.equal(link.hidden, false);
  assert.equal(link.href, CAMERA.sourceUrl);
});

test('routine same-camera updates keep Québec feed errors visible until recovery', (t) => {
  const ui = mountOverlay(t);
  ui.overlay.setCamera(CAMERA);
  ui.playButton().click();
  ui.live.dispatchEvent(new ui.window.Event('error'));
  ui.still.dispatchEvent(new ui.window.Event('error'));

  ui.overlay.setCamera({ ...CAMERA });

  assert.equal(ui.note(), 'Source unavailable');
  assert.equal(ui.label(), 'Source unavailable');

  ui.live.dispatchEvent(new ui.window.Event('loadeddata'));
  ui.still.dispatchEvent(new ui.window.Event('loadeddata'));
  assert.match(ui.note(), /separate request/);
  assert.match(ui.label(), /^PREVIEW ·/);
});

test('an interrupted play() is not reported as an unavailable source', async (t) => {
  const abort = () =>
    Promise.reject(new DOMException('interrupted by pause()', 'AbortError'));
  const ui = mountOverlay(t, { play: abort });
  ui.overlay.setCamera(CAMERA);
  ui.playButton().click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(ui.note(), /separate request/);
  assert.match(ui.label(), /^PREVIEW ·/);
});

test('a real play() failure is reported', async (t) => {
  const fail = () =>
    Promise.reject(new DOMException('no supported source', 'NotSupportedError'));
  const ui = mountOverlay(t, { play: fail });
  ui.overlay.setCamera(CAMERA);
  ui.playButton().click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ui.note(), 'Source unavailable');
});

test('the refresh timer reloads with a cache-buster, skips hidden tabs, and stops on dispose', (t) => {
  const ui = mountOverlay(t);
  ui.overlay.setCamera(CAMERA);
  ui.playButton().click();
  const [refresh] = ui.intervals.values();

  ui.loads.length = 0;
  Object.defineProperty(ui.window.document, 'hidden', {
    configurable: true,
    get: () => true,
  });
  refresh();
  assert.deepEqual(ui.loads, [], 'a hidden tab does not refresh');

  Object.defineProperty(ui.window.document, 'hidden', {
    configurable: true,
    get: () => false,
  });
  refresh();
  assert.equal(ui.loads.length, 2);
  for (const src of ui.loads) assert.match(src, /[?&]_=\d+$/);

  ui.overlay.dispose();
  assert.equal(ui.intervals.size, 0);
  assert.equal(ui.renderListeners.size, 0);
  assert.equal(ui.window.document.querySelector('.qci-panel'), null);
});
