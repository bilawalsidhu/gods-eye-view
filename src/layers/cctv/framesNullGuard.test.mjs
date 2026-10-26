import test from 'node:test';
import assert from 'node:assert/strict';
import { createFrames } from './frames.js';

function harness(getFrameUrl) {
  const srcs = [];
  return {
    parts: createFrames({
      state: { _activeCameraId: 'other' },
      services: {},
      parts: {},
      source: { getFrameUrl },
    }),
    srcs,
  };
}

function imageRecord() {
  const sets = [];
  return {
    camera: { id: 'cam-1' },
    projection: {
      mode: 'image',
      lastImageRefreshAt: 0,
      imageLoading: false,
      imageReady: false,
      image: {
        set src(v) {
          sets.push(v);
        },
      },
    },
    sets,
  };
}

test('null frame URL skips the image load without throwing', () => {
  const { parts } = harness(() => null);
  const record = imageRecord();
  parts.refreshProjectionImage(record, true);
  assert.equal(record.sets.length, 0);
  assert.equal(record.projection.imageLoading, false);
});

test('real frame URL still loads with a cache-busting tick', () => {
  const { parts } = harness(() => 'https://example.com/frame.jpg');
  const record = imageRecord();
  parts.refreshProjectionImage(record, true);
  assert.equal(record.sets.length, 1);
  assert.match(record.sets[0], /^https:\/\/example\.com\/frame\.jpg\?projTs=/);
});
