import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createOceanCurrentsLayer,
  OCEAN_CURRENT_FLOW_PROFILE,
  sampleCurrentVector,
} from './index.js';

function fakeCesium() {
  return {
    Rectangle: { MAX_VALUE: 'world' },
    SingleTileImageryProvider: class {
      constructor(options) {
        this.options = options;
      }
    },
  };
}

function fakeCollection() {
  const layers = [];
  return {
    layers,
    get length() {
      return layers.length;
    },
    get: (i) => layers[i],
    addImageryProvider(provider) {
      const layer = { provider };
      layers.push(layer);
      return layer;
    },
    remove(layer) {
      layers.splice(layers.indexOf(layer), 1);
    },
  };
}

const fakeCanvas = () => ({
  getContext: () => ({
    createImageData: (width, height) => ({
      data: new Uint8ClampedArray(width * height * 4),
    }),
    putImageData() {},
  }),
  toDataURL: () => 'data:image/png;base64,',
});

/** A flow renderer that records calls and reports what the test says. */
function fakeFlow() {
  const calls = { fields: [], ticks: [], cleared: 0, paused: [] };
  let visible = true;
  return {
    calls,
    setVisible: (value) => (visible = value),
    create({ profile }) {
      calls.profile = profile;
      return {
        setField(field) {
          calls.fields.push(field);
          return true;
        },
        updateVisibility: () => visible,
        tick: (seconds) => calls.ticks.push(seconds),
        setOptions: ({ paused }) => calls.paused.push(paused),
        clear: () => (calls.cleared += 1),
        destroy() {},
        getParticleCount: () => 7,
      };
    },
  };
}

function snapshot(overrides = {}) {
  return {
    grid: { nx: 4, ny: 3, lo1: 0, la1: 90, dx: 90, dy: 90 },
    u: Float32Array.from([0, 0, 0, 0, 1.2, NaN, -1, 0, 0, 0, 0, 0]),
    v: Float32Array.from([0, 0, 0, 0, 1.6, NaN, 0, 0, 0, 0, 0, 0]),
    runIso: '2026-10-24T00:00:00.000Z',
    validIso: '2026-10-24T12:00:00.000Z',
    maxSpeed: 2,
    stale: false,
    ...overrides,
  };
}

function setup(getSnapshot) {
  const collection = fakeCollection();
  const flow = fakeFlow();
  const frames = [];
  let preRender = null;
  const layer = createOceanCurrentsLayer({
    source: { getSnapshot },
    cesium: fakeCesium(),
    createCanvas: fakeCanvas,
    createFlowRendering: (options) => flow.create(options),
    requestFrame: (callback) => frames.push(callback),
    cancelFrame: () => {},
  });
  const renders = { count: 0 };
  const viewer = {
    imageryLayers: collection,
    scene: {
      camera: {},
      canvas: { clientWidth: 1200 },
      requestRender: () => (renders.count += 1),
      preRender: {
        addEventListener(callback) {
          preRender = callback;
          return () => (preRender = null);
        },
      },
    },
  };
  layer.init(viewer);
  return {
    collection,
    flow,
    viewer,
    renders,
    frames,
    layer,
    preRender: () => preRender?.(),
    hasPreRender: () => preRender !== null,
  };
}

test('a loaded field draws one speed texture and bakes flow lines with the ocean profile', async () => {
  const { collection, flow, layer } = setup(async () => snapshot());
  layer.enable();
  assert.equal(await layer.update(), true);
  assert.equal(collection.layers.length, 1);
  assert.equal(flow.calls.profile, OCEAN_CURRENT_FLOW_PROFILE);
  assert.equal(
    OCEAN_CURRENT_FLOW_PROFILE.bake.sample,
    sampleCurrentVector,
    'lines bake with the sea-only sampler',
  );
  const [field] = flow.calls.fields;
  assert.equal(field.nx, 4, 'the renderer gets a flat grid');
  assert.equal(field.u[4], Math.fround(1.2));
  assert.equal(field.v[4], Math.fround(1.6));
  const stats = layer.getStats();
  assert.equal(stats.countLabel, 'Max 2 m/s');
  assert.equal(stats.validTime, '2026-10-24 12:00 UTC');
  assert.ok(Math.abs(layer.sampleAt(0, 0).speed - 2) < 1e-6);
  assert.equal(layer.sampleAt(90, 0), null, 'land');
  const controls = layer.getRowControls();
  assert.equal(controls.legend.length, 4, 'every drawn stop, not clear water');
  assert.equal(controls.legend[0].label, '1.5 m/s');
});

test('the lines animate only while visible, and stop when disabled', async () => {
  const { flow, frames, layer, preRender, hasPreRender } = setup(async () =>
    snapshot(),
  );
  layer.enable();
  await layer.update();
  assert.equal(frames.length, 1, 'visible lines request a frame');
  frames.shift()(1000);
  frames.shift()(1100);
  assert.deepEqual(
    flow.calls.ticks.map((t) => Math.round(t * 1000) / 1000),
    [0.017, 0.117],
  );
  flow.setVisible(false);
  preRender();
  frames.length = 0;
  flow.setVisible(true);
  preRender();
  assert.equal(frames.length, 1, 'back in view, animation resumes');
  layer.disable();
  assert.equal(flow.calls.cleared, 1);
  assert.equal(hasPreRender(), false, 'listeners are removed');
  frames.shift()(1200);
  assert.equal(
    flow.calls.ticks.length,
    2,
    'a frame after disable does nothing',
  );
});

test('a failed refresh keeps the field and lines and reports the error', async () => {
  let fail = false;
  const { collection, flow, layer } = setup(async () => {
    if (fail) throw new Error('Ocean currents HTTP 502');
    return snapshot();
  });
  layer.enable();
  await layer.update();
  fail = true;
  assert.equal(await layer.update(), true);
  assert.equal(collection.layers.length, 1);
  assert.equal(flow.calls.fields.length, 1, 'no rebake on failure');
  assert.equal(layer.getStats().error, 'Ocean currents HTTP 502');
});

test('a late answer after disable draws nothing', async () => {
  let release;
  const { collection, flow, layer } = setup(
    () => new Promise((resolve) => (release = () => resolve(snapshot()))),
  );
  layer.enable();
  const pending = layer.update();
  layer.disable();
  release();
  assert.equal(await pending, false);
  assert.equal(collection.layers.length, 0);
  assert.equal(flow.calls.fields.length, 0);
  assert.equal(layer.getRowControls(), null);
});

test('crossing the narrow-screen width rebakes, and a motion change repaints', async () => {
  const { flow, layer, preRender, viewer, renders } = setup(async () =>
    snapshot(),
  );
  const listeners = {};
  globalThis.matchMedia = () => ({
    matches: false,
    addEventListener: (event, callback) => (listeners[event] = callback),
    removeEventListener() {},
  });
  try {
    layer.enable();
    await layer.update();
    preRender();
    assert.equal(flow.calls.fields.length, 1, 'same width, no rebake');
    viewer.scene.canvas.clientWidth = 500;
    preRender();
    assert.equal(flow.calls.fields.length, 2, 'narrow budget rebaked');
    const before = renders.count;
    listeners.change();
    assert.ok(renders.count > before, 'the paused look is drawn at once');
  } finally {
    delete globalThis.matchMedia;
    layer.disable();
  }
});
