import test from 'node:test';
import assert from 'node:assert/strict';
import { createProjection } from './projection.js';
import { createFrames } from './frames.js';

/** Real projection loop and frames on a hand-cranked 60 Hz clock; records plane writes and render calls. */
function harness(t, runtime) {
  let clock = 1_000_000;
  const queue = [];
  const original = {
    now: performance.now,
    dateNow: Date.now,
    request: globalThis.requestAnimationFrame,
    cancel: globalThis.cancelAnimationFrame,
    document: globalThis.document,
  };
  performance.now = () => clock;
  Date.now = () => clock;
  globalThis.requestAnimationFrame = (step) => queue.push(step);
  globalThis.cancelAnimationFrame = () => queue.splice(0);
  // The pixels a decoded still hashes to (frames.js projectionFrameSignature).
  let picture = new Uint8ClampedArray([0, 0, 0, 255]);
  const ctx = new Proxy(
    {},
    {
      get: (_, key) =>
        key === 'createLinearGradient'
          ? () => ({ addColorStop() {} })
          : key === 'getImageData'
            ? () => ({ data: picture })
            : () => {},
      set: () => true,
    },
  );
  globalThis.document = {
    hidden: false,
    createElement: () => ({ getContext: () => ctx }),
  };
  t.after(() => {
    performance.now = original.now;
    Date.now = original.dateNow;
    globalThis.requestAnimationFrame = original.request;
    globalThis.cancelAnimationFrame = original.cancel;
    if (original.document === undefined) delete globalThis.document;
    else globalThis.document = original.document;
  });

  const state = {
    _viewer: {},
    _enabled: true,
    _showProjection: true,
    _projectionRaf: 0,
    _projectionEntities: [],
    _healthById: new Map([
      ['cam-1', { status: 'offline', message: 'offline' }],
    ]),
    _activeCameraId: 'cam-1',
  };
  const record = {
    camera: { id: 'cam-1', name: 'X', city: 'Y' },
    projection: {
      mode: 'image',
      video: null,
      ctx,
      canvas: {},
      image: {},
      imageLoading: true,
      imageReady: false,
      drawnImageStamp: -1,
      lastImageRefreshAt: clock,
      canvasStamp: 0,
      plane: { id: 'p', show: true },
      ...runtime,
    },
  };
  const written = [];
  const renders = [];
  const parts = {
    model: {
      projectionLoopIsNeeded: () => true,
      safeNumber: (v, f) => (Number.isFinite(v) ? v : f),
    },
    rendering: { refreshCctvFocusStyles() {} },
    selection: { getActiveRecord: () => record },
    drawSets: { writePlane: (plane) => written.push(plane.source) },
  };
  parts.frames = createFrames({
    state,
    services: {},
    parts,
    source: { getFrameUrl: () => '/frame' },
  });
  parts.projection = createProjection({
    state,
    services: {
      render: {
        holdContinuousRender: (owner) => renders.push(['hold', owner]),
        releaseContinuousRender: (owner) => renders.push(['release', owner]),
        governorRequestRender: (owner) => renders.push(['request', owner]),
      },
    },
    parts,
    source: {},
  });
  return {
    projection: parts.projection,
    runtime: record.projection,
    written,
    renders,
    /** A still decoded with `pixels`, as the image's onload in projection.js. */
    decode(pixels) {
      picture = Uint8ClampedArray.from(pixels);
      record.projection.imageLoading = false;
      record.projection.imageReady = true;
      record.projection.imageStamp = Date.now();
    },
    /** Run `seconds` of 60 Hz animation frames. */
    run(seconds) {
      for (let i = 0; i < 60 * seconds; i++) {
        clock += 1000 / 60;
        queue.shift()?.();
      }
    },
  };
}

test('stills reach the plane with no render asked by the projection loop', (t) => {
  // A camera whose first still is pending: its placeholder is repainted and
  // swapped onto the plane about once a second.
  const h = harness(t);
  h.projection.startProjectionLoop();
  h.run(5);
  assert.ok(h.written.length >= 3, 'the placeholder reaches the plane');
  assert.ok(h.written.every((source) => source.canvas));
  h.decode([10, 20, 30, 255]);
  h.written.length = 0;
  h.run(2);
  assert.equal(h.written.length, 1, 'the decoded still replaces it once');
  // The next fetch starts at 10 s; the still stays as it is meanwhile.
  h.written.length = 0;
  h.run(4);
  assert.deepEqual(h.written, [], 'an unchanged still is not written again');
  h.decode([10, 20, 30, 255]);
  h.run(2);
  assert.deepEqual(h.written, [], 'nor the same picture decoded anew');
  h.decode([40, 50, 60, 255]);
  h.run(2);
  assert.equal(h.written.length, 1, 'a new picture is written once');
  assert.ok(h.written[0].canvas);
  // The plane's set asks for the frames a new canvas needs: 'a quad given
  // another canvas asks for the frames that bind it, then none' in
  // src/render/cesium/draw.test.mjs.
  assert.deepEqual(h.renders, []);
});

test('a video feed is left to the renderer; failing over, the still reaches the plane', (t) => {
  const video = { readyState: 0, videoWidth: 0, videoHeight: 0 };
  const h = harness(t, {
    mode: 'video',
    video,
    plane: { id: 'p', show: true, source: { video } },
  });
  h.projection.startProjectionLoop();
  h.run(2);
  assert.deepEqual(h.written, [], 'the loop leaves the video on the plane');
  // As the feed's onFailure in projection.js does.
  h.runtime.video = null;
  h.runtime.mode = 'image';
  h.projection.setPlaneSource(h.runtime, { canvas: h.runtime.canvas });
  h.written.length = 0;
  h.run(2);
  assert.ok(h.written.length > 0, 'a repainted still is swapped on');
  assert.ok(
    h.written.every(
      (source) => source.canvas && source.canvas !== h.runtime.canvas,
    ),
  );
  h.decode([10, 20, 30, 255]);
  h.written.length = 0;
  h.run(2);
  assert.equal(h.written.length, 1, 'the decoded still replaces it once');
  h.written.length = 0;
  h.run(2);
  assert.deepEqual(h.written, [], 'and stays');
  assert.deepEqual(h.renders, []);
});
