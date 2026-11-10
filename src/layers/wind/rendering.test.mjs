// The wind's streamlines on Cesium (rendering.js, the wind display's flow
// backend) over a stub viewer and SDK. The colour field is the display's
// (render/display.test.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';

import { createWindRendering } from '../../globe/cesium/windRendering.js';

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
    remove() {
      this.removed = true;
    },
  });
  const canvas = makeCanvas();
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
    createElement: () => canvas,
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
  const viewer = {
    container,
    scene: {
      canvas,
      camera: {
        positionWC: {},
        positionCartographic: { height: 1e6 },
        changed: event(),
        moveEnd: event(),
        percentageChanged: 0.5,
      },
      preRender,
      requestRender() {},
    },
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
      worldToWindowCoordinates: projected ?? (() => ({ x: 100, y: 100 })),
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
    erasures,
    visibility,
    media,
    motion,
    preRender,
    viewer,
    cesium,
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
    updateVisibility: () => true,
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
      updateVisibility: () => true,
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
    h.rendering.setField({ ...FIELD, u: Float32Array.from([11]) });
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

test('scalar snapshots retain identical GPU wind geometry and animation phase', () => {
  let builds = 0;
  const times = [];
  const gpu = {
    supported: () => true,
    updateVisibility: () => true,
    setField() {
      builds++;
      return true;
    },
    tick(time) {
      times.push(time);
    },
    setOptions() {},
    clear() {},
    destroy() {},
    getParticleCount: () => 1,
    getDiagnostics: () => ({ ready: true, pathCount: 1 }),
  };
  const h = harness({ createGpuRendering: () => gpu });
  const snapshot = (changes = {}) => ({
    model: 'gfs',
    level: '10m',
    units: 'm/s',
    cycle: {
      runIso: '2026-09-15T00:00:00Z',
      validIso: '2026-09-15T03:00:00Z',
      forecastHour: 3,
    },
    grid: { ...FIELD },
    u: Float32Array.from(FIELD.u),
    v: Float32Array.from(FIELD.v),
    ...changes,
  });
  h.rendering.attach();
  h.rendering.setField(snapshot());
  h.rendering.start();
  h.callbacks.shift()(16);
  h.callbacks.shift()(1016);
  const phase = times.at(-1);
  h.rendering.setOptions({ overlay: 'temperature' });
  h.rendering.setField(
    snapshot({
      scalar: {
        kind: 'temperature',
        units: '°C',
        values: Float32Array.from([24]),
      },
    }),
  );
  assert.equal(
    builds,
    1,
    'freshly decoded equal arrays reuse the worker-built primitive',
  );
  h.callbacks.shift()(1032);
  assert.ok(
    times.at(-1) >= phase,
    'scalar acquisition does not reset travelling highlights',
  );
  h.rendering.setField(
    snapshot({
      scalar: {
        kind: 'temperature',
        units: '°C',
        values: Float32Array.from([28]),
      },
    }),
  );
  assert.equal(builds, 1, 'revised scalar alone does not rebuild flow');
  h.rendering.clear();
  h.rendering.setField(snapshot());
  assert.equal(builds, 2, 'clear invalidates reuse');
  h.rendering.destroy();
});

for (const [label, change] of Object.entries({
  model: { model: 'ifs' },
  cycle: { cycle: { runIso: '2026-09-15T06:00:00Z' } },
  validTime: {
    cycle: { runIso: '2026-09-15T00:00:00Z', validIso: '2026-09-15T04:00:00Z' },
  },
  grid: { grid: { ...FIELD, lo1: -180 } },
  spacing: { grid: { ...FIELD, dx: 180 } },
  revisedU: { u: Float32Array.from([11]) },
  revisedV: { v: Float32Array.from([1]) },
  level: { level: '100m' },
})) {
  test(`GPU geometry rebuilds on changed ${label}`, () => {
    let builds = 0;
    const gpu = {
      supported: () => true,
      updateVisibility: () => true,
      setField() {
        builds++;
        return true;
      },
      tick() {},
      setOptions() {},
      clear() {},
      destroy() {},
      getParticleCount: () => 1,
      getDiagnostics: () => ({ ready: true }),
    };
    const h = harness({ createGpuRendering: () => gpu });
    const original = {
      model: 'gfs',
      level: '10m',
      grid: FIELD,
      u: FIELD.u,
      v: FIELD.v,
      cycle: {
        runIso: '2026-09-15T00:00:00Z',
        validIso: '2026-09-15T03:00:00Z',
      },
    };
    h.rendering.attach();
    h.rendering.setField(original);
    h.rendering.setField({ ...original, ...change });
    assert.equal(builds, 2);
    h.rendering.destroy();
  });
}

for (const eventName of ['preRender', 'moveEnd']) {
  test(`GPU height suspension resumes from camera ${eventName} without preRender`, () => {
    const times = [];
    let visible = false;
    let inFrustum = true;
    const gpu = {
      supported: () => true,
      setField: () => true,
      updateVisibility(camera) {
        visible = camera.positionCartographic.height > 15000 && inFrustum;
        return visible;
      },
      tick(time) {
        times.push(time);
      },
      setOptions() {},
      clear() {},
      destroy() {},
      getParticleCount: () => 1,
      getDiagnostics: () => ({ ready: true, visibleCells: Number(visible) }),
    };
    const h = harness({ createGpuRendering: () => gpu });
    const camera = h.viewer.scene.camera;
    camera.positionCartographic.height = 1200;
    let renders = 0;
    h.viewer.scene.requestRender = () => renders++;
    h.rendering.attach();
    h.rendering.setField(FIELD);
    h.rendering.start();
    h.preRender.emit();
    assert.equal(h.pending.size, 0);
    assert.equal(renders, 0);
    assert.equal(times.length, 0);
    assert.equal(camera.percentageChanged, 0.5);
    assert.equal(camera.changed.size, 0);

    camera.positionCartographic.height = 60000;
    (eventName === 'preRender' ? h.preRender : camera.moveEnd).emit();
    assert.equal(
      renders,
      eventName === 'preRender' ? 0 : 1,
      'moveEnd wakes the parked scene',
    );
    assert.equal(h.pending.size, 1);
    h.callbacks.shift()(16);
    assert.equal(times.length, 1);
    const phase = times.at(-1);
    const queued = h.callbacks.shift();
    camera.positionCartographic.height = 15000;
    h.preRender.emit();
    const parkedRenders = renders;
    queued(100000);
    assert.equal(h.pending.size, 0);
    assert.equal(renders, parkedRenders);
    assert.equal(times.length, 1, 'parked draw cannot tick or advance phase');

    camera.positionCartographic.height = 60000;
    (eventName === 'preRender' ? h.preRender : camera.moveEnd).emit();
    h.callbacks.shift()(200000);
    assert.ok(
      times.at(-1) - phase < 0.1,
      'idle time does not jump animation phase',
    );
    inFrustum = false;
    h.preRender.emit();
    assert.equal(h.pending.size, 0, 'frustum-hidden cells also park');
    inFrustum = true;
    h.rendering.setOptions({ paused: true });
    (eventName === 'preRender' ? h.preRender : camera.moveEnd).emit();
    assert.equal(h.pending.size, 0, 'camera events respect pause');
    h.rendering.setOptions({ paused: false });
    globalThis.document.hidden = true;
    h.visibility.emit();
    (eventName === 'preRender' ? h.preRender : camera.moveEnd).emit();
    assert.equal(h.pending.size, 0, 'camera events respect hidden documents');
    globalThis.document.hidden = false;
    h.visibility.emit();
    assert.equal(h.pending.size, 1);
    h.rendering.destroy();
    assert.equal(h.pending.size, 0);
    assert.equal(camera.changed.size, 0);
    assert.equal(camera.moveEnd.size, 0);
    assert.equal(camera.percentageChanged, 0.5);
  });
}
