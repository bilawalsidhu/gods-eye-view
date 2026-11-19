import assert from 'node:assert/strict';
import test from 'node:test';
import { bindRenderer } from '../render/rendererOf.js';
import {
  captureViewportImage,
  capturePointerCrop,
} from './realtimeViewport.js';

/**
 * A page with a bound renderer whose canvas must never be read directly:
 * its pixels come only through `readPixels`, as the frame it just drew.
 */
function page({ cssWidth = 800, cssHeight = 600, dpr = 2, dprY = dpr } = {}) {
  const canvas = {
    width: cssWidth * dpr,
    height: cssHeight * dprY,
    clientWidth: cssWidth,
    clientHeight: cssHeight,
  };
  let fire = null;
  const reads = [];
  let drawn = false;
  const renderer = {
    canvas,
    frame: {
      on(phase, cb) {
        if (phase !== 'postRender') return () => {};
        fire = cb;
        return () => (fire = null);
      },
      requestRender() {
        queueMicrotask(() => {
          drawn = true;
          fire?.();
          drawn = false;
        });
      },
    },
    readPixels(options) {
      reads.push({ ...options, duringFrame: drawn });
      const width = Math.round(
        (options.crop?.width ?? cssWidth) * options.scale,
      );
      const height = Math.round(
        (options.crop?.height ?? cssHeight) * options.scale,
      );
      return {
        width,
        height,
        data: new Uint8ClampedArray(width * height * 4).fill(200),
      };
    },
  };
  const viewer = {};
  bindRenderer(viewer, renderer);
  const put = [];
  const encoded = [];
  const document = {
    hidden: false,
    createElement() {
      const out = {
        width: 0,
        height: 0,
        getContext: () => ctx,
        toDataURL: (type) => {
          encoded.push([out.width, out.height]);
          return `data:${type};base64,AAAA`;
        },
      };
      const ctx = {
        canvas: out,
        putImageData: (image, x, y) =>
          put.push([image.width, image.height, x, y]),
        drawImage(source) {
          assert.notEqual(
            source,
            canvas,
            'the renderer’s canvas is never drawn',
          );
        },
        getImageData: (x, y, w, h) => ({
          data: new Uint8ClampedArray(w * h * 4).fill(200),
        }),
        beginPath() {},
        arc() {},
        stroke() {},
      };
      return out;
    },
    querySelector: () => canvas,
  };
  return { viewer, reads, put, encoded, document };
}

function withPage(p, fn) {
  const saved = [globalThis.window, globalThis.document];
  globalThis.window = { __godsEyeView: { viewer: p.viewer } };
  globalThis.document = p.document;
  return Promise.resolve(fn()).finally(() => {
    [globalThis.window, globalThis.document] = saved;
  });
}

test('the viewport image is the renderer’s readPixels of the fresh frame, as it is drawn', async () => {
  const p = page();
  const image = await withPage(p, () => captureViewportImage());
  assert.match(image, /^data:image\/jpeg;base64,/);
  assert.equal(p.reads.length, 1);
  const [read] = p.reads;
  assert.equal(read.duringFrame, true, 'read in the frame it waited for');
  assert.equal(read.crop, undefined, 'the whole canvas');
  // 1600 × 1200 drawing-buffer pixels, cut to the 1200 × 900 budget.
  assert.deepEqual(p.put, [[1200, 900, 0, 0]]);
});

test('the pointer crop is the renderer’s readPixels around the pointer, as the frame is drawn', async () => {
  const p = page();
  const crop = await withPage(p, () => capturePointerCrop({ x: 400, y: 300 }));
  assert.ok(crop?.dataUrl);
  assert.deepEqual(crop.rect, { x: 0.18, y: 44 / 600, w: 0.64, h: 512 / 600 });
  const [read] = p.reads;
  assert.equal(read.duringFrame, true);
  assert.deepEqual(read.crop, { x: 144, y: 44, width: 512, height: 512 });
  assert.deepEqual(p.put, [[512, 512, 0, 0]]);
});

test('the pointer crop is its full square even where the canvas is stretched unevenly', async () => {
  // Drawing-buffer pixels three to a CSS pixel across and 0.3 down: the
  // crop read back is a row taller than it is wide.
  const p = page({ dpr: 3, dprY: 0.3 });
  const crop = await withPage(p, () => capturePointerCrop({ x: 400, y: 300 }));
  assert.ok(crop?.dataUrl);
  assert.deepEqual(p.encoded, [[512, 512]], 'a 512 px square');
});
