// src/layers/cctv/frames.test.mjs
// Still-frame fit (#1201): stills draw at their source aspect, centered on the
// 1920x1080 projection canvas, instead of being stretched to fill it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bindRenderer } from '../../render/rendererOf.js';
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

test('same pixels at a new resolution with the same fit skip the redraw', () => {
  const { runtime, load } = stillHarness();
  load(640, 480);
  assert.deepEqual(load(1280, 960), []);
  assert.equal(runtime.canvasStamp, 1);
  assert.equal(runtime.drawnImageStamp, 2);
});

test('changed pixels redraw even when the fitted rectangle is unchanged', () => {
  const { runtime, load } = stillHarness();
  load(640, 480);
  const changedPixels = new Uint8ClampedArray(
    FRAME_SIGNATURE_W * FRAME_SIGNATURE_H * 4,
  ).fill(90);
  runtime.signatureCtx.getImageData = () => ({ data: changedPixels });
  const calls = load(640, 480);
  assert.equal(calls[0][0], 'fillRect');
  assert.deepEqual(calls[1], ['drawImage', 240, 0, 1440, 1080]);
  assert.equal(runtime.canvasStamp, 2);
});

test('a failed pixel signature redraws rather than assuming equal content', () => {
  const { runtime, load } = stillHarness();
  load(640, 480);
  runtime.signatureCtx.getImageData = () => {
    throw new Error('tainted canvas');
  };
  assert.deepEqual(load(640, 480).at(-1), ['drawImage', 240, 0, 1440, 1080]);
  assert.equal(runtime.canvasStamp, 2);
});

const MOUNT = { x: 0, y: 0, z: 0 };

function planeRecord() {
  return {
    camera: { id: 'plane' },
    position: MOUNT,
    frustumPositions: {
      mount: MOUNT,
      capCenter: { x: 1, y: 0, z: 0 },
      tl: { x: 1, y: -1, z: 1 },
      tr: { x: 1, y: 1, z: 1 },
      br: { x: 1, y: 1, z: -1 },
      bl: { x: 1, y: -1, z: -1 },
    },
    projection: {
      mode: 'image',
      image: {},
      imageLoading: false,
      imageReady: false,
      lastImageRefreshAt: 0,
    },
  };
}

function framesFor(viewer) {
  const state = {
    _viewer: viewer,
    _healthById: new Map(),
    _activeCameraId: 'plane',
  };
  return createFrames({
    state,
    services: {},
    parts: {
      model: {
        safeNumber: (value, fallback) =>
          Number.isFinite(Number(value)) ? Number(value) : fallback,
      },
    },
    source: { getFrameUrl: () => '/api/cctv/frame?id=plane' },
  });
}

function framesWithCamera(t, camera) {
  const host = {};
  t.after(bindRenderer(host, { camera }));
  return framesFor(host);
}

test('a plane the renderer may show fetches its picture', (t) => {
  const visiblePoints = t.mock.fn(() => true);
  const frames = framesWithCamera(t, { visiblePoints });
  const record = planeRecord();
  frames.refreshProjectionImage(record);
  assert.match(
    record.projection.image.src,
    /^\/api\/cctv\/frame\?id=plane&projTs=/,
  );
  assert.equal(record.projection.imageLoading, true);
  assert.equal(visiblePoints.mock.callCount(), 1);
  const [points, margin] = visiblePoints.mock.calls[0].arguments;
  const { mount, tl, tr, br, bl } = record.frustumPositions;
  assert.deepEqual(points, [mount, tl, tr, br, bl]);
  assert.equal(points[0], mount);
  assert.equal(margin, 200);
});

test('a plane the renderer cannot show is not fetched, but a forced refresh is', (t) => {
  const frames = framesWithCamera(t, { visiblePoints: () => false });
  const record = planeRecord();
  frames.refreshProjectionImage(record);
  assert.equal(record.projection.image.src, undefined);
  assert.equal(record.projection.lastImageRefreshAt, 0);
  frames.refreshProjectionImage(record, true);
  assert.match(record.projection.image.src, /projTs=/);
});

test('a skipped refresh does not use up the interval', (t) => {
  let visible = false;
  const frames = framesWithCamera(t, { visiblePoints: () => visible });
  const record = planeRecord();
  frames.refreshProjectionImage(record);
  assert.equal(record.projection.image.src, undefined);
  visible = true;
  frames.refreshProjectionImage(record);
  assert.match(record.projection.image.src, /projTs=/);
});

test('what cannot be judged counts as visible', (t) => {
  for (const frames of [
    framesWithCamera(t, { visiblePoints: () => null }),
    framesWithCamera(t, { pose: () => ({}) }),
    framesFor(null),
  ]) {
    const record = planeRecord();
    frames.refreshProjectionImage(record);
    assert.match(record.projection.image.src, /projTs=/);
  }

  const noGeometry = planeRecord();
  delete noGeometry.frustumPositions;
  const visiblePoints = t.mock.fn(() => false);
  framesWithCamera(t, { visiblePoints }).refreshProjectionImage(noGeometry);
  assert.equal(visiblePoints.mock.callCount(), 0);
  assert.match(noGeometry.projection.image.src, /projTs=/);
});
