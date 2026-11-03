import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import * as Cesium from 'cesium';
import { installQuebecCameraPreview } from './quebecCameraPreview.js';

test('Québec preview selects direct-feed and viewer-only cameras and scales the map card', async () => {
  const window = new Window({ url: 'http://localhost:4173/?qc-preview=all' });
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  globalThis.window = window;
  globalThis.document = window.document;
  window.HTMLMediaElement.prototype.load = function () {};
  window.HTMLMediaElement.prototype.play = function () {
    return Promise.resolve();
  };
  window.HTMLMediaElement.prototype.pause = function () {
    this.dataset.paused = 'yes';
  };
  let removed = 0;
  let destination;
  let render;
  let point = { x: 200, y: 150 };
  const viewer = {
    camera: {
      positionWC: Cesium.Cartesian3.fromDegrees(-73.5502, 45.51651, 1000),
      flyTo: (options) => {
        destination = options.destination;
      },
    },
    scene: {
      canvas: {
        clientWidth: 800,
        clientHeight: 600,
        getBoundingClientRect: () => ({ left: 30, top: 40 }),
      },
      cartesianToCanvasCoordinates: () => point,
      postRender: {
        addEventListener: (callback) => {
          render = callback;
          return () => {
            removed++;
          };
        },
      },
    },
  };
  const cameras = [
    {
      id: '3735',
      kind: 'traffic',
      name: 'Route 136 at rue Panet',
      nameEn: 'Route 136 at rue Panet',
      lat: 45.51651,
      lon: -73.5502,
      viewerUrl:
        'https://www.quebec511.info/Carte/Fenetres/FenetreVideo.html?id=3735',
      positionSource: 'MTQ WFS',
      accuracyM: null,
    },
    {
      id: 'mtl-465',
      kind: 'montreal',
      name: '1re Avenue / Sortie A-20',
      lat: 45.44462,
      lon: -73.663552,
      viewerUrl: 'https://ville.montreal.qc.ca/circulation/node/465',
      positionSource: 'OSM node',
      accuracyM: 15,
    },
  ];
  try {
    const preview = installQuebecCameraPreview(viewer, {
      initialId: '3735',
      fetchImpl: async () => ({ ok: true, json: async () => ({ cameras }) }),
    });
    await preview.ready;
    const videos = [...window.document.querySelectorAll('video')];
    assert.equal(videos.length, 2);
    assert.equal(
      videos[0].src,
      'https://www.quebec511.info/Carte/Fenetres/camera.ashx?id=3735&format=mp4',
    );
    assert.equal(videos[1].src, videos[0].src);
    assert.equal(videos[0].hidden, false);
    assert.match(
      window.document.querySelector('.qc-preview-coordinates').textContent,
      /45\.51651, -73\.55020/,
    );
    videos[1].dispatchEvent(new window.Event('loadeddata'));
    assert.equal(videos[1].dataset.paused, 'yes');

    const marker = window.document.querySelector('.qc-preview-marker');
    assert.equal(marker.hidden, false);
    assert.equal(marker.style.left, '230px');
    assert.equal(marker.style.top, '190px');
    const nearScale = Number(
      marker.style.getPropertyValue('--qc-preview-scale'),
    );
    viewer.camera.positionWC = Cesium.Cartesian3.fromDegrees(
      -73.5502,
      45.51651,
      80000,
    );
    render();
    assert.ok(
      Number(marker.style.getPropertyValue('--qc-preview-scale')) < nearScale,
    );

    const select = window.document.querySelector('select');
    select.value = 'mtl-465';
    select.dispatchEvent(new window.Event('change'));
    assert.equal(videos[0].hidden, true);
    assert.equal(videos[1].hidden, true);
    assert.match(
      window.document.querySelectorAll(
        '.qc-preview-panel a[target="_blank"]',
      )[1].href,
      /ville\.montreal\.qc\.ca/,
    );
    window.document.querySelector('.qc-preview-actions button').click();
    assert.ok(destination);

    point = { x: -1, y: 150 };
    render();
    assert.equal(marker.hidden, true);
    window.document.querySelector('.qc-preview-header button').click();
    preview.dispose();
    assert.equal(removed, 1);
    assert.equal(window.document.querySelectorAll('video').length, 0);
  } finally {
    globalThis.window = previousWindow;
    globalThis.document = previousDocument;
    window.close();
  }
});
