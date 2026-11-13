import test from 'node:test';
import assert from 'node:assert/strict';
import {
  STORY_THUMB_HEIGHT,
  STORY_THUMB_MAX_LENGTH,
  STORY_THUMB_WIDTH,
  captureStoryThumb,
  centreCrop,
  encodeStoryThumb,
  isStoryThumb,
} from './storyThumb.js';
import { STORY_TAGS, isStoryTagList } from './storyTags.js';

/** Canvas double recording each draw; toDataURL answers `url(quality)`. */
function fakeCanvases(url = () => 'data:image/jpeg;base64,AAAA') {
  const made = [];
  const create = () => {
    const canvas = {
      width: 0,
      height: 0,
      draws: [],
      qualities: [],
      getContext: () => ({
        drawImage: (...args) => canvas.draws.push(args),
      }),
      toDataURL: (type, quality) => {
        canvas.qualities.push([type, quality]);
        return url(quality);
      },
    };
    made.push(canvas);
    return canvas;
  };
  return { made, create };
}

test('centreCrop keeps the centred 16:9 part of a wider or taller source', () => {
  assert.deepEqual(centreCrop(1920, 1080), {
    x: 0,
    y: 0,
    width: 1920,
    height: 1080,
  });
  assert.deepEqual(centreCrop(2000, 1000), {
    x: 111,
    y: 0,
    width: 1778,
    height: 1000,
  });
  assert.deepEqual(centreCrop(800, 1000), {
    x: 0,
    y: 275,
    width: 800,
    height: 450,
  });
});

test('encodeStoryThumb halves a large view down to 320x180 JPEG at 0.82', () => {
  const { made, create } = fakeCanvases();
  const source = { width: 2000, height: 1000 };
  const url = encodeStoryThumb(source, create);
  assert.equal(url, 'data:image/jpeg;base64,AAAA');
  // 1778 wide halves to 889, then 445, then the final 320x180.
  assert.deepEqual(
    made.map(({ width, height }) => [width, height]),
    [
      [889, 500],
      [445, 250],
      [STORY_THUMB_WIDTH, STORY_THUMB_HEIGHT],
    ],
  );
  assert.deepEqual(
    made[0].draws[0].slice(1),
    [111, 0, 1778, 1000, 0, 0, 889, 500],
  );
  assert.deepEqual(made.at(-1).qualities, [['image/jpeg', 0.82]]);
});

test('encodeStoryThumb lowers the quality until the image fits, then gives up', () => {
  const big = 'data:image/jpeg;base64,' + 'A'.repeat(STORY_THUMB_MAX_LENGTH);
  const fits = fakeCanvases((quality) =>
    quality > 0.6 ? big : 'data:image/jpeg;base64,AAAA',
  );
  assert.equal(
    encodeStoryThumb({ width: 320, height: 180 }, fits.create),
    'data:image/jpeg;base64,AAAA',
  );
  assert.deepEqual(
    fits.made.at(-1).qualities.map(([, quality]) => quality),
    [0.82, 0.7, 0.55],
  );
  const never = fakeCanvases(() => big);
  assert.throws(
    () => encodeStoryThumb({ width: 320, height: 180 }, never.create),
    /too large/,
  );
  assert.throws(
    () => encodeStoryThumb({ width: 0, height: 0 }, never.create),
    /Nothing to capture/,
  );
});

/** A Cesium scene double: postRender listeners run on requestRender. */
function fakeViewer({ draws = true } = {}) {
  const listeners = new Set();
  const scene = {
    canvas: { width: 640, height: 360 },
    renders: 0,
    postRender: {
      addEventListener(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    requestRender() {
      scene.renders++;
      if (draws) for (const listener of [...listeners]) listener();
    },
    listeners,
  };
  return { scene };
}

test('captureStoryThumb reads the canvas inside the postRender it requested', async () => {
  const viewer = fakeViewer();
  const { create } = fakeCanvases();
  const url = await captureStoryThumb(viewer, { createCanvas: create });
  assert.equal(url, 'data:image/jpeg;base64,AAAA');
  assert.equal(viewer.scene.renders, 1);
  assert.equal(viewer.scene.listeners.size, 0, 'the listener is removed');
});

test('captureStoryThumb gives up when no frame is drawn or there is no globe', async () => {
  const viewer = fakeViewer({ draws: false });
  await assert.rejects(
    captureStoryThumb(viewer, {
      createCanvas: fakeCanvases().create,
      timeoutMs: 1,
    }),
    /No frame was drawn/,
  );
  assert.equal(viewer.scene.listeners.size, 0);
  await assert.rejects(
    captureStoryThumb({}, { createCanvas: fakeCanvases().create }),
    /Globe not ready/,
  );
});

test('isStoryThumb accepts only bounded base64 JPEG or PNG data URLs', () => {
  assert.equal(isStoryThumb('data:image/jpeg;base64,AAAA'), true);
  assert.equal(isStoryThumb('data:image/png;base64,AAA='), true);
  for (const value of [
    '',
    null,
    42,
    'data:image/gif;base64,AAAA',
    'data:image/jpeg,AAAA',
    'https://example.com/a.jpg',
    'data:image/jpeg;base64,AA"A',
    'data:image/jpeg;base64,' + 'A'.repeat(STORY_THUMB_MAX_LENGTH),
  ])
    assert.equal(isStoryThumb(value), false, String(value).slice(0, 40));
});

test('isStoryTagList accepts up to five different known tags', () => {
  assert.equal(STORY_TAGS.length, 10);
  assert.equal(isStoryTagList([]), true);
  assert.equal(isStoryTagList(STORY_TAGS.slice(0, 5)), true);
  assert.equal(isStoryTagList(STORY_TAGS.slice(0, 6)), false);
  assert.equal(isStoryTagList(['Floods', 'Floods']), false);
  assert.equal(isStoryTagList(['floods']), false);
  assert.equal(isStoryTagList('Floods'), false);
});
