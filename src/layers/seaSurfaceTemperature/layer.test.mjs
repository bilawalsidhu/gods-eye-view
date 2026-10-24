import assert from 'node:assert/strict';
import test from 'node:test';
import { createSeaSurfaceTemperatureLayer } from './index.js';

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
    values: Float32Array.from([
      -1.8,
      -1.8,
      -1.8,
      -1.8,
      28,
      NaN,
      12,
      20,
      2,
      2,
      2,
      2,
    ]),
    validIso: '2026-10-22T12:00:00.000Z',
    minValue: -1.8,
    maxValue: 31.27,
    stale: false,
    ...overrides,
  };
}

function setup(getSnapshot) {
  const cesium = fakeCesium();
  const collection = fakeCollection();
  const layer = createSeaSurfaceTemperatureLayer({
    source: { getSnapshot },
    cesium,
    createCanvas: fakeCanvas,
  });
  layer.init({ imageryLayers: collection, scene: { requestRender() {} } });
  return { cesium, collection, layer };
}

test('a loaded day becomes one globe texture, reported with its maximum and observed date', async () => {
  const { collection, layer } = setup(async () => snapshot());
  layer.enable();
  assert.equal(await layer.update(), true);
  assert.equal(collection.layers.length, 1);
  const stats = layer.getStats();
  assert.equal(stats.countLabel, 'Max 31.3 °C');
  assert.equal(stats.validTime, '2026-10-22');
  assert.equal(stats.lastUpdate, Date.parse('2026-10-22T12:00:00.000Z'));
  assert.equal(stats.source, 'NOAA Coral Reef Watch');
  assert.equal(layer.updateInterval, 3 * 3600_000, 'daily data, three-hourly');
  assert.equal(stats.error, null);
  assert.equal(layer.sampleAt(0, 0), 28);
  assert.equal(layer.sampleAt(90, 0), null, 'land');
  const controls = layer.getRowControls();
  assert.equal(controls.legend.length, 9, 'every stop, warmest first');
  assert.equal(controls.legend[0].label, '32 °C');
  assert.equal(controls.legend.at(-1).label, '-2 °C');
  assert.equal(controls.info, 'Observed 2026-10-22');
});

test('a failed refresh keeps the day on the globe and reports the error', async () => {
  let fail = false;
  const { collection, layer } = setup(async () => {
    if (fail) throw new Error('Sea surface temperature HTTP 502');
    return snapshot();
  });
  layer.enable();
  await layer.update();
  fail = true;
  assert.equal(await layer.update(), true);
  assert.equal(collection.layers.length, 1);
  assert.equal(layer.getStats().error, 'Sea surface temperature HTTP 502');
  assert.match(layer.getRowControls().info, /^Observed 2026-10-22 · /);
});

test('disable removes the texture; a late answer after disable draws nothing', async () => {
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
});
