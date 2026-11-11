import test from 'node:test';
import assert from 'node:assert/strict';
import { createPerformanceController } from './performance.js';
import { readPerformanceMode } from './performancePolicy.js';

test('resource preference is local, explicit URLs override storage, and refused storage is harmless', () => {
  assert.equal(
    readPerformanceMode({
      search: '?performance=low',
      storage: {
        getItem() {
          throw Error('denied');
        },
      },
    }),
    'low',
  );
  assert.equal(
    readPerformanceMode({
      search: '?performance=standard',
      storage: { getItem: () => 'low' },
    }),
    'standard',
  );
  assert.equal(
    readPerformanceMode({ search: '', storage: { getItem: () => 'low' } }),
    'low',
  );
  assert.equal(
    readPerformanceMode({
      search: '',
      storage: {
        getItem() {
          throw Error('denied');
        },
      },
    }),
    'standard',
  );
});

test('low mode bounds rendering while keeping layers/data available, and standard restores preferences', async () => {
  const layer = {
    params: { models3d: true, models3dMode: 'all' },
    getParams() {
      return { ...this.params };
    },
    setParams(p) {
      Object.assign(this.params, p);
    },
  };
  const tile = {
    cacheBytes: 1536 * 1024 * 1024,
    maximumCacheOverflowBytes: 1024 * 1024 * 1024,
    maximumScreenSpaceError: 16,
  };
  const viewer = {
    targetFrameRate: 60,
    resolutionScale: 1,
    scene: {
      msaaSamples: 4,
      highDynamicRange: true,
      globe: { tileCacheSize: 100, maximumScreenSpaceError: 2 },
      primitives: { length: 1, get: () => tile },
      requestRender() {},
    },
  };
  const style = {
    activeStyle: 'normal',
    bloomEnabled: true,
    sharpenEnabled: true,
    setStyle(v) {
      this.activeStyle = v;
    },
    _setBloomEnabled(v) {
      this.bloomEnabled = v;
    },
    _setSharpenEnabled(v) {
      this.sharpenEnabled = v;
    },
  };
  let presentation,
    cap,
    detached = false;
  const store = {
    connect() {
      return {};
    },
    detach() {
      detached = true;
    },
    publishPerformance(p) {
      presentation = p;
    },
  };
  const controller = createPerformanceController({
    viewer,
    styleManager: style,
    dataManager: { layers: new Map([['flights', { module: layer }]]) },
    store,
    initialMode: 'standard',
    setOverlayPixelRatioCap(v) {
      cap = v;
    },
    storage: { setItem() {} },
  });
  await controller.ready;
  assert.equal(controller.setMode('low'), true);
  assert.equal(viewer.targetFrameRate, 30);
  assert.equal(viewer.resolutionScale, 0.6);
  assert.equal(viewer.scene.msaaSamples, 1);
  assert.equal(viewer.scene.globe.tileCacheSize, 24);
  assert.equal(cap, 1);
  assert.equal(layer.params.models3d, false);
  assert.equal(tile.cacheBytes, 64 * 1024 * 1024);
  assert.equal(presentation.mode, 'low');
  assert.equal(controller.setMode('standard'), true);
  assert.equal(viewer.targetFrameRate, 60);
  assert.equal(viewer.resolutionScale, 1);
  assert.equal(viewer.scene.highDynamicRange, true);
  assert.equal(layer.params.models3d, true);
  assert.equal(layer.params.models3dMode, 'all');
  assert.equal(tile.cacheBytes, 1536 * 1024 * 1024);
  assert.equal(style.sharpenEnabled, true);
  viewer.resolutionScale = viewer.gevStandardResolutionScale = 1.5;
  controller.setMode('low');
  viewer.gevStandardResolutionScale = 1;
  controller.setMode('standard');
  assert.equal(
    viewer.resolutionScale,
    1,
    'a display change during low mode restores the current DPI budget',
  );
  viewer.resolutionScale = 1.25;
  controller.setMode('low');
  viewer.gevStandardResolutionScale = 1.5;
  controller.setMode('standard');
  assert.equal(
    viewer.resolutionScale,
    1.25,
    'a custom render scale survives a resource-mode round trip',
  );
  controller.destroy();
  assert.equal(detached, true);
  assert.equal(presentation, null);
  assert.equal(controller.setMode('low'), false);
});

test('standard globe resolution stays bounded while aircraft use a separate HiDPI surface', async () => {
  const { standardResolutionScale } = await import('./renderResolution.js');
  for (const [dpr, expected] of [
    [1, 1],
    [1.25, 1],
    [1.5, 1],
    [2, 1],
    [3, 1],
    [undefined, 1],
    [NaN, 1],
  ])
    assert.equal(standardResolutionScale(dpr), expected);
});
