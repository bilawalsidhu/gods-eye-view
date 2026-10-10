import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateMaxAllowedResolutionScale,
  applyTextureSizeWorkaround,
} from './textureSizeCompat.js';

test('calculateMaxAllowedResolutionScale permits full scale when dimensions fit within texture limit', () => {
  // Standard 1080p display against 2048 max texture size
  const scale1080p = calculateMaxAllowedResolutionScale({
    clientWidth: 1920,
    clientHeight: 1080,
    pixelRatio: 1,
    maxTextureSize: 2048,
  });
  assert.equal(scale1080p, 1);

  // 4K display against 4096 max texture size
  const scale4k = calculateMaxAllowedResolutionScale({
    clientWidth: 3840,
    clientHeight: 2160,
    pixelRatio: 1,
    maxTextureSize: 4096,
  });
  assert.equal(scale4k, 1);
});

test('calculateMaxAllowedResolutionScale clamps scale when client dimensions exceed maxTextureSize', () => {
  // 2560x1440 display against 2048 max texture size (Issue #905 reproduction)
  const scale2k = calculateMaxAllowedResolutionScale({
    clientWidth: 2560,
    clientHeight: 1440,
    pixelRatio: 1,
    maxTextureSize: 2048,
  });
  assert.equal(scale2k, 2048 / 2560);
  assert.equal(scale2k, 0.8);

  // 3840x2160 display against 2048 max texture size
  const scale4k = calculateMaxAllowedResolutionScale({
    clientWidth: 3840,
    clientHeight: 2160,
    pixelRatio: 1,
    maxTextureSize: 2048,
  });
  assert.equal(scale4k, 2048 / 3840);

  // Retina 4K (3840x2160 @ 2x) against 4096 max texture size
  const scaleRetina = calculateMaxAllowedResolutionScale({
    clientWidth: 3840,
    clientHeight: 2160,
    pixelRatio: 2,
    maxTextureSize: 4096,
  });
  assert.equal(scaleRetina, 4096 / (3840 * 2));
});

test('calculateMaxAllowedResolutionScale handles zero, non-finite, and invalid inputs gracefully', () => {
  assert.equal(
    calculateMaxAllowedResolutionScale({
      clientWidth: 0,
      clientHeight: 0,
      maxTextureSize: 2048,
    }),
    1,
  );
  assert.equal(
    calculateMaxAllowedResolutionScale({
      clientWidth: -100,
      clientHeight: 500,
      maxTextureSize: 2048,
    }),
    1,
  );
  assert.equal(
    calculateMaxAllowedResolutionScale({
      clientWidth: Number.NaN,
      clientHeight: 1080,
      maxTextureSize: 2048,
    }),
    1,
  );
  assert.equal(
    calculateMaxAllowedResolutionScale({
      clientWidth: 1920,
      clientHeight: 1080,
      maxTextureSize: 0,
    }),
    1,
  );
  assert.equal(
    calculateMaxAllowedResolutionScale({
      clientWidth: 1920,
      clientHeight: 1080,
      maxTextureSize: null,
    }),
    1,
  );
});

test('applyTextureSizeWorkaround hooks widget resize and clamps resolution and canvas bounds', () => {
  const maxTextureSize = 2048;
  const canvas = {
    clientWidth: 2560,
    clientHeight: 1440,
    width: 2560,
    height: 1440,
  };

  let resizedCalled = false;
  const widget = {
    _canvas: canvas,
    _useBrowserRecommendedResolution: true,
    _resolutionScale: 1,
    resize() {
      resizedCalled = true;
      // Simulate CesiumWidget's internal resize logic
      this._canvas.width = Math.floor(
        this._canvas.clientWidth * this._resolutionScale,
      );
      this._canvas.height = Math.floor(
        this._canvas.clientHeight * this._resolutionScale,
      );
    },
  };

  const preRenderListeners = [];
  const scene = {
    context: { maximumTextureSize: maxTextureSize },
    preRender: {
      addEventListener(cb) {
        preRenderListeners.push(cb);
      },
    },
  };

  const viewer = {
    cesiumWidget: widget,
    scene,
    canvas,
  };

  applyTextureSizeWorkaround(viewer);

  // Widget resize was invoked
  assert.equal(resizedCalled, true);
  // Resolution scale was clamped to 2048 / 2560 = 0.8
  assert.equal(widget._resolutionScale, 0.8);
  // Drawing buffer dimensions strictly bounded by maximumTextureSize
  assert.ok(canvas.width <= maxTextureSize);
  assert.ok(canvas.height <= maxTextureSize);
  assert.equal(canvas.width, 2048);
  assert.equal(canvas.height, 1152);

  // Verify preRender defensive guard
  assert.equal(preRenderListeners.length, 1);
  // Force an oversized dimension and assert preRender corrects it
  canvas.width = 3000;
  canvas.height = 2500;
  preRenderListeners[0]();
  assert.equal(canvas.width, maxTextureSize);
  assert.equal(canvas.height, maxTextureSize);
});

test('hardware clamp restores the requested scale when the viewport becomes safe again', () => {
  const maxTextureSize = 2048;
  const canvas = {
    clientWidth: 2560,
    clientHeight: 1440,
    width: 2560,
    height: 1440,
  };
  const widget = {
    _canvas: canvas,
    _useBrowserRecommendedResolution: true,
    _resolutionScale: 1,
    resize() {
      this._canvas.width = Math.floor(
        this._canvas.clientWidth * this._resolutionScale,
      );
      this._canvas.height = Math.floor(
        this._canvas.clientHeight * this._resolutionScale,
      );
    },
  };
  const viewer = {
    cesiumWidget: widget,
    scene: {
      context: { maximumTextureSize: maxTextureSize },
      preRender: { addEventListener() {} },
    },
    canvas,
  };

  applyTextureSizeWorkaround(viewer);
  assert.equal(widget._resolutionScale, 0.8);

  canvas.clientWidth = 1920;
  canvas.clientHeight = 1080;
  widget.resize();

  assert.equal(widget._resolutionScale, 1);
  assert.equal(canvas.width, 1920);
  assert.equal(canvas.height, 1080);
});

test('an explicit lower scale remains the requested scale after a hardware clamp', () => {
  const canvas = {
    clientWidth: 2560,
    clientHeight: 1440,
    width: 2560,
    height: 1440,
  };
  const widget = {
    _canvas: canvas,
    _useBrowserRecommendedResolution: true,
    _resolutionScale: 1,
    resize() {
      this._canvas.width = Math.floor(
        this._canvas.clientWidth * this._resolutionScale,
      );
      this._canvas.height = Math.floor(
        this._canvas.clientHeight * this._resolutionScale,
      );
    },
  };
  const viewer = {
    cesiumWidget: widget,
    scene: {
      context: { maximumTextureSize: 2048 },
      preRender: { addEventListener() {} },
    },
    canvas,
  };

  applyTextureSizeWorkaround(viewer);
  assert.equal(widget._resolutionScale, 0.8);

  widget._resolutionScale = 0.6;
  canvas.clientWidth = 1920;
  canvas.clientHeight = 1080;
  widget.resize();

  assert.equal(widget._resolutionScale, 0.6);
  assert.equal(canvas.width, 1152);
  assert.equal(canvas.height, 648);
});

test('safe supersampling is preserved and only capped when hardware requires it', () => {
  const canvas = {
    clientWidth: 1000,
    clientHeight: 700,
    width: 1000,
    height: 700,
  };
  const widget = {
    _canvas: canvas,
    _useBrowserRecommendedResolution: true,
    _resolutionScale: 1.5,
    resize() {
      this._canvas.width = Math.floor(
        this._canvas.clientWidth * this._resolutionScale,
      );
      this._canvas.height = Math.floor(
        this._canvas.clientHeight * this._resolutionScale,
      );
    },
  };
  const viewer = {
    cesiumWidget: widget,
    scene: {
      context: { maximumTextureSize: 2048 },
      preRender: { addEventListener() {} },
    },
    canvas,
  };

  applyTextureSizeWorkaround(viewer);
  assert.equal(widget._resolutionScale, 1.5);
  assert.equal(canvas.width, 1500);

  canvas.clientWidth = 1600;
  canvas.clientHeight = 900;
  widget.resize();
  assert.equal(widget._resolutionScale, 1.28);
  assert.equal(canvas.width, 2048);

  canvas.clientWidth = 1000;
  canvas.clientHeight = 700;
  widget.resize();
  assert.equal(widget._resolutionScale, 1.5);
  assert.equal(canvas.width, 1500);
});

test('applyTextureSizeWorkaround handles null or incomplete viewer instances without error', () => {
  assert.doesNotThrow(() => applyTextureSizeWorkaround(null));
  assert.doesNotThrow(() => applyTextureSizeWorkaround({}));
  assert.doesNotThrow(() =>
    applyTextureSizeWorkaround({
      cesiumWidget: null,
      scene: { context: null },
    }),
  );
  assert.doesNotThrow(() =>
    applyTextureSizeWorkaround({
      cesiumWidget: { resize() {} },
      scene: { context: { maximumTextureSize: 0 } },
    }),
  );
});
