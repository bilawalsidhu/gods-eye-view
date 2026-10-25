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

test('switching to the anomaly drops the temperature day, reads the anomaly route and shows its ramp', async () => {
  const asked = [];
  const { collection, layer } = setup(async ({ view }) => {
    asked.push(view);
    return view === 'anomaly'
      ? snapshot({ view, minValue: -3.1, maxValue: 4.26 })
      : snapshot({ view });
  });
  layer.enable();
  await layer.update();
  const chips = layer.getRowControls().chips;
  assert.deepEqual(
    chips.map(({ id, active }) => [id, active]),
    [
      ['view-temperature', true],
      ['view-anomaly', false],
    ],
  );
  assert.deepEqual(chips[1].params, { view: 'anomaly' });
  assert.equal(layer.setParams({ view: 'anomaly' }), true);
  assert.equal(collection.layers.length, 0, 'the old view is not left drawn');
  assert.equal(layer.getStats().count, 0);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(asked, ['temperature', 'anomaly']);
  assert.equal(collection.layers.length, 1);
  assert.equal(layer.getStats().countLabel, 'Max +4.3 °C from normal');
  const controls = layer.getRowControls();
  assert.equal(controls.chips[1].active, true);
  assert.equal(controls.legend.length, 7);
  assert.equal(controls.legend[0].label, '+4 °C');
  assert.equal(controls.legend[3].label, '0 °C');
  assert.equal(controls.legend.at(-1).label, '-4 °C');
  assert.match(controls.infoTitle, /1985–1990 plus 1993/);
  assert.equal(layer.setParams({ view: 'anomaly' }), true, 'same view');
  assert.equal(layer.setParams({ view: 'salinity' }), true, 'ignored');
  assert.deepEqual(asked, ['temperature', 'anomaly']);
});

test('a temperature answer that lands after the switch to the anomaly is dropped', async () => {
  const releases = [];
  const { collection, layer } = setup(
    ({ view }) =>
      new Promise((resolve) =>
        releases.push(() => resolve(snapshot({ view }))),
      ),
  );
  layer.enable();
  const first = layer.update();
  layer.setParams({ view: 'anomaly' });
  releases[0]();
  // Superseded by the layer's own switch, not rejected: the lifecycle turns
  // a layer off when its first update answers false.
  assert.equal(await first, true);
  assert.equal(collection.layers.length, 0);
  releases[1]();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(collection.layers.length, 1);
  assert.equal(layer.getRowControls().chips[1].active, true);
  assert.deepEqual(layer.getParams(), { view: 'anomaly' });
});

test('an update cancelled by its caller still answers false, and a failed superseded one too', async () => {
  const releases = [];
  const { layer } = setup(
    ({ view }) =>
      new Promise((resolve, reject) =>
        releases.push({ ok: () => resolve(snapshot({ view })), fail: reject }),
      ),
  );
  layer.enable();
  const caller = new AbortController();
  const cancelled = layer.update(undefined, { signal: caller.signal });
  caller.abort();
  releases[0].ok();
  assert.equal(await cancelled, false, 'cancelled by the lifecycle');
  const failing = layer.update();
  layer.setParams({ view: 'anomaly' });
  releases[1].fail(new Error('Sea surface temperature HTTP 502'));
  assert.equal(await failing, true, 'superseded, so not a rejection');
  assert.equal(layer.getStats().error, null, 'the old error is not shown');
  layer.disable();
  const late = layer.update();
  assert.equal(await late, false, 'disabled');
});

test('a view set while disabled is used on the next enable', async () => {
  const asked = [];
  const { layer } = setup(async ({ view }) => {
    asked.push(view);
    return snapshot({ view });
  });
  layer.setParams({ view: 'anomaly' });
  assert.deepEqual(asked, [], 'no request while disabled');
  layer.enable();
  await layer.update();
  assert.deepEqual(asked, ['anomaly']);
});

test('through the layer manager, a view switch during the first load keeps the layer on', async (t) => {
  const { DataLayerManager } = await import('../../data/manager.js');
  const releases = [];
  const { layer } = setup(
    ({ view }) =>
      new Promise((resolve) =>
        releases.push(() => resolve(snapshot({ view }))),
      ),
  );
  const manager = new DataLayerManager({});
  t.after(() => manager.destroyAll());
  manager.register(layer);
  const enabling = manager.toggle('sea-surface-temperature', {
    origin: 'user',
  });
  const waitFor = async (ready) => {
    for (let i = 0; i < 500 && !ready(); i += 1)
      await new Promise((resolve) => setTimeout(resolve, 0));
    assert.ok(ready(), 'the layer asked for a field');
  };
  await waitFor(() => releases.length === 1);
  manager.setLayerParams(
    'sea-surface-temperature',
    { view: 'anomaly' },
    {
      origin: 'user',
    },
  );
  await waitFor(() => releases.length === 2);
  releases[0]();
  releases[1]();
  assert.equal(await enabling, true);
  assert.equal(manager.isEnabled('sea-surface-temperature'), true);
  assert.equal(layer.getStats().count, 1);
  assert.deepEqual(layer.getParams(), { view: 'anomaly' });
});
