// src/layers/cctv/frames.test.mjs
// Still-frame fit (#1201): stills draw at their source aspect, centered on the
// 1920x1080 projection canvas, instead of being stretched to fill it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFrames, fitToProjection } from './frames.js';
import {
  FRAME_SIGNATURE_W,
  FRAME_SIGNATURE_H,
  PROJECTION_CANVAS_WIDTH,
  PROJECTION_CANVAS_HEIGHT,
  PROJECTION_MATTE_COLOR,
} from './policy.js';

// The expected rectangles below are written for a 1920x1080 canvas.
assert.equal(PROJECTION_CANVAS_WIDTH, 1920);
assert.equal(PROJECTION_CANVAS_HEIGHT, 1080);

const FULL_CANVAS = {
  x: 0,
  y: 0,
  w: PROJECTION_CANVAS_WIDTH,
  h: PROJECTION_CANVAS_HEIGHT,
};

test('a 4:3 still is pillarboxed at full height', () => {
  assert.deepEqual(fitToProjection(640, 480), {
    x: 240,
    y: 0,
    w: 1440,
    h: 1080,
  });
});

test('a source wider than 16:9 is letterboxed at full width', () => {
  assert.deepEqual(fitToProjection(3840, 1080), {
    x: 0,
    y: 270,
    w: 1920,
    h: 540,
  });
});

test('a 16:9 still fills the canvas', () => {
  assert.deepEqual(fitToProjection(1920, 1080), FULL_CANVAS);
});

test('a missing or zero dimension falls back to the full canvas', () => {
  assert.deepEqual(fitToProjection(0, 480), FULL_CANVAS);
  assert.deepEqual(fitToProjection(640, 0), FULL_CANVAS);
  assert.deepEqual(fitToProjection(640, undefined), FULL_CANVAS);
  assert.deepEqual(fitToProjection(undefined, undefined), FULL_CANVAS);
});

// Draw path: the fit reaches drawImage, and the unchanged-frame skip keys on the
// fitted size as well as the pixels (the 64x36 hash alone drops aspect).
function stillHarness() {
  const calls = [];
  const ctx = {
    fillStyle: null,
    fillRect: (...rect) => calls.push(['fillRect', ctx.fillStyle, ...rect]),
    clearRect: () => {},
    drawImage: (_image, ...rect) => calls.push(['drawImage', ...rect]),
  };
  // Every frame downsamples to the same pixels, so only the size differs.
  const pixels = new Uint8ClampedArray(
    FRAME_SIGNATURE_W * FRAME_SIGNATURE_H * 4,
  ).fill(7);
  const runtime = {
    mode: 'image',
    ctx,
    image: { naturalWidth: 0, naturalHeight: 0 },
    imageReady: true,
    // In flight, so refreshProjectionImage returns before touching image.src.
    imageLoading: true,
    imageStamp: 0,
    drawnImageStamp: -1,
    lastFrameSignature: null,
    canvasStamp: 0,
    signatureCtx: {
      clearRect: () => {},
      drawImage: () => {},
      getImageData: () => ({ data: pixels }),
    },
  };
  const record = { camera: { id: 'still' }, projection: runtime };
  const { drawProjectionFrame } = createFrames({
    state: { _healthById: new Map(), _activeCameraId: null },
    services: {},
    parts: {},
    source: {},
  });
  const load = (width, height) => {
    runtime.image = { naturalWidth: width, naturalHeight: height };
    runtime.imageStamp += 1;
    calls.length = 0;
    drawProjectionFrame(record);
    return calls.slice();
  };
  return { runtime, load };
}

test('a still is drawn into its fitted rectangle over a full matte', () => {
  const { runtime, load } = stillHarness();
  assert.deepEqual(load(640, 480), [
    [
      'fillRect',
      PROJECTION_MATTE_COLOR,
      0,
      0,
      PROJECTION_CANVAS_WIDTH,
      PROJECTION_CANVAS_HEIGHT,
    ],
    ['drawImage', 240, 0, 1440, 1080],
  ]);
  assert.equal(runtime.canvasStamp, 1);
});

test('same pixels at the same size skip the redraw', () => {
  const { runtime, load } = stillHarness();
  load(640, 480);
  assert.deepEqual(load(640, 480), []);
  assert.equal(runtime.canvasStamp, 1);
});

test('same pixels at a new aspect redraw at the new fit', () => {
  const { runtime, load } = stillHarness();
  load(640, 480);
  assert.deepEqual(load(1920, 1080), [
    [
      'fillRect',
      PROJECTION_MATTE_COLOR,
      0,
      0,
      PROJECTION_CANVAS_WIDTH,
      PROJECTION_CANVAS_HEIGHT,
    ],
    ['drawImage', 0, 0, 1920, 1080],
  ]);
  assert.equal(runtime.canvasStamp, 2);
});
