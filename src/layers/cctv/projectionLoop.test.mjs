import test from 'node:test';
import assert from 'node:assert/strict';
import { createProjection } from './projection.js';
import { createFrames } from './frames.js';

/**
 * The real projection loop and frames on a hand-cranked 60 Hz clock, the
 * active camera's runtime already made; what reaches the plane and every
 * render call are recorded.
 */
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
  const ctx = new Proxy(
    {},
    {
      get: (_, key) =>
        key === 'createLinearGradient'
          ? () => ({ addColorStop() {} })
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
  parts.frames = createFrames({ state, services: {}, parts, source: {} });
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
  h.run(10);
  assert.ok(h.written.length >= 5, 'the placeholder reaches the plane');
  assert.ok(h.written.every((source) => source.canvas));
  // The plane's set asks for the frames a new canvas needs (draw.test.mjs).
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
  assert.deepEqual(h.renders, []);
});
