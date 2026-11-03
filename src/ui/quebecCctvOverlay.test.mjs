import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import * as Cesium from 'cesium';
import { createQuebecCctvOverlay } from './quebecCctvOverlay.js';

test('routine same-camera updates keep Québec feed errors visible until recovery', async () => {
  const window = new Window({ url: 'http://localhost:4173/' });
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  globalThis.window = window;
  globalThis.document = window.document;
  window.HTMLMediaElement.prototype.load = function () {};
  window.HTMLMediaElement.prototype.play = function () {
    return Promise.resolve();
  };
  window.HTMLMediaElement.prototype.pause = function () {};
  window.setInterval = () => 0;
  const viewer = {
    camera: {
      positionWC: Cesium.Cartesian3.fromDegrees(-73.5502, 45.51651, 1000),
    },
    scene: {
      canvas: { clientWidth: 800, clientHeight: 600 },
      cartesianToCanvasCoordinates: () => null,
      postRender: { addEventListener: () => () => {} },
    },
  };
  let overlay;

  try {
    overlay = createQuebecCctvOverlay(viewer);
    const camera = {
      id: 'qc-511-3735',
      sourceKind: 'quebec-511-browser',
      name: 'Route 136 at rue Panet',
      lat: 45.51651,
      lon: -73.5502,
      positionSource: 'MTQ georeferenced point',
      browserMediaUrl:
        'https://www.quebec511.info/Carte/Fenetres/camera.ashx?id=3735&format=mp4',
      sourceUrl:
        'https://www.quebec511.info/Carte/Fenetres/FenetreVideo.html?id=3735',
    };
    overlay.setCamera(camera);
    const [live, still] = window.document.querySelectorAll('video');
    live.dispatchEvent(new window.Event('error'));
    still.dispatchEvent(new window.Event('error'));

    overlay.setCamera({ ...camera });

    assert.equal(window.document.querySelector('.qci-note').textContent, 'Source unavailable');
    assert.equal(window.document.querySelector('.qci-marker-label').textContent, 'Source unavailable');

    live.dispatchEvent(new window.Event('loadeddata'));
    still.dispatchEvent(new window.Event('loadeddata'));
    assert.match(
      window.document.querySelector('.qci-note').textContent,
      /separate request/,
    );
    assert.match(
      window.document.querySelector('.qci-marker-label').textContent,
      /^PREVIEW ·/,
    );
  } finally {
    overlay?.dispose();
    globalThis.window = previousWindow;
    globalThis.document = previousDocument;
    window.close();
  }
});
