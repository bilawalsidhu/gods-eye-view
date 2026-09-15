import test from 'node:test';
import assert from 'node:assert/strict';

import { createWindRendering } from './rendering.js';

/** Build a fake browser/Cesium environment for the overlay. */
function harness({ occluded = false } = {}) {
  const strokes = [];
  const context = {
    setTransform() {},
    clearRect() {},
    fillRect() {},
    beginPath() {},
    moveTo() {},
    lineTo() {},
    stroke() {
      strokes.push(true);
    },
  };
  const canvas = {
    style: {},
    dataset: {},
    width: 0,
    height: 0,
    clientWidth: 800,
    clientHeight: 600,
    getContext: () => context,
    remove() {
      this.removed = true;
    },
  };
  const container = {
    clientWidth: 800,
    clientHeight: 600,
    appendChild(node) {
      this.node = node;
    },
  };
  const callbacks = [];
  globalThis.document = { createElement: () => canvas };
  globalThis.requestAnimationFrame = (callback) => {
    callbacks.push(callback);
    return callbacks.length;
  };
  globalThis.cancelAnimationFrame = () => {
    globalThis.cancelled = true;
  };
  const viewer = {
    container,
    scene: { canvas, camera: { positionWC: {} } },
    isDestroyed: () => false,
  };
  const cesium = {
    Cartesian3: { fromDegrees: (lon, lat) => ({ lon, lat }) },
    Ellipsoid: { WGS84: {} },
    EllipsoidalOccluder: class {
      isPointVisible() {
        return !occluded;
      }
    },
    SceneTransforms: {
      worldToWindowCoordinates: () => ({ x: 100, y: 100 }),
    },
  };
  const rendering = createWindRendering({ cesium, container, getViewer: () => viewer });
  return { rendering, canvas, container, callbacks, strokes };
}

const FIELD = {
  u: Float32Array.from([10]),
  v: Float32Array.from([0]),
  nx: 1,
  ny: 1,
  lo1: 0,
  la1: 90,
  dx: 360,
  dy: 180,
};

test('wind rendering owns the canvas and particle lifecycle', () => {
  const { rendering, canvas, callbacks, strokes } = harness();
  rendering.attach();
  assert.equal(typeof canvas.getContext('2d'), 'object');
  rendering.setField(FIELD);
  assert.ok(rendering.getParticleCount() >= 3000);
  rendering.start();
  callbacks.shift()(16);
  assert.ok(strokes.length > 0, 'a driven frame draws trails');
  rendering.stop();
  assert.equal(globalThis.cancelled, true);
  rendering.clear();
  assert.equal(rendering.getParticleCount(), 0);
  rendering.destroy();
  rendering.destroy();
  assert.equal(canvas.removed, true);
});

test('wind rendering starts before a field and still draws once one arrives', () => {
  const { rendering, callbacks, strokes } = harness();
  rendering.attach();
  rendering.start();
  // No field yet: the loop must keep scheduling instead of throwing.
  const before = callbacks.shift();
  before(16);
  assert.equal(callbacks.length, 1, 'the loop reschedules without a field');
  rendering.setField(FIELD);
  callbacks.shift()(32);
  assert.ok(strokes.length > 0, 'draws once the field is installed');
  rendering.stop();
});

test('wind rendering skips particles hidden by the globe', () => {
  const { rendering, callbacks, strokes } = harness({ occluded: true });
  rendering.attach();
  rendering.setField(FIELD);
  rendering.start();
  callbacks.shift()(16);
  assert.equal(strokes.length, 0, 'no trail is drawn for an occluded point');
  rendering.stop();
});
