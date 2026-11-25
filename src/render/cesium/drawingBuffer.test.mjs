import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fitDrawingBuffer, fittedScale } from './drawingBuffer.js';

/** Cesium's `resolutionScale` setter and `resize()` sizing, in brief. */
class FakeWidget {
  constructor({ width = 1200, height = 800, browserRecommended = true } = {}) {
    this._resolutionScale = 1;
    this._forceResize = false;
    this.useBrowserRecommendedResolution = browserRecommended;
    this.canvas = {
      clientWidth: width,
      clientHeight: height,
      width: 0,
      height: 0,
      style: { imageRendering: 'pixelated' },
    };
    this.windowRef = { devicePixelRatio: 2 };
  }
  get resolutionScale() {
    return this._resolutionScale;
  }
  set resolutionScale(value) {
    if (value <= 0) throw new Error('resolutionScale must be greater than 0.');
    if (this._resolutionScale !== value) {
      this._resolutionScale = value;
      this._forceResize = true;
    }
  }
  resize() {
    const base = this.useBrowserRecommendedResolution
      ? 1
      : this.windowRef.devicePixelRatio;
    const ratio = base * this._resolutionScale;
    this.canvas.width = this.canvas.clientWidth * ratio;
    this.canvas.height = this.canvas.clientHeight * ratio;
  }
}

function guard(widget, maxSide = 2048) {
  return fitDrawingBuffer(widget, { maxSide, windowRef: widget.windowRef });
}

test('fittedScale keeps the scale asked for when it fits, else the largest that does', () => {
  assert.equal(fittedScale(2, 900, 1, 2048), 2);
  assert.equal(fittedScale(2, 1200, 1, 2048), 2048 / 1200);
  assert.equal(fittedScale(1, 2560, 1, 2048), 0.8);
  assert.equal(fittedScale(1, 1000, 2, 2048), 1);
  assert.equal(fittedScale(1.5, 2560, 1, 0), 1.5, 'no limit known');
});

test('a scale asked for that fits is drawn as asked', () => {
  const widget = new FakeWidget({ width: 900, height: 600 });
  guard(widget);
  widget.resolutionScale = 2;
  widget.resize();
  assert.equal(widget.canvas.width, 1800);
  assert.equal(widget.resolutionScale, 2);
});

test('a window grown past the texture limit is in bounds on its first resize (#905)', () => {
  const widget = new FakeWidget({ width: 1900, height: 1000 });
  guard(widget);
  widget.resize();
  assert.equal(widget.canvas.width, 1900);
  widget.canvas.clientWidth = 2560;
  widget.canvas.clientHeight = 1440;
  widget.resize();
  assert.equal(widget.canvas.width, 2048);
  assert.equal(widget.canvas.height, 1152);
  assert.equal(widget.resolutionScale, 1, 'reads the scale asked for');
  // Narrower again: the scale asked for comes back.
  widget.canvas.clientWidth = 1900;
  widget.canvas.clientHeight = 1000;
  widget.resize();
  assert.equal(widget.canvas.width, 1900);
});

test('a scale asked for past the limit is fitted at once and kept for later', () => {
  const widget = new FakeWidget({ width: 1200, height: 800 });
  guard(widget);
  widget.resolutionScale = 2;
  assert.equal(widget._forceResize, true, 'Cesium resizes on the next frame');
  widget.resize();
  assert.ok(widget.canvas.width <= 2048);
  assert.equal(widget.resolutionScale, 2);
  widget.canvas.clientWidth = 1000;
  widget.canvas.clientHeight = 600;
  widget.resize();
  assert.equal(widget.canvas.width, 2000);
});

test('the limit applies to device pixels when the browser ratio is off', () => {
  const widget = new FakeWidget({
    width: 1200,
    height: 800,
    browserRecommended: false,
  });
  guard(widget);
  widget.resize();
  assert.ok(widget.canvas.width <= 2048);
});

test('nearest-neighbour upscaling only at whole-number factors', () => {
  const widget = new FakeWidget({ width: 900, height: 600 });
  const { style } = widget.canvas;
  guard(widget);
  assert.equal(style.imageRendering, 'pixelated', '1x on a 2x screen');
  widget.resolutionScale = 2;
  assert.equal(style.imageRendering, 'pixelated', '2x on a 2x screen');
  widget.resolutionScale = 1.5;
  assert.equal(style.imageRendering, 'auto', '1.5x on a 2x screen');
  widget.resolutionScale = 1;
  assert.equal(style.imageRendering, 'pixelated');
});

test('dispose gives Cesium its own resize and the scale asked for', () => {
  const widget = new FakeWidget({ width: 2560, height: 1440 });
  const { resize } = widget;
  const dispose = guard(widget);
  assert.notEqual(widget.resize, resize);
  dispose();
  assert.equal(widget.resize, FakeWidget.prototype.resize);
  assert.equal(Object.hasOwn(widget, 'resolutionScale'), false);
  assert.equal(widget.resolutionScale, 1);
});

test('fitDrawingBuffer rejects what is not a widget', () => {
  assert.throws(() => fitDrawingBuffer({}), /CesiumWidget/);
});
