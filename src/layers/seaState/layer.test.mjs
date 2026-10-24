import assert from 'node:assert/strict';
import test from 'node:test';
import { createSeaStateLayer } from './index.js';

/** Just enough of Cesium for the globe path: one imagery collection. */
function fakeCesium() {
  const providers = [];
  return {
    providers,
    Rectangle: { MAX_VALUE: 'world' },
    SingleTileImageryProvider: class {
      constructor(options) {
        this.options = options;
        providers.push(this);
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

function snapshot(overrides = {}) {
  return {
    grid: { nx: 4, ny: 3, lo1: 0, la1: 90, dx: 90, dy: 90 },
    values: Float32Array.from([1, 1, 1, 1, 3, NaN, 3, 3, 1, 1, 1, 1]),
    runIso: '2026-10-23T18:00:00.000Z',
    validIso: '2026-10-24T06:00:00.000Z',
    maxValue: 3,
    stale: false,
    ...overrides,
  };
}

function setup(getSnapshot) {
  const cesium = fakeCesium();
  const collection = fakeCollection();
  const layer = createSeaStateLayer({
    source: { getSnapshot },
    cesium,
    createCanvas: fakeCanvas,
  });
  layer.init({ imageryLayers: collection, scene: { requestRender() {} } });
  return { cesium, collection, layer };
}

test('a loaded field becomes one globe texture, reported with its maximum and valid time', async () => {
  const { collection, layer } = setup(async () => snapshot());
  layer.enable();
  assert.equal(await layer.update(), true);
  assert.equal(collection.layers.length, 1);
  const stats = layer.getStats();
  assert.equal(stats.countLabel, 'Max 3 m');
  assert.equal(stats.validTime, '2026-10-24 06:00 UTC');
  assert.equal(stats.lastUpdate, Date.parse('2026-10-23T18:00:00.000Z'));
  assert.equal(stats.error, null);
  assert.equal(layer.sampleAt(0, 0), 3);
  assert.equal(layer.sampleAt(90, 0), null, 'land');
  const controls = layer.getRowControls();
  assert.equal(controls.legend.length, 8, 'every drawn band, not calm');
  assert.equal(controls.legend[0].label, 'Phenomenal');
  assert.match(controls.info, /^Forecast valid 2026-10-24 06:00 UTC$/);
});

test('a failed refresh keeps the field on the globe and reports the error', async () => {
  let fail = false;
  const { collection, layer } = setup(async () => {
    if (fail) throw new Error('Sea state HTTP 502');
    return snapshot();
  });
  layer.enable();
  await layer.update();
  fail = true;
  assert.equal(await layer.update(), true);
  assert.equal(collection.layers.length, 1);
  assert.equal(layer.getStats().error, 'Sea state HTTP 502');
  assert.equal(layer.getStats().countLabel, 'Max 3 m');
});

test('disable removes the texture and forgets the field; a late answer after disable draws nothing', async () => {
  let release;
  const { collection, layer } = setup(
    () => new Promise((resolve) => (release = () => resolve(snapshot()))),
  );
  layer.enable();
  const pending = layer.update();
  layer.disable();
  release();
  assert.equal(await pending, false);
  assert.equal(collection.layers.length, 0);
  assert.equal(layer.getStats().count, 0);
  assert.equal(layer.getRowControls(), null);
});

test('a map source without imagery reports why the field is hidden, and a globe brings it back', async () => {
  const { collection, layer } = setup(async () => snapshot());
  let kind = 'none';
  layer.attachShellServices({
    imageryHost: () => ({
      collection: kind === 'globe' ? collection : null,
      kind,
    }),
  });
  layer.enable();
  await layer.update();
  assert.equal(collection.layers.length, 0);
  assert.match(layer.getStats().error, /Hidden by this map source/);
  kind = 'globe';
  layer.rehome();
  assert.equal(collection.layers.length, 1);
  assert.equal(layer.getStats().error, null);
});

test('a newer update supersedes an older one still in flight', async () => {
  const answers = [];
  const { collection, layer } = setup(
    () => new Promise((resolve) => answers.push(resolve)),
  );
  layer.enable();
  const first = layer.update();
  const second = layer.update();
  answers[1](snapshot({ maxValue: 5 }));
  answers[0](snapshot({ maxValue: 1 }));
  assert.equal(await second, true);
  assert.equal(await first, false);
  assert.equal(layer.getStats().countLabel, 'Max 5 m');
  assert.equal(collection.layers.length, 1);
});
