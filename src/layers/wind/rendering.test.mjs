import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';

import { createWindRendering } from './rendering.js';
import { NO_IMAGERY_HOST } from '../weather/imageryHost.js';
import {
  createShellCesium,
  createShellScene,
} from '../weather/shellFixture.mjs';

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
  getHost,
  eventTarget,
  shell = false,
} = {}) {
  const shellScene = shell ? createShellScene() : null;
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
      let alpha = 1;
      const layer = {
        provider,
        show: true,
        alphaWrites: 0,
        get alpha() {
          return alpha;
        },
        set alpha(value) {
          alpha = value;
          this.alphaWrites++;
        },
      };
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
      camera: {
        positionWC: {},
        positionCartographic: { height: 1e6 },
        changed: event(),
        moveEnd: event(),
        percentageChanged: 0.5,
      },
      preRender,
      requestRender() {},
      ...(shellScene
        ? {
            primitives: shellScene.primitives,
            postRender: shellScene.postRender,
          }
        : {}),
    },
    isDestroyed: () => false,
  };
  const cesium = {
    ...(shell ? createShellCesium() : {}),
    GeographicTilingScheme: Cesium.GeographicTilingScheme,
    Credit: Cesium.Credit,
    Event: Cesium.Event,
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
    getHost,
    eventTarget,
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
    cesium,
    imagery,
    removed,
    primitives: () => shellScene?.primitives.items ?? [],
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

for (const overlay of ['speed', 'pressure', 'temperature']) {
  test(`${overlay} imagery fades with log camera height and resumes from idle`, () => {
    const gpu = {
      supported: () => true,
      setField: () => true,
      updateVisibility: (camera) => camera.positionCartographic.height > 15000,
      tick() {},
      setOptions() {},
      clear() {},
      destroy() {},
      getParticleCount: () => 1,
      getDiagnostics: () => ({ ready: true }),
    };
    const h = harness({ createGpuRendering: () => gpu });
    const camera = h.viewer.scene.camera;
    const baseAlpha = overlay === 'temperature' ? 1 : 0.85;
    const snapshot = {
      grid: FIELD,
      u: FIELD.u,
      v: FIELD.v,
      scalar: {
        kind: overlay,
        units: overlay === 'pressure' ? 'hPa' : '°C',
        values: Float32Array.from([overlay === 'pressure' ? 1013 : 20]),
      },
    };
    camera.positionCartographic.height = 17_368_000;
    h.rendering.attach();
    h.rendering.setOptions({ overlay });
    h.rendering.setField(snapshot);
    h.rendering.start();
    let layer = h.imagery[0];
    assert.equal(layer.alpha, baseAlpha);
    assert.equal(layer.show, true);
    const writes = layer.alphaWrites;
    h.preRender.emit();
    camera.changed.emit();
    camera.moveEnd.emit();
    assert.equal(
      layer.alphaWrites,
      writes,
      'unchanged height never writes alpha',
    );

    camera.positionCartographic.height = Math.sqrt(200_000 * 1_200_000);
    h.preRender.emit();
    assert.ok(layer.alpha > 0 && layer.alpha < baseAlpha);
    assert.ok(Math.abs(layer.alpha - baseAlpha / 2) < 1e-12, 'log midpoint');
    const midpointWrites = layer.alphaWrites;
    h.preRender.emit();
    camera.positionCartographic.height *= 1.001;
    h.preRender.emit();
    assert.equal(
      layer.alphaWrites,
      midpointWrites,
      'sub-0.005 changes are skipped',
    );
    camera.positionCartographic.height *= 1.02;
    h.preRender.emit();
    assert.equal(
      layer.alphaWrites,
      midpointWrites + 1,
      'larger changes write alpha',
    );

    camera.positionCartographic.height = 100_000;
    h.preRender.emit();
    assert.equal(layer.alpha, 0);
    assert.equal(layer.show, false);
    h.rendering.setField({ ...snapshot });
    assert.notEqual(h.imagery[0], layer, 'reinstall replaces the layer');
    layer = h.imagery[0];
    assert.equal(layer.alpha, 0, 'reinstall at low height starts transparent');
    assert.equal(layer.show, false, 'reinstall at low height starts hidden');

    for (const eventName of ['preRender', 'moveEnd']) {
      camera.positionCartographic.height = 1200;
      h.preRender.emit();
      assert.equal(h.pending.size, 0, 'street-level flow is parked');
      camera.positionCartographic.height = 1_200_000;
      (eventName === 'preRender' ? h.preRender : camera.moveEnd).emit();
      assert.equal(layer.alpha, baseAlpha, 'camera event restores full alpha');
      assert.equal(
        layer.show,
        true,
        'camera event unhides imagery without preRender',
      );
      camera.positionCartographic.height = 200_000;
      (eventName === 'preRender' ? h.preRender : camera.moveEnd).emit();
      assert.equal(layer.alpha, 0, 'lower bound is transparent');
      assert.equal(layer.show, false);
    }
    h.rendering.setOptions({ paused: true });
    camera.positionCartographic.height = 1_200_000;
    h.preRender.emit();
    assert.equal(
      layer.alpha,
      baseAlpha,
      'paused imagery still follows camera height',
    );
    assert.equal(h.pending.size, 0);
    assert.equal(
      h.textures.length,
      2,
      'height changes never rebuild the texture',
    );
    h.rendering.destroy();
  });
}

test('canvas fallback retains scalar base alpha at low camera height', () => {
  const h = harness();
  h.viewer.scene.camera.positionCartographic.height = 1200;
  h.rendering.attach();
  h.rendering.setOptions({ overlay: 'speed' });
  h.rendering.setField({ grid: FIELD, u: FIELD.u, v: FIELD.v });
  h.rendering.start();
  h.preRender.emit();
  assert.equal(h.imagery[0].alpha, 0.85);
  assert.equal(h.imagery[0].show, true);
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
  assert.equal(h.imagery.length, 1, 'new scalar field is still installed');
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
  assert.equal(
    h.imagery.length,
    1,
    'scalar replacement releases the prior image',
  );
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

test('scalar field becomes a raised shell on 3D Tiles and survives no-host events', () => {
  const eventTarget = new EventTarget();
  let host;
  const h = harness({
    eventTarget,
    shell: true,
    getHost: () =>
      host ?? { collection: h.viewer.imageryLayers, kind: 'globe' },
  });
  h.rendering.attach();
  h.rendering.setOptions({ overlay: 'speed' });
  h.rendering.setField(FIELD);
  h.rendering.start();
  const original = h.imagery[0];
  assert.ok(original);
  assert.equal(h.rendering.getDiagnostics().host, 'globe');
  const tiles = {
    addImageryProvider() {
      throw new Error('nothing drapes on 3D Tiles');
    },
  };
  host = { collection: tiles, kind: 'tileset' };
  eventTarget.dispatchEvent(new Event('gev:map-stack-changed'));
  assert.equal(h.imagery.length, 0);
  assert.equal(h.removed[0].destroy, true);
  const [primitive] = h.primitives();
  const geometry = primitive.options.geometryInstances.geometry.options;
  assert.equal(geometry.height, 5_000);
  assert.equal(geometry.rectangle, h.cesium.Rectangle.MAX_VALUE);
  const material = primitive.appearance.material;
  assert.equal(h.textures.length, 2);
  assert.equal(material.uniforms.image, h.textures[1]);
  assert.equal(h.textures[1].width, 360);
  assert.equal(h.textures[1].height, 181);
  assert.equal(material.uniforms.alpha, 0.85);
  assert.equal(primitive.show, true);
  const diagnostics = h.rendering.getDiagnostics();
  assert.equal(diagnostics.host, 'shell');
  assert.equal(diagnostics.imageryActive, true);
  assert.equal(diagnostics.shell.height, 5_000);
  host = { collection: null, kind: 'none' };
  eventTarget.dispatchEvent(new Event('gev:map-stack-changed'));
  assert.equal(primitive.show, false);
  assert.equal(h.rendering.getDiagnostics().imageryError, NO_IMAGERY_HOST);
  h.viewer.scene.camera.moveEnd.emit();
  assert.equal(primitive.show, false, 'camera events keep it hidden');
  host = { collection: tiles, kind: 'tileset' };
  h.rendering.rehome();
  assert.deepEqual(h.primitives(), [primitive]);
  assert.equal(primitive.show, true);
  assert.equal(h.textures.length, 2, 'the retained shell is reused');
  assert.equal(h.rendering.getDiagnostics().imageryError, null);
  host = null;
  h.rendering.rehome();
  assert.equal(primitive.destroyed, true);
  assert.equal(material.destroyed, true);
  assert.equal(h.primitives().length, 0);
  assert.equal(h.imagery.length, 1);
  assert.equal(h.rendering.getDiagnostics().host, 'globe');
  h.rendering.destroy();
  assert.equal(h.imagery.length, 0);
  assert.equal(h.viewer.scene.postRender.size, 0);
  eventTarget.dispatchEvent(new Event('gev:map-stack-changed'));
  assert.equal(h.primitives().length, 0);
});

test('scalar installation with no host reports hidden and installs on restore', () => {
  let host = { collection: null, kind: 'none' };
  const h = harness({ getHost: () => host });
  h.rendering.attach();
  h.rendering.setOptions({ overlay: 'speed' });
  h.rendering.setField(FIELD);
  assert.equal(h.imagery.length, 0);
  assert.equal(h.textures.length, 0);
  assert.equal(
    h.rendering.getDiagnostics().imageryError,
    'Hidden by this map source · choose a globe map',
  );
  host = { collection: h.viewer.imageryLayers, kind: 'globe' };
  h.rendering.rehome();
  assert.equal(h.imagery.length, 1);
  assert.equal(h.rendering.getDiagnostics().imageryError, null);
  h.rendering.destroy();
});

for (const overlay of ['speed', 'temperature', 'pressure']) {
  test(`${overlay} shell alpha follows the height fade in 0.1 steps on moveEnd, install or rehome`, () => {
    const gpu = {
      supported: () => true,
      setField: () => true,
      updateVisibility: () => true,
      tick() {},
      setOptions() {},
      clear() {},
      destroy() {},
      getParticleCount: () => 1,
      getDiagnostics: () => ({ ready: true }),
    };
    let kind = 'tileset';
    const h = harness({
      shell: true,
      createGpuRendering: () => gpu,
      getHost: () => ({ collection: h.viewer.imageryLayers, kind }),
    });
    const camera = h.viewer.scene.camera;
    const field = {
      ...FIELD,
      scalar: {
        kind: overlay,
        units: overlay === 'pressure' ? 'hPa' : '°C',
        values: Float32Array.of(overlay === 'pressure' ? 1013 : 20),
      },
    };
    camera.positionCartographic.height = Math.sqrt(200_000 * 1_200_000);
    h.rendering.attach();
    h.rendering.setOptions({ overlay });
    h.rendering.setField(field);
    h.rendering.start();
    assert.equal(h.imagery.length, 0);
    const [primitive] = h.primitives();
    const { uniforms } = primitive.appearance.material;
    assert.equal(uniforms.alpha, overlay === 'temperature' ? 0.5 : 0.4);
    let alpha = uniforms.alpha;
    let writes = 0;
    Object.defineProperty(uniforms, 'alpha', {
      get: () => alpha,
      set(value) {
        alpha = value;
        writes++;
      },
    });
    camera.positionCartographic.height = 100_000;
    h.preRender.emit();
    h.rendering.setOptions({ paused: true });
    assert.equal(writes, 0, 'preRender and pause do not change the shell');
    camera.moveEnd.emit();
    assert.equal(uniforms.alpha, 0);
    assert.equal(primitive.show, false);
    camera.positionCartographic.height = 59_999;
    camera.moveEnd.emit();
    assert.equal(uniforms.alpha, 0, 'the fade still hides the field low down');
    assert.equal(primitive.show, false);
    camera.positionCartographic.height = Math.sqrt(200_000 * 1_200_000);
    camera.moveEnd.emit();
    assert.equal(primitive.show, true);
    writes = 0;
    camera.positionCartographic.height *= 1.01;
    camera.moveEnd.emit();
    assert.equal(writes, 0, 'the same quantization bucket writes nothing');
    camera.positionCartographic.height = 1_200_000;
    h.rendering.rehome();
    assert.equal(uniforms.alpha, overlay === 'temperature' ? 1 : 0.9);
    kind = 'globe';
    h.rendering.rehome();
    assert.equal(primitive.destroyed, true);
    assert.equal(h.imagery[0].provider.options.tileWidth, 360);
    assert.equal(h.imagery[0].alpha, overlay === 'temperature' ? 1 : 0.85);
    h.rendering.destroy();
    assert.equal(camera.moveEnd.size, 0);
  });
}

for (const overlay of ['speed', 'temperature', 'pressure']) {
  test(`${overlay} canvas fallback shows the shell at street level without changing globe alpha`, () => {
    let kind = 'tileset';
    const h = harness({
      shell: true,
      getHost: () => ({ collection: h.viewer.imageryLayers, kind }),
    });
    const camera = h.viewer.scene.camera;
    camera.positionCartographic.height = 1200;
    h.rendering.attach();
    h.rendering.setOptions({ overlay });
    h.rendering.setField({
      ...FIELD,
      scalar: {
        kind: overlay,
        units: overlay === 'pressure' ? 'hPa' : '°C',
        values: Float32Array.of(overlay === 'pressure' ? 1013 : 20),
      },
    });
    h.rendering.start();
    const [primitive] = h.primitives();
    const textures = h.textures.length;
    const baseAlpha = overlay === 'temperature' ? 1 : 0.85;
    assert.equal(primitive.show, true, 'no height gate on 3D Tiles');
    assert.equal(primitive.appearance.material.uniforms.alpha, baseAlpha);
    camera.moveEnd.emit();
    h.preRender.emit();
    assert.equal(primitive.show, true);
    assert.equal(
      h.textures.length,
      textures,
      'camera changes keep the field texture',
    );
    kind = 'globe';
    h.rendering.rehome();
    assert.equal(primitive.destroyed, true);
    assert.equal(h.imagery[0].show, true);
    assert.equal(h.imagery[0].alpha, baseAlpha);
    h.rendering.destroy();
  });
}
