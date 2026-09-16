import test from 'node:test';
import assert from 'node:assert/strict';

import { createWindRendering } from './rendering.js';

function event() {
  const listeners = new Set();
  return {
    addEventListener(callback) {
      listeners.add(callback);
      return () => listeners.delete(callback);
    },
    emit() {
      for (const callback of [...listeners]) callback();
    },
    get size() {
      return listeners.size;
    },
  };
}

/** Browser/Cesium ownership harness with controllable visibility and scene events. */
function harness({
  occluded = false,
  reducedMotion = false,
  projected = null,
  createGpuRendering,
  onStatusChange,
} = {}) {
  const strokes = [];
  const clears = [];
  const textures = [];
  const erasures = [];
  let path = [];
  const context = {
    setTransform() {},
    clearRect() {
      clears.push(true);
    },
    fillRect() {
      if (this.globalCompositeOperation === 'destination-out')
        erasures.push(this.fillStyle);
    },
    beginPath() {
      path = [];
    },
    moveTo(x, y) {
      path.push([x, y]);
    },
    lineTo(x, y) {
      path.push([x, y]);
    },
    stroke() {
      strokes.push(path.slice());
    },
    createImageData(width, height) {
      return { data: new Uint8ClampedArray(width * height * 4) };
    },
    putImageData() {},
  };
  const makeCanvas = () => ({
    style: {},
    dataset: {},
    width: 0,
    height: 0,
    clientWidth: 800,
    clientHeight: 600,
    getContext: () => context,
    toDataURL: () => 'data:image/png;base64,test',
    remove() {
      this.removed = true;
    },
  });
  const canvas = makeCanvas();
  let created = 0;
  const container = {
    clientWidth: 800,
    clientHeight: 600,
    appendChild(node) {
      this.node = node;
    },
  };
  const pending = new Map();
  let sequence = 0;
  const callbacks = {
    get length() {
      return pending.size;
    },
    shift() {
      const next = pending.entries().next().value;
      if (!next) return undefined;
      pending.delete(next[0]);
      return next[1];
    },
  };
  const visibility = event();
  const motion = event();
  const preRender = event();
  const media = {
    matches: reducedMotion,
    addEventListener(type, cb) {
      motion.addEventListener(cb);
    },
    removeEventListener() {},
  };
  globalThis.document = {
    hidden: false,
    createElement() {
      if (!created++) return canvas;
      const item = makeCanvas();
      textures.push(item);
      return item;
    },
    addEventListener(type, cb) {
      this.removeVisibility = visibility.addEventListener(cb);
    },
    removeEventListener() {
      this.removeVisibility?.();
    },
  };
  globalThis.matchMedia = () => media;
  globalThis.requestAnimationFrame = (callback) => {
    pending.set(++sequence, callback);
    return sequence;
  };
  globalThis.cancelled = false;
  globalThis.cancelAnimationFrame = (id) => {
    globalThis.cancelled = true;
    pending.delete(id);
  };
  const imagery = [];
  const removed = [];
  const imageryLayers = {
    addImageryProvider(provider) {
      const layer = { provider };
      imagery.push(layer);
      return layer;
    },
    remove(layer, destroy) {
      const i = imagery.indexOf(layer);
      if (i >= 0) imagery.splice(i, 1);
      removed.push({ layer, destroy });
    },
  };
  const viewer = {
    container,
    imageryLayers,
    scene: {
      canvas,
      camera: { positionWC: {} },
      preRender,
      requestRender() {},
    },
    isDestroyed: () => false,
  };
  const cesium = {
    Cartesian3: { fromDegrees: (lon, lat) => ({ lon, lat }) },
    Ellipsoid: { WGS84: {} },
    Rectangle: { MAX_VALUE: {} },
    EllipsoidalOccluder: class {
      isPointVisible() {
        return !occluded;
      }
    },
    SceneTransforms: {
      worldToWindowCoordinates: projected ?? (() => ({ x: 100, y: 100 })),
    },
    SingleTileImageryProvider: class {
      constructor(options) {
        this.options = options;
        this.errorEvent = event();
      }
    },
  };
  const rendering = createWindRendering({
    cesium,
    container,
    getViewer: () => viewer,
    createGpuRendering,
    onStatusChange,
  });
  return {
    rendering,
    canvas,
    container,
    callbacks,
    pending,
    strokes,
    clears,
    textures,
    erasures,
    visibility,
    media,
    motion,
    preRender,
    viewer,
    imagery,
    removed,
  };
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
  assert.ok(rendering.getParticleCount() >= 200);
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
  assert.equal(callbacks.length, 0, 'no animation work before a field arrives');
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

// HTML canvas dimension setters erase pixels even on an identical assignment.
test('steady frames preserve canvas dimensions and resize adjusts the particle budget', () => {
  const { rendering, canvas, callbacks } = harness();
  let resets = 0;
  let width = 0;
  let height = 0;
  Object.defineProperties(canvas, {
    width: {
      get: () => width,
      set: (value) => {
        width = value;
        resets++;
      },
    },
    height: {
      get: () => height,
      set: (value) => {
        height = value;
        resets++;
      },
    },
  });
  rendering.attach();
  rendering.setField({ grid: FIELD, u: FIELD.u, v: FIELD.v });
  rendering.start();
  const initial = resets;
  callbacks.shift()(16);
  callbacks.shift()(32);
  assert.equal(
    resets,
    initial,
    'steady frames must not invoke canvas dimension setters',
  );
  canvas.clientWidth = 320;
  canvas.clientHeight = 240;
  callbacks.shift()(48);
  assert.equal(resets, initial + 2);
  assert.ok(
    rendering.getParticleCount() < 500,
    'small view uses a smaller budget',
  );
  rendering.destroy();
});

test('pause keeps a static field, redraws changed views only, and removes listeners on stop', () => {
  const h = harness();
  h.rendering.attach();
  h.rendering.setField(FIELD);
  h.rendering.start();
  h.callbacks.shift()(16);
  h.rendering.setOptions({ paused: true });
  assert.equal(h.pending.size, 0);
  const painted = h.strokes.length;
  h.preRender.emit();
  h.preRender.emit();
  assert.equal(
    h.strokes.length,
    painted,
    'unchanged paused scene performs no paint',
  );
  h.viewer.scene.camera.heading = 1;
  h.preRender.emit();
  assert.ok(
    h.strokes.length > painted,
    'camera change repaints anchored static marks',
  );
  assert.equal(h.pending.size, 0);
  h.rendering.stop();
  assert.equal(h.preRender.size, 0);
  assert.equal(h.visibility.size, 0);
  h.rendering.destroy();
});

test('reduced motion and hidden documents never retain an animation callback', () => {
  const h = harness({ reducedMotion: true });
  h.rendering.attach();
  h.rendering.setField(FIELD);
  h.rendering.start();
  assert.equal(h.pending.size, 0);
  assert.equal(h.rendering.getDiagnostics().reducedMotion, true);
  h.media.matches = false;
  h.motion.emit();
  assert.equal(h.pending.size, 1);
  globalThis.document.hidden = true;
  h.visibility.emit();
  assert.equal(h.pending.size, 0);
  const painted = h.strokes.length;
  h.preRender.emit();
  assert.equal(h.strokes.length, painted);
  globalThis.document.hidden = false;
  h.visibility.emit();
  assert.equal(h.pending.size, 1);
  h.rendering.clear();
  assert.equal(h.pending.size, 0);
  assert.equal(h.rendering.getParticleCount(), 0);
  h.rendering.destroy();
});

test('scalar imagery builds once, survives pause, replaces cleanly, and releases on clear', () => {
  const h = harness();
  h.rendering.attach();
  h.rendering.setOptions({ overlay: 'speed' });
  h.rendering.setField({ grid: FIELD, u: FIELD.u, v: FIELD.v });
  h.rendering.start();
  assert.equal(h.imagery.length, 1);
  assert.equal(h.textures.length, 1);
  assert.equal(h.imagery[0].provider.options.tileWidth, 360);
  h.callbacks.shift()(16);
  h.callbacks.shift()(50);
  h.callbacks.shift()(85);
  assert.equal(h.textures.length, 1, 'no texture generation from frames');
  h.rendering.setOptions({ paused: true });
  assert.equal(h.imagery.length, 1);
  h.rendering.setOptions({ overlay: 'temperature' });
  assert.equal(
    h.imagery.length,
    0,
    'unavailable scalar cannot display the previous field',
  );
  assert.match(h.rendering.getDiagnostics().imageryError, /unavailable/);
  h.rendering.setField({
    grid: FIELD,
    u: FIELD.u,
    v: FIELD.v,
    scalar: {
      kind: 'temperature',
      units: '°C',
      values: new Float32Array([20]),
    },
  });
  assert.equal(h.imagery.length, 1);
  assert.equal(h.pending.size, 0);
  h.rendering.clear();
  assert.equal(h.imagery.length, 0);
  assert.ok(h.removed.every((item) => item.destroy));
  h.rendering.destroy();
});

test('projection discontinuities cannot produce long strokes across the viewport', () => {
  let calls = 0;
  const h = harness({
    projected: () => ({ x: calls++ % 2 ? 790 : 10, y: 100 }),
  });
  h.rendering.attach();
  h.rendering.setField(FIELD);
  h.rendering.start();
  h.callbacks.shift()(16);
  assert.equal(h.strokes.length, 0);
  h.rendering.destroy();
});

test('a large camera move immediately refills the newly visible region', () => {
  let center = 0;
  const h = harness({
    projected: (scene, point) => ({
      x: 400 + (((point.lon - center + 540) % 360) - 180) * 20,
      y: 300 + point.lat * 20,
    }),
  });
  h.viewer.scene.camera.computeViewRectangle = () => ({
    west: ((center - 10) * Math.PI) / 180,
    east: ((center + 10) * Math.PI) / 180,
    south: (-10 * Math.PI) / 180,
    north: (10 * Math.PI) / 180,
  });
  h.rendering.attach();
  h.rendering.setField(FIELD);
  h.rendering.start();
  h.callbacks.shift()(16);
  center = 180;
  h.viewer.scene.camera.heading = 1;
  h.preRender.emit();
  h.callbacks.shift()(50);
  const d = h.rendering.getDiagnostics();
  assert.ok(
    d.painted > d.particleCount * 0.9,
    'new hemisphere is populated in the changed-view frame',
  );
  h.rendering.destroy();
});

test('world-anchored wind glyphs remain readable at low FPS without accelerating particles', () => {
  const h = harness({
    projected: (scene, point) => ({
      x: 400 + point.lon * 20,
      y: 300 + point.lat * 20,
    }),
  });
  h.viewer.scene.camera.computeViewRectangle = () => ({
    west: (-5 * Math.PI) / 180,
    east: (5 * Math.PI) / 180,
    south: (-0.001 * Math.PI) / 180,
    north: (0.001 * Math.PI) / 180,
  });
  h.rendering.attach();
  h.rendering.setField(FIELD);
  h.rendering.start();
  const tick = (time) => {
    h.strokes.length = 0;
    h.callbacks.shift()(time);
    return h.strokes[0];
  };
  const length = (path) =>
    Math.hypot(path[1][0] - path[0][0], path[1][1] - path[0][1]);
  const first = tick(16);
  const normal = tick(50);
  const slow = tick(1050);
  assert.ok(
    length(first) > 8,
    'first frame contains an actual directional stroke',
  );
  assert.ok(Math.abs(length(first) - length(normal)) < 0.001);
  assert.ok(
    Math.abs(length(normal) - length(slow)) < 0.001,
    'stroke span does not collapse with capped frame travel',
  );
  assert.ok(
    slow[1][0] - normal[1][0] < length(slow) * 0.06,
    'head still advances only by capped0.1s, not the2s drawn tail',
  );
  const alpha = Number(h.erasures.at(-1).match(/,([^,]+)\)$/)[1]);
  assert.ok(
    alpha > 0.6,
    'one elapsed second decays old pixels, even though motion is capped',
  );
  h.strokes.length = 0;
  h.rendering.setOptions({ paused: true });
  const paused = h.strokes[0];
  assert.ok(
    Math.abs(length(paused) / length(slow) - 1.5) < 0.001,
    'paused arrow has a longer3s world sample',
  );
  assert.deepEqual(paused[1], slow[1], 'pause does not advance the particle');
  assert.equal(h.pending.size, 0);
  h.rendering.destroy();
});

test('GPU flow uses one scheduler, rebuilds only across viewport budgets, and pauses cleanly', () => {
  let builds = 0,
    ticks = 0,
    cleared = 0,
    destroyed = 0;
  const gpu = {
    supported: () => true,
    setField(field) {
      assert.equal(field.nx, 1);
      builds++;
      return true;
    },
    tick() {
      ticks++;
    },
    setOptions() {},
    clear() {
      cleared++;
    },
    destroy() {
      destroyed++;
    },
    getParticleCount: () => 1,
    getDiagnostics: () => ({ ready: true, pathCount: 1 }),
  };
  const h = harness({ createGpuRendering: () => gpu });
  let renders = 0;
  h.viewer.scene.requestRender = () => {
    renders++;
  };
  h.rendering.attach();
  h.rendering.setField({ grid: FIELD, u: FIELD.u, v: FIELD.v });
  h.rendering.start();
  h.callbacks.shift()(16);
  assert.equal(h.rendering.getDiagnostics().renderMode, 'gpu-streamlines');
  assert.ok(ticks > 0 && renders > 0);
  assert.equal(h.strokes.length, 0);
  h.viewer.scene.camera.positionWC.x = 10;
  h.preRender.emit();
  assert.equal(
    builds,
    1,
    'camera changes project geometry without rebuilding paths',
  );
  h.rendering.setOptions({ paused: true });
  assert.equal(h.pending.size, 0);
  h.canvas.clientWidth = 390;
  h.preRender.emit();
  assert.equal(builds, 2, 'crossing the narrow viewport boundary rebakes once');
  h.preRender.emit();
  assert.equal(builds, 2);
  assert.equal(h.pending.size, 0);
  h.rendering.destroy();
  assert.equal(h.pending.size, 0);
  assert.equal(h.preRender.size, 0);
  assert.equal(cleared, 1);
  assert.equal(destroyed, 1);
});

for (const paused of [false, true]) {
  test(`GPU readiness notifies the row once even with paused=${paused}`, () => {
    let ready = false;
    let notifications = 0;
    const gpu = {
      supported: () => true,
      setField: () => {
        ready = false;
        return true;
      },
      tick() {},
      setOptions() {},
      clear() {},
      destroy() {},
      getParticleCount: () => 1,
      getDiagnostics: () => ({ ready, pathCount: 1 }),
    };
    const h = harness({
      createGpuRendering: () => gpu,
      onStatusChange: () => {
        notifications++;
      },
    });
    h.viewer.scene.requestRender = () => {};
    h.rendering.attach();
    h.rendering.setOptions({ paused });
    h.rendering.setField(FIELD);
    h.rendering.start();
    h.preRender.emit();
    assert.equal(notifications, 0);
    ready = true;
    h.preRender.emit();
    assert.equal(
      notifications,
      1,
      'worker completion invalidates displayed loading state',
    );
    h.preRender.emit();
    assert.equal(
      notifications,
      1,
      'unchanged readiness does not refresh every frame',
    );
    if (paused)
      assert.equal(h.pending.size, 0, 'paused completion needs no RAF polling');
    h.rendering.setField(FIELD);
    h.preRender.emit();
    ready = true;
    h.preRender.emit();
    assert.equal(
      notifications,
      2,
      'a replacement field can settle independently',
    );
    h.rendering.stop();
    ready = false;
    h.preRender.emit();
    assert.equal(notifications, 2, 'stop releases readiness observation');
    h.rendering.destroy();
  });
}
