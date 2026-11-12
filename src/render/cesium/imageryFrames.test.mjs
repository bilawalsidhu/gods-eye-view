import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import test from 'node:test';
import {
  framesOf,
  heldFrames,
  layerDrawn,
  shownAt,
  VIDEO_STEP_MS,
  videoProvider,
} from './imageryFrames.js';

test('frames come in time order; video segments are seen at steps from start to end', () => {
  assert.deepEqual(
    framesOf({
      kind: 'frames',
      frames: [
        { time: 20, url: 'b' },
        { time: 10, url: 'a' },
        { time: NaN, url: 'x' },
      ],
    }),
    [
      { time: 10, url: 'a' },
      { time: 20, url: 'b' },
    ],
  );
  const video = framesOf({
    kind: 'video',
    segments: [
      { url: 'late', start: 5000, end: 5000 + 2 * VIDEO_STEP_MS },
      { url: 'early', start: 0, end: VIDEO_STEP_MS },
    ],
  });
  assert.deepEqual(
    video.map((f) => [f.time, f.url, f.fraction]),
    [
      [0, 'early', 0],
      [VIDEO_STEP_MS, 'early', 1],
      [5000, 'late', 0],
      [5000 + VIDEO_STEP_MS, 'late', 0.5],
      [5000 + 2 * VIDEO_STEP_MS, 'late', 1],
    ],
  );
  assert.throws(() => framesOf({ kind: 'nope' }), /Unknown timed source/);
});

test('a time shows its nearest frame, or in blend mode the two either side', () => {
  const frames = [0, 100, 200].map((time) => ({ time, url: String(time) }));
  assert.deepEqual(shownAt(frames, 40), {
    nearest: 0,
    shown: [{ index: 0, weight: 1 }],
  });
  assert.equal(shownAt(frames, 160).nearest, 2);
  assert.equal(shownAt(frames, -50).nearest, 0, 'before the first');
  assert.equal(shownAt(frames, 900).nearest, 2, 'after the last');
  assert.deepEqual(shownAt(frames, 140, 'blend'), {
    nearest: 1,
    shown: [
      { index: 1, weight: 1 },
      { index: 2, weight: 0.4 },
    ],
  });
  assert.deepEqual(shownAt(frames, 60, 'blend').shown, [
    { index: 0, weight: 1 },
    { index: 1, weight: 0.6 },
  ]);
  assert.deepEqual(shownAt(frames, 100, 'blend').shown, [
    { index: 1, weight: 1 },
  ]);
  assert.deepEqual(shownAt(frames, 900, 'blend').shown, [
    { index: 2, weight: 1 },
  ]);
  assert.equal(shownAt([], 0), null);
  assert.equal(shownAt(frames, NaN), null, 'no time yet');
});

test('the frames held are those shown and the next ones to prefetch', () => {
  const frames = [0, 1, 2, 3, 4].map((time) => ({ time, url: '' }));
  assert.deepEqual(heldFrames(frames, shownAt(frames, 1), 2), [1, 2, 3]);
  assert.deepEqual(
    heldFrames(frames, shownAt(frames, 1.5, 'blend'), 1),
    [1, 2, 3],
  );
  assert.deepEqual(heldFrames(frames, shownAt(frames, 4), 3), [4]);
});

test('a video provider asks for each tile’s video at the frame’s place in it', async () => {
  const asked = [];
  const videos = {
    frame: (url, fraction) => (asked.push([url, fraction]), 'canvas'),
  };
  const tiled = videoProvider(
    { kind: 'xyz', url: '', tiling: 'geographic' },
    { url: 'v/{z}/{x}/{y}.webm', fraction: 0.25 },
    videos,
  );
  assert.equal(await tiled.requestImage(3, 1, 2), 'canvas');
  const single = videoProvider(
    {
      kind: 'single-image',
      url: '',
      rectangle: { west: -10, south: -5, east: 10, north: 5 },
    },
    { url: 'one.webm', fraction: 0.5 },
    videos,
  );
  await single.requestImage(0, 0, 0);
  assert.deepEqual(asked, [
    ['v/2/3/1.webm', 0.25],
    ['one.webm', 0.5],
  ]);
  assert.equal(single.maximumLevel, 0, 'one tile');
  assert.ok(Math.abs(Cesium.Math.toDegrees(single.rectangle.east) - 10) < 1e-9);
});

test('a layer is drawn once every tile drawn shows its own imagery', () => {
  const layer = { ready: true, isDestroyed: () => false, rectangle: undefined };
  const other = { ready: true };
  const { READY, TRANSITIONING, FAILED } = Cesium.ImageryState;
  const world = Cesium.Rectangle.MAX_VALUE;
  const tile = (...imagery) => ({ rectangle: world, data: { imagery } });
  const own = (state, ready = true) => {
    const imagery = { imageryLayer: layer, state };
    return {
      loadingImagery: imagery,
      readyImagery: ready ? imagery : { imageryLayer: layer, state: READY },
    };
  };
  const scene = (tiles) => ({ globe: { _surface: { _tilesToRender: tiles } } });
  const theirs = { loadingImagery: { imageryLayer: other, state: READY } };
  assert.equal(layerDrawn(scene([tile(own(READY), theirs)]), layer), true);
  assert.equal(
    layerDrawn(scene([tile(own(READY)), tile(own(TRANSITIONING))]), layer),
    false,
    'one still loading',
  );
  assert.equal(
    layerDrawn(scene([tile(own(READY, false))]), layer),
    false,
    'drawn from an ancestor still',
  );
  assert.equal(
    layerDrawn(scene([tile(own(FAILED, false))]), layer),
    true,
    'failed: nothing better to come',
  );
  assert.equal(
    layerDrawn(scene([tile(theirs)]), layer),
    false,
    'its imagery not made yet',
  );
  assert.equal(layerDrawn(scene([]), layer), false, 'nothing drawn');
  assert.equal(
    layerDrawn(scene([tile(own(READY))]), { ...layer, ready: false }),
    false,
  );
});
