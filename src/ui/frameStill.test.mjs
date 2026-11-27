// A camera pin's still is the frame as it was, saved small: never a URL
// that would fetch a newer frame.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  STILL_MAX_CHARS,
  STILL_MAX_WIDTH,
  captureCameraPin,
  _setFrameStillCaptureForTest,
  captureFrameStill,
  encodeStill,
  isBlankFrame,
} from './frameStill.js';

/** A canvas double whose data URL grows with its width and quality. */
function fakeDocument({ bytesPerPixel = 1, taint = false, getImageData } = {}) {
  const made = [];
  return {
    made,
    createElement(tag) {
      assert.equal(tag, 'canvas');
      const canvas = {
        width: 0,
        height: 0,
        getContext: () => ({
          getImageData,
          drawImage(source, x, y, w, h) {
            canvas.drawn = { source, w, h };
          },
        }),
        toDataURL(type, quality) {
          if (taint) throw new Error('SecurityError');
          const size = Math.round(
            canvas.width * canvas.height * bytesPerPixel * quality,
          );
          return `data:${type};base64,${'A'.repeat(size)}`;
        },
      };
      made.push(canvas);
      return canvas;
    },
  };
}

test('blank detection checks every sampled RGB sum and leaves unreadable frames unclassified', () => {
  const data = new Uint8ClampedArray(32 * 18 * 4).fill(8);
  for (let i = 3; i < data.length; i += 4) data[i] = 255;
  const frame = { width: 640, height: 360 };
  const document = fakeDocument({ getImageData: () => ({ data }) });
  assert.equal(isBlankFrame(frame, { document }), true);
  data[data.length - 2] = 9;
  assert.equal(isBlankFrame(frame, { document }), false);
  const unreadable = fakeDocument({
    getImageData() {
      throw new Error('unreadable');
    },
  });
  assert.equal(isBlankFrame(frame, { document: unreadable }), false);
  data[data.length - 2] = 8;
  assert.equal(isBlankFrame({ width: 0, height: 0 }, { document }), false);
});

test('a frame is saved downscaled to at most 320 px wide, as a JPEG data URL', () => {
  const document = fakeDocument({ bytesPerPixel: 0.2 });
  const url = encodeStill(
    { naturalWidth: 1280, naturalHeight: 720 },
    { document },
  );
  assert.match(url, /^data:image\/jpeg;base64,/);
  assert.equal(document.made[0].width, STILL_MAX_WIDTH);
  assert.equal(document.made[0].height, 180);
  assert.ok(url.length <= STILL_MAX_CHARS);
});

test('a portrait frame fits the thumbnail bounds before it is encoded', () => {
  const document = fakeDocument({ bytesPerPixel: 0.2 });
  const still = encodeStill(
    { naturalWidth: 600, naturalHeight: 1200 },
    { document },
  );
  assert.match(still, /^data:image\/jpeg/);
  assert.deepEqual(
    document.made.map(({ width, height }) => [width, height]),
    [[160, 320]],
  );
});

test('a still too large is made smaller and plainer until it fits, or not kept', () => {
  const fits = fakeDocument({ bytesPerPixel: 2 });
  const url = encodeStill(
    { naturalWidth: 1280, naturalHeight: 720 },
    { document: fits },
  );
  assert.ok(url && url.length <= STILL_MAX_CHARS, 'shrunk to fit');
  assert.ok(fits.made.length > 1, 'it took more than one try');
  const never = fakeDocument({ bytesPerPixel: 1000 });
  assert.equal(
    encodeStill(
      { naturalWidth: 1280, naturalHeight: 720 },
      { document: never },
    ),
    '',
  );
});

test('an unloaded or tainted frame gives no still', () => {
  assert.equal(
    encodeStill(
      { naturalWidth: 0, naturalHeight: 0 },
      { document: fakeDocument() },
    ),
    '',
  );
  assert.equal(
    encodeStill(
      { naturalWidth: 640, naturalHeight: 360 },
      { document: fakeDocument({ taint: true }) },
    ),
    '',
  );
});

test('with nothing on screen the frame URL is read once, and the still is its data, not the URL', async () => {
  const loads = [];
  class FakeImage {
    set src(value) {
      loads.push(value);
      this.naturalWidth = 640;
      this.naturalHeight = 360;
      queueMicrotask(() => this.onload());
    }
  }
  const document = fakeDocument({ bytesPerPixel: 0.2 });
  const still = await captureFrameStill(
    { shown: null, url: '/api/cctv/frame/cam-1?ts=1' },
    { document, Image: FakeImage },
  );
  assert.deepEqual(loads, ['/api/cctv/frame/cam-1?ts=1']);
  assert.match(still, /^data:image\/jpeg/);
  assert.doesNotMatch(still, /\/api\/cctv/);
  // What the card shows wins, with no request at all.
  const shown = await captureFrameStill(
    {
      shown: { naturalWidth: 640, naturalHeight: 360 },
      url: '/api/cctv/frame/cam-1?ts=2',
    },
    { document, Image: FakeImage },
  );
  assert.match(shown, /^data:image\/jpeg/);
  assert.equal(loads.length, 1);
});

test('camera pins encode only a publisher image identified by the exact response', async (t) => {
  const captured = [];
  _setFrameStillCaptureForTest(async (args) => {
    captured.push(args);
    return 'saved';
  });
  t.after(() => _setFrameStillCaptureForTest(null));
  const shown = { tagName: 'IMG' };
  assert.equal(await captureCameraPin(shown, { url: '/untagged.jpg' }), '');
  const released = [];
  const reads = [];
  for (const kind of ['streetview', null, 'synthetic', 'upstream-image']) {
    const readImage = async (_signal, options) => {
      reads.push(options?.liveOnly);
      return {
        url: 'blob:verified',
        sourceKind: kind,
        release: () => released.push(kind),
      };
    };
    assert.equal(
      await captureCameraPin(shown, { readImage }),
      kind === 'upstream-image' ? 'saved' : '',
    );
  }
  const controller = new AbortController();
  const discarded = t.mock.fn();
  const interrupted = await captureCameraPin(
    shown,
    {
      async readImage(signal) {
        assert.equal(signal, controller.signal);
        controller.abort();
        return {
          url: 'blob:removed',
          sourceKind: 'upstream-image',
          release: discarded,
        };
      },
    },
    controller.signal,
  );
  assert.equal(interrupted, '');
  assert.equal(discarded.mock.callCount(), 1);
  assert.deepEqual(captured, [{ url: 'blob:verified' }]);
  assert.equal(released.length, 4);
  assert.deepEqual(
    reads,
    [true, true, true, true],
    'pins request only camera imagery',
  );
});
