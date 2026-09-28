import test from 'node:test';
import assert from 'node:assert/strict';
import {
  acquireInfraredMosaic,
  decodeInfraredImage,
  processInfraredImage,
  MAX_MOSAIC_BYTES,
} from './infraredImage.js';

function canvas() {
  const output = {};
  output.getContext = () => ({
    setTransform: (...matrix) => {
      output.transforms = [...(output.transforms ?? []), matrix];
    },
    drawImage: (image) => {
      output.image = image;
      output.drawnWith = output.transforms?.at(-1) ?? null;
    },
    getImageData: () => ({ data: new Uint8ClampedArray([194, 0, 0, 200]) }),
    putImageData: (pixels) => {
      output.pixels = pixels.data;
    },
  });
  return output;
}

test('decoded pixels are processed once on a same-sized canvas', () => {
  const image = { width: 1, height: 1 };
  const output = processInfraredImage(image, 'filtered', canvas);
  assert.equal(output.width, 1);
  assert.equal(output.height, 1);
  assert.equal(output.image, image);
  assert.deepEqual([...output.pixels], [194, 0, 0, 98]);
  assert.deepEqual(
    [...processInfraredImage(image, 'full', canvas).pixels],
    [194, 0, 0, 200],
  );
});

test('flipY draws a bottom-up image upright, then restores the transform', () => {
  const image = { width: 4, height: 8 };
  assert.equal(processInfraredImage(image, 'full', canvas).drawnWith, null);
  const output = processInfraredImage(image, 'full', canvas, { flipY: true });
  assert.deepEqual(output.drawnWith, [1, 0, 0, -1, 0, 8]);
  assert.deepEqual(output.transforms.at(-1), [1, 0, 0, 1, 0, 0]);
});

test('mosaic fetch is capped at 4 MiB, forwards cancellation, and releases decoded images', async () => {
  const controller = new AbortController();
  let closes = 0,
    fetches = 0,
    clock = 10,
    fetched = false;
  const options = {
    signal: controller.signal,
    mode: 'filtered',
    createCanvas: canvas,
    now: () => clock,
    onFetched: () => {
      fetched = true;
    },
    fetchImpl: async (url, { signal }) => {
      fetches++;
      assert.match(url, /^\/api\/weather\/image\?product=clouds&time=/);
      assert.equal(signal, controller.signal);
      return new Response(new Uint8Array([1, 2, 3]));
    },
    decodeImage: async (blob) => {
      assert.equal(fetched, true);
      assert.equal(blob.size, 3);
      assert.equal(blob.type, 'image/png');
      clock = 25;
      return {
        width: 2048,
        height: 1024,
        close() {
          closes++;
        },
      };
    },
  };
  const result = await acquireInfraredMosaic(
    '2026-09-15T20:00:00.000Z',
    options,
  );
  assert.equal(fetches, 1);
  assert.equal(closes, 1);
  assert.equal(result.decodeMs, 15);
  assert.equal(result.texture.width, 2048);
  for (const response of [
    new Response('', {
      headers: { 'content-length': String(MAX_MOSAIC_BYTES + 1) },
    }),
    new Response(new Uint8Array(MAX_MOSAIC_BYTES + 1)),
  ]) {
    await assert.rejects(
      acquireInfraredMosaic('2026-09-15', {
        ...options,
        fetchImpl: async () => response,
        decodeImage: () => assert.fail('oversized image must not decode'),
      }),
      { code: 'RESPONSE_TOO_LARGE' },
    );
  }
  await assert.rejects(
    acquireInfraredMosaic('2026-09-15', {
      ...options,
      decodeImage: async () => {
        controller.abort();
        return {
          width: 2048,
          height: 1024,
          close() {
            closes++;
          },
        };
      },
    }),
    { name: 'AbortError' },
  );
  assert.equal(closes, 2);
});

test('bitmap decoding and Image fallback release resources on success, error and abort', async (t) => {
  const original = Object.getOwnPropertyDescriptor(
    globalThis,
    'createImageBitmap',
  );
  t.after(() => {
    if (original)
      Object.defineProperty(globalThis, 'createImageBitmap', original);
    else delete globalThis.createImageBitmap;
  });
  const bitmap = {};
  globalThis.createImageBitmap = async () => bitmap;
  assert.equal(
    await decodeInfraredImage(new Blob(), new AbortController().signal),
    bitmap,
  );
  globalThis.createImageBitmap = undefined;
  const images = [],
    revoked = [];
  const originalImage = globalThis.Image;
  globalThis.Image = class {
    constructor() {
      images.push(this);
    }
  };
  t.after(() => {
    if (originalImage) globalThis.Image = originalImage;
    else delete globalThis.Image;
  });
  t.mock.method(URL, 'createObjectURL', () => 'blob:test');
  t.mock.method(URL, 'revokeObjectURL', (url) => revoked.push(url));
  for (const action of ['load', 'error', 'abort']) {
    const controller = new AbortController();
    const pending = decodeInfraredImage(new Blob(), controller.signal);
    const image = images.at(-1);
    assert.equal(image.src, 'blob:test');
    if (action === 'load') {
      image.onload();
      assert.equal(await pending, image);
    } else if (action === 'error') {
      image.onerror();
      await assert.rejects(pending, /decode failed/);
    } else {
      controller.abort();
      await assert.rejects(pending, { name: 'AbortError' });
      assert.equal(image.src, '');
    }
    assert.equal(image.onload, null);
    assert.equal(image.onerror, null);
  }
  assert.deepEqual(revoked, ['blob:test', 'blob:test', 'blob:test']);
});
