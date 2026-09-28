import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CCTV_VIDEO_SURFACE_FPS,
  CCTV_VIDEO_SURFACE_MAX_WIDTH,
  createCctvVideoSurface,
} from './cctvVideo.js';
test('second surface uses shared decoder, caps draws, clears switch and cancels teardown', () => {
  let callback;
  let draws = 0;
  let clears = 0;
  let cancelled = 0;
  const canvas = {
    width: 1,
    height: 1,
    getContext: () => ({ drawImage: () => draws++, clearRect: () => clears++ }),
  };
  let v = {
    readyState: 2,
    videoWidth: 1920,
    videoHeight: 1080,
    currentTime: 1,
  };
  const surface = createCctvVideoSurface(canvas, () => v, {
    requestFrame: (fn) => {
      callback = fn;
      return 1;
    },
    cancelFrame: () => cancelled++,
  });
  callback(0);
  callback(20);
  callback(80);
  assert.equal(draws, 1);
  assert.equal(canvas.width, CCTV_VIDEO_SURFACE_MAX_WIDTH);
  v = { ...v };
  callback(160);
  assert.equal(draws, 2);
  assert.equal(clears, 2);
  surface.stop();
  callback(200);
  assert.equal(cancelled, 1);
  assert.equal(draws, 2);
});

test('second surface draws a fresh frame every display-refresh interval', () => {
  assert.equal(CCTV_VIDEO_SURFACE_FPS, 60);
  let callback;
  let draws = 0;
  let time = 0;
  const canvas = {
    width: 1,
    height: 1,
    getContext: () => ({ drawImage: () => draws++, clearRect: () => {} }),
  };
  const v = {
    readyState: 2,
    videoWidth: 1920,
    videoHeight: 1080,
    get currentTime() {
      return time;
    },
  };
  const surface = createCctvVideoSurface(canvas, () => v, {
    requestFrame: (fn) => {
      callback = fn;
      return 1;
    },
    cancelFrame: () => {},
  });
  for (let frame = 0; frame < 10; frame++) {
    time = frame / CCTV_VIDEO_SURFACE_FPS;
    callback(frame * 17);
  }
  assert.equal(draws, 10);
  surface.stop();
});
