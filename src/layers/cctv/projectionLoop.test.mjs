import test from 'node:test';
import assert from 'node:assert/strict';
import { createProjection } from './projection.js';
import { createFrames } from './frames.js';
import {
  PROJECTION_SWAP_RENDER_MS,
  PROJECTION_TEXTURE_SWAP_MS,
} from './policy.js';

/** The projection loop on a hand-cranked clock, with the render governor's calls recorded. */
function harness(t, { video = false, showProjection = true } = {}) {
  let clock = 1000;
  const frames = [];
  const original = {
    now: performance.now,
    request: globalThis.requestAnimationFrame,
    cancel: globalThis.cancelAnimationFrame,
  };
  performance.now = () => clock;
  globalThis.requestAnimationFrame = (step) => frames.push(step);
  globalThis.cancelAnimationFrame = () => frames.splice(0);
  t.after(() => {
    performance.now = original.now;
    globalThis.requestAnimationFrame = original.request;
    globalThis.cancelAnimationFrame = original.cancel;
  });

  const holds = new Set();
  const calls = { hold: 0, requests: 0, draws: 0 };
  const record = {
    camera: { id: 'cam-1' },
    projection: { video: video ? {} : null, mode: video ? 'video' : 'image' },
  };
  const scene = { needed: true, swap: false, restyled: false };
  const state = {
    _viewer: {},
    _enabled: true,
    _showProjection: showProjection,
    _projectionRaf: 0,
    _projectionEntities: [],
  };
  const projection = createProjection({
    state,
    services: {
      render: {
        holdContinuousRender(owner) {
          calls.hold++;
          holds.add(owner);
        },
        releaseContinuousRender: (owner) => holds.delete(owner),
        governorRequestRender: () => calls.requests++,
      },
    },
    parts: {
      model: { projectionLoopIsNeeded: () => scene.needed },
      rendering: { refreshCctvFocusStyles: () => scene.restyled },
      selection: { getActiveRecord: () => record },
      frames: {
        drawProjectionFrame: () => calls.draws++,
        refreshProjectionTextures() {
          const swapped = scene.swap;
          scene.swap = false;
          return swapped;
        },
      },
    },
    source: {},
  });
  return {
    projection,
    state,
    record,
    scene,
    holds,
    calls,
    /** Run `count` animation frames 16 ms apart; returns the frames requested in them. */
    run(count = 1) {
      const before = calls.requests;
      for (let i = 0; i < count; i++) {
        clock += 16;
        frames.shift()?.();
      }
      return calls.requests - before;
    },
    advance(ms) {
      clock += ms;
    },
    get queued() {
      return frames.length;
    },
  };
}

test('a still-image camera never holds the continuous render loop', (t) => {
  const h = harness(t);
  h.projection.startProjectionLoop();
  h.run(600);
  assert.equal(h.calls.hold, 0);
  assert.equal(h.holds.size, 0);
  assert.equal(h.calls.draws, 600, 'the loop still polls for a new still');
  assert.equal(h.queued, 1, 'and stays armed');
});

test('a new still on the plane is rendered, then the scene goes idle again', (t) => {
  const h = harness(t);
  h.projection.startProjectionLoop();
  // Arming the loop (activation, projection shown) renders its first frames.
  assert.ok(h.run(5) === 5);
  h.advance(PROJECTION_SWAP_RENDER_MS);
  assert.equal(h.run(120), 0, 'an unchanged still asks for no frame');

  h.scene.swap = true;
  assert.equal(h.run(1), 1, 'the tick that swaps the image asks for a frame');
  const settling = Math.floor(PROJECTION_SWAP_RENDER_MS / 16) - 2;
  assert.equal(h.run(settling), settling, 'and so do the ticks while it binds');
  h.advance(PROJECTION_SWAP_RENDER_MS);
  assert.equal(h.run(120), 0);
  assert.equal(h.holds.size, 0);
});

test('activating another camera while the loop runs renders its first frames', (t) => {
  const h = harness(t);
  h.projection.startProjectionLoop();
  h.advance(PROJECTION_SWAP_RENDER_MS * 2);
  assert.equal(h.run(10), 0);
  h.projection.startProjectionLoop();
  assert.equal(h.run(10), 10);
  assert.equal(h.queued, 1, 'still one loop');
});

test('a video camera holds continuous render until it stops being video', (t) => {
  const h = harness(t, { video: true });
  h.projection.startProjectionLoop();
  h.run(3);
  assert.deepEqual([...h.holds], ['cctv-projection']);
  assert.equal(h.calls.draws, 0, 'Cesium updates the video texture itself');
  // The stream failed over to stills.
  h.record.projection.video = null;
  h.run(1);
  assert.equal(h.holds.size, 0);
  h.record.projection.video = {};
  h.run(1);
  assert.deepEqual([...h.holds], ['cctv-projection']);
  h.projection.stopProjectionLoop();
  assert.equal(h.holds.size, 0);
});

test('a focus fade asks for a frame only on the ticks that restyle an icon', (t) => {
  const h = harness(t, { showProjection: false });
  h.projection.startProjectionLoop();
  h.advance(PROJECTION_SWAP_RENDER_MS * 2);
  assert.equal(h.run(10), 0);
  h.scene.restyled = true;
  assert.equal(h.run(4), 4);
  h.scene.restyled = false;
  assert.equal(h.run(10), 0);
  assert.equal(h.holds.size, 0);
});

test('the loop releases and stops when it has no work', (t) => {
  const h = harness(t, { video: true });
  h.projection.startProjectionLoop();
  h.run(2);
  h.scene.needed = false;
  h.run(1);
  assert.equal(h.holds.size, 0);
  assert.equal(h.state._projectionRaf, 0);
  assert.equal(h.queued, 0);
});

test('refreshProjectionTextures reports whether it put a new image on the plane', (t) => {
  const previousDocument = globalThis.document;
  globalThis.document = {
    createElement: () => ({
      getContext: () => ({ clearRect() {}, drawImage() {} }),
    }),
  };
  t.after(() => {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  });
  const frames = createFrames({
    state: {},
    services: {},
    parts: { model: { safeNumber: (value, fallback) => value ?? fallback } },
    source: {},
  });
  const runtime = {
    mode: 'image',
    canvas: {},
    canvasStamp: 1,
    planeEntity: { show: true },
    planeMaterial: { image: null },
  };
  const record = { projection: runtime };
  assert.equal(frames.refreshProjectionTextures(record), true);
  const first = runtime.planeMaterial.image;
  assert.ok(first);
  // Unchanged canvas: nothing to render.
  runtime.lastTextureSwapAt -= PROJECTION_TEXTURE_SWAP_MS;
  assert.equal(frames.refreshProjectionTextures(record), false);
  assert.equal(runtime.planeMaterial.image, first);
  runtime.canvasStamp = 2;
  assert.equal(frames.refreshProjectionTextures(record), true);
  assert.notEqual(runtime.planeMaterial.image, first);
  runtime.planeEntity.show = false;
  runtime.canvasStamp = 3;
  runtime.lastTextureSwapAt -= PROJECTION_TEXTURE_SWAP_MS;
  assert.equal(frames.refreshProjectionTextures(record), false);
  assert.equal(frames.refreshProjectionTextures({ projection: { mode: 'video' } }), false);
});
