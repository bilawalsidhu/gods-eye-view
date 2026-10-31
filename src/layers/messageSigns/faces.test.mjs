import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FACE_BUDGET,
  clampFrameDelayMs,
  createFaceSlot,
  drawFaceFrame,
  faceCssSize,
  openGifFrames,
  selectFaceIds,
} from './faces.js';

function gifBytes(width, height) {
  const bytes = new Uint8Array(32);
  bytes.set([...'GIF89a'].map((c) => c.charCodeAt(0)));
  bytes.set([width & 255, width >> 8, height & 255, height >> 8], 6);
  return bytes;
}

test('a face is half the size of its GIF; oversized GIFs get none', () => {
  assert.deepEqual(faceCssSize(gifBytes(412, 100)), { width: 206, height: 50 });
  assert.deepEqual(faceCssSize(gifBytes(450, 86)), { width: 225, height: 43 });
  assert.equal(faceCssSize(gifBytes(700, 100)), null);
  assert.equal(faceCssSize(new Uint8Array([1, 2, 3])), null);
});

test('the nearest signs get faces, and none above the face altitude', () => {
  // 60 signs strung east of downtown Minneapolis, about 0.8 km apart.
  const signs = Array.from({ length: 60 }, (_, i) => ({
    id: `V${String(i).padStart(2, '0')}`,
    lat: 44.98,
    lon: -93.27 + i * 0.01,
  }));
  const downtown = { lat: 44.98, lon: -93.27, heightM: 1500 };
  const near = selectFaceIds(signs, downtown);
  assert.equal(near.length, FACE_BUDGET);
  assert.deepEqual(near.slice(0, 3), ['V00', 'V01', 'V02']);

  const east = selectFaceIds(signs, { ...downtown, lon: -92.68 });
  assert.equal(east[0], 'V59');
  assert.notDeepEqual(east, near);

  assert.deepEqual(selectFaceIds(signs, { ...downtown, heightM: 9000 }), []);
  assert.deepEqual(
    selectFaceIds(signs, { lat: 46.8, lon: -92.1, heightM: 900 }),
    [],
  );
  assert.deepEqual(selectFaceIds(signs, null), []);
});

test('frame delays are clamped, and zero means three seconds', () => {
  assert.equal(clampFrameDelayMs(0), 3000);
  assert.equal(clampFrameDelayMs(Number.NaN), 3000);
  assert.equal(clampFrameDelayMs(100), 500);
  assert.equal(clampFrameDelayMs(1000), 1000);
  assert.equal(clampFrameDelayMs(60_000), 10_000);
});

test('ImageDecoder gives every frame and its duration', async () => {
  const closed = [];
  class FakeDecoder {
    static async isTypeSupported(type) {
      return type === 'image/gif';
    }
    constructor({ data, type }) {
      assert.equal(type, 'image/gif');
      this.data = data;
      this.tracks = {
        ready: Promise.resolve(),
        selectedTrack: { frameCount: 2 },
      };
    }
    async decode({ frameIndex }) {
      return {
        image: {
          frameIndex,
          duration: 1_000_000,
          close: () => closed.push(frameIndex),
        },
      };
    }
    close() {
      closed.push('decoder');
    }
  }
  const gif = await openGifFrames(gifBytes(308, 100), {
    ImageDecoder: FakeDecoder,
  });
  assert.equal(gif.frameCount, 2);
  const second = await gif.decode(1);
  assert.equal(second.image.frameIndex, 1);
  assert.equal(second.durationMs, 1000);
  second.close();
  gif.close();
  assert.deepEqual(closed, [1, 'decoder']);
});

test('without ImageDecoder a face shows its first frame only', async () => {
  const bitmap = { close() {} };
  let blobType;
  const gif = await openGifFrames(gifBytes(412, 100), {
    createImageBitmap: async (blob) => {
      blobType = blob.type;
      return bitmap;
    },
  });
  assert.equal(blobType, 'image/gif');
  assert.equal(gif.frameCount, 1);
  assert.equal((await gif.decode(0)).image, bitmap);
});

test('drawing a frame repaints the slot and bumps its stamp; stale dims it', () => {
  const calls = [];
  const createCanvas = (width, height) => ({
    width,
    height,
    getContext: () => ({
      set imageSmoothingEnabled(value) {
        calls.push(['smoothing', value]);
      },
      set fillStyle(value) {
        calls.push(['fillStyle', value]);
      },
      clearRect: (...args) => calls.push(['clear', ...args]),
      drawImage: (_image, ...args) => calls.push(['draw', ...args]),
      fillRect: (...args) => calls.push(['fill', ...args]),
    }),
  });
  const slot = createFaceSlot({ width: 206, height: 50 }, createCanvas);
  assert.equal(slot.frame.width, 412);
  assert.equal(slot.frame.height, 100);
  assert.equal(slot.stamp, 0);

  drawFaceFrame(slot, {});
  assert.equal(slot.stamp, 1);
  assert.deepEqual(calls, [
    ['smoothing', false],
    ['clear', 0, 0, 412, 100],
    ['draw', 0, 0, 412, 100],
  ]);

  calls.length = 0;
  drawFaceFrame(slot, {}, { stale: true });
  assert.equal(slot.stamp, 2);
  assert.deepEqual(calls.slice(-2), [
    ['fillStyle', 'rgba(0, 0, 0, 0.5)'],
    ['fill', 0, 0, 412, 100],
  ]);
});
