// src/layers/cctv/frames.test.mjs
// Still-frame fit (#1201): stills draw at their source aspect, centered on the
// 1920x1080 projection canvas, instead of being stretched to fill it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
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

// A camera's monitor plane is fetched only while it can be on screen. The
// viewer is a Cesium camera description over the real WGS84 globe: it hovers
// 30 km above a mount at (0, 0) and looks straight down, so the plane is in
// front of it; turned around, or moved to the far side of the globe, the
// plane is not.
const MOUNT = Cesium.Cartesian3.fromDegrees(0, 0, 20);
const point = (lon, lat, alt = 20) =>
  Cesium.Cartesian3.fromDegrees(lon, lat, alt);

function planeRecord() {
  const image = {};
  return {
    camera: { id: 'plane' },
    billboard: { position: MOUNT },
    frustumPositions: {
      mount: MOUNT,
      capCenter: point(0.0005, 0, 20),
      tl: point(0.0004, 0.0001),
      tr: point(0.0006, 0.0001),
      br: point(0.0006, -0.0001),
      bl: point(0.0004, -0.0001),
    },
    projection: {
      mode: 'image',
      image,
      imageLoading: false,
      imageReady: false,
      lastImageRefreshAt: 0,
    },
  };
}

function viewerAt(position, direction, up) {
  return {
    isDestroyed: () => false,
    scene: { mode: Cesium.SceneMode.SCENE3D },
    camera: {
      positionWC: position,
      directionWC: direction,
      upWC: up,
      frustum: new Cesium.PerspectiveFrustum({
        fov: Cesium.Math.toRadians(60),
        aspectRatio: 16 / 9,
        near: 1,
        far: 5e6,
      }),
    },
  };
}

// Above the mount, looking straight down at the ground.
function lookingDown() {
  const position = point(0, 0, 30000);
  return viewerAt(
    position,
    Cesium.Cartesian3.negate(Cesium.Cartesian3.UNIT_X, new Cesium.Cartesian3()),
    Cesium.Cartesian3.UNIT_Z,
  );
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

test('a plane in front of the camera fetches its picture', () => {
  const frames = framesFor(lookingDown());
  const record = planeRecord();
  assert.equal(frames.projectionInView(record), true);
  frames.refreshProjectionImage(record);
  assert.match(
    record.projection.image.src,
    /^\/api\/cctv\/frame\?id=plane&projTs=/,
  );
  assert.equal(record.projection.imageLoading, true);
});

test('a plane behind the camera is not fetched, but a forced refresh is', () => {
  const down = lookingDown();
  const away = viewerAt(
    down.camera.positionWC,
    Cesium.Cartesian3.UNIT_X,
    Cesium.Cartesian3.UNIT_Z,
  );
  const frames = framesFor(away);
  const record = planeRecord();
  assert.equal(frames.projectionInView(record), false);
  frames.refreshProjectionImage(record);
  assert.equal(record.projection.image.src, undefined);
  assert.equal(record.projection.lastImageRefreshAt, 0);
  frames.refreshProjectionImage(record, true);
  assert.match(record.projection.image.src, /projTs=/);
});

test('a plane below the horizon is not fetched', () => {
  const far = point(180, 0, 30000);
  const viewer = viewerAt(
    far,
    Cesium.Cartesian3.normalize(
      Cesium.Cartesian3.subtract(MOUNT, far, new Cesium.Cartesian3()),
      new Cesium.Cartesian3(),
    ),
    Cesium.Cartesian3.UNIT_Z,
  );
  const frames = framesFor(viewer);
  assert.equal(frames.projectionInView(planeRecord()), false);
});

test('a skipped refresh does not use up the interval: the plane fetches once it is back in view', () => {
  const record = planeRecord();
  const frames = framesFor(lookingDown());
  const away = viewerAt(
    lookingDown().camera.positionWC,
    Cesium.Cartesian3.UNIT_X,
    Cesium.Cartesian3.UNIT_Z,
  );
  const awayFrames = framesFor(away);
  awayFrames.refreshProjectionImage(record);
  assert.equal(record.projection.image.src, undefined);
  frames.refreshProjectionImage(record);
  assert.match(record.projection.image.src, /projTs=/);
});

test('what cannot be judged counts as visible', () => {
  const record = planeRecord();
  assert.equal(framesFor(null).projectionInView(record), true);
  assert.equal(
    framesFor({ ...lookingDown(), isDestroyed: () => true }).projectionInView(
      record,
    ),
    true,
  );
  const flat = lookingDown();
  flat.scene.mode = Cesium.SceneMode.SCENE2D;
  assert.equal(framesFor(flat).projectionInView(record), true);
  const noGeometry = { camera: { id: 'plane' }, projection: record.projection };
  assert.equal(framesFor(lookingDown()).projectionInView(noGeometry), true);
});
