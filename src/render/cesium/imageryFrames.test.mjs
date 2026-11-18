import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import test, { mock } from 'node:test';
import {
  createTileVideos,
  framesOf,
  heldFrames,
  layerDrawn,
  shownAt,
  VIDEO_DURATION_TIMEOUT_MS,
  VIDEO_RETRY_MS,
  VIDEO_SEEK_TIMEOUT_MS,
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

/** A page whose videos load (or never do) as the test says. */
function fakeVideoPage() {
  const made = [];
  const original = globalThis.document;
  globalThis.document = {
    createElement(tag) {
      if (tag === 'canvas') return { getContext: () => ({ drawImage() {} }) };
      const target = new EventTarget();
      let time = 0;
      // Setting the time starts a seek, which the test ends (`seeked`).
      Object.defineProperty(target, 'currentTime', {
        get: () => time,
        set: (t) => {
          time = t;
          target.seeking = true;
        },
      });
      const video = Object.assign(target, {
        duration: NaN,
        seeking: false,
        videoWidth: 2,
        videoHeight: 2,
        src: '',
        removeAttribute(name) {
          if (name === 'src') video.src = '';
        },
        load() {},
      });
      made.push(video);
      return video;
    },
  };
  return { made, restore: () => (globalThis.document = original) };
}

test('frames waiting on a tile video that is let go fail, never wait forever', async () => {
  const { made, restore } = fakeVideoPage();
  try {
    const videos = createTileVideos(1);
    // Never loads.
    const first = videos.frame('a.webm', 0);
    const queued = videos.frame('a.webm', 0.5);
    // A second video past the limit lets the first go.
    const other = videos.frame('b.webm', 0);
    assert.equal(made[0].src, '', 'the first is emptied');
    await assert.rejects(first, /let go/);
    await assert.rejects(queued, /let go/);
    videos.clear();
    await assert.rejects(other, /let go/);
  } finally {
    restore();
  }
});

test('a tile video seek that never ends fails its frame after the seek timeout', async () => {
  const { made, restore } = fakeVideoPage();
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const videos = createTileVideos(4);
    const frame = videos.frame('a.webm', 0.5);
    made[0].duration = 10;
    made[0].dispatchEvent(new Event('loadeddata'));
    // Let the load settle and the seek start; it never sends `seeked`.
    for (let i = 0; i < 5; i++) await Promise.resolve();
    let failed = null;
    frame.catch((error) => (failed = error));
    mock.timers.tick(VIDEO_SEEK_TIMEOUT_MS);
    for (let i = 0; i < 5; i++) await Promise.resolve();
    assert.match(String(failed), /did not seek/);
  } finally {
    mock.timers.reset();
    restore();
  }
});

/** Let promise callbacks run. */
const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

/** End a fake video's seek. */
const endSeek = (video) => {
  video.seeking = false;
  video.dispatchEvent(new Event('seeked'));
};

test('after a seek that timed out, the video is not loaded again for a while, then afresh rather than drawing what shows', async () => {
  const { made, restore } = fakeVideoPage();
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  try {
    const videos = createTileVideos(4);
    const first = videos.frame('a.webm', 0.5);
    first.catch(() => {});
    made[0].duration = 10;
    made[0].dispatchEvent(new Event('loadeddata'));
    await flush();
    mock.timers.tick(VIDEO_SEEK_TIMEOUT_MS);
    await assert.rejects(first, /did not seek/);
    assert.equal(made[0].src, '', 'the stuck video is let go');
    // Asked again soon: failed at once, never waited on for another timeout.
    await assert.rejects(videos.frame('a.webm', 0.5), /failed to load lately/);
    assert.equal(made.length, 1, 'not loaded again');
    mock.timers.tick(VIDEO_RETRY_MS);
    let drawn = false;
    const second = videos.frame('a.webm', 0.5).then(() => (drawn = true));
    assert.equal(made.length, 2, 'a fresh video');
    made[1].duration = 10;
    made[1].dispatchEvent(new Event('loadeddata'));
    await flush();
    assert.equal(drawn, false, 'waits for its own seek');
    endSeek(made[1]);
    await second;
    assert.equal(drawn, true);
  } finally {
    mock.timers.reset();
    restore();
  }
});

test('clear forgets the videos that failed, so each is loaded again at once', async () => {
  const { made, restore } = fakeVideoPage();
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  try {
    const videos = createTileVideos(4);
    const first = videos.frame('a.webm', 0.5);
    made[0].dispatchEvent(new Event('error'));
    await assert.rejects(first, /did not load/);
    await assert.rejects(videos.frame('a.webm', 0.5), /failed to load lately/);
    videos.clear();
    const again = videos.frame('a.webm', 0.5);
    assert.equal(made.length, 2, 'loaded again');
    made[1].duration = 10;
    made[1].dispatchEvent(new Event('loadeddata'));
    await flush();
    endSeek(made[1]);
    assert.ok(await again);
  } finally {
    mock.timers.reset();
    restore();
  }
});

test('a video’s length is learnt with a longer wait, and a failed one is not loaded again for a while', async () => {
  const { made, restore } = fakeVideoPage();
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  try {
    const videos = createTileVideos(4);
    let failed = null;
    videos.frame('a.webm', 0.5).catch((error) => (failed = error));
    // No duration: it seeks past its end to learn it.
    made[0].dispatchEvent(new Event('loadeddata'));
    await flush();
    mock.timers.tick(VIDEO_SEEK_TIMEOUT_MS);
    await flush();
    assert.equal(failed, null, 'not on the short seek wait');
    mock.timers.tick(VIDEO_DURATION_TIMEOUT_MS);
    await flush();
    assert.match(String(failed), /did not seek/);
    // Asked again soon: failed at once, not downloaded again.
    await assert.rejects(videos.frame('a.webm', 0.5), /failed to load lately/);
    assert.equal(made.length, 1);
    // Later: a fresh video, which loads this time.
    mock.timers.tick(VIDEO_RETRY_MS);
    const again = videos.frame('a.webm', 0.5);
    assert.equal(made.length, 2, 'started over');
    made[1].duration = 10;
    made[1].dispatchEvent(new Event('loadeddata'));
    await flush();
    endSeek(made[1]);
    assert.ok(await again);
  } finally {
    mock.timers.reset();
    restore();
  }
});
