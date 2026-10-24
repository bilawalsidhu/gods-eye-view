import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import {
  normalizePack,
  selectRecords,
  DEFAULT_PARAMS,
  DISPLAY_LIMIT,
} from './model.js';
import { createTransmissionSource } from './source.js';
import { createTransmissionLayer } from './index.js';
import { createTransmissionDisplay } from './rendering.js';
import { transmissionCard } from './cards.js';
import {
  createDefaultLayerState,
  encodeLayerStateParams,
  decodeLayerStateParams,
} from '../../data/layerState.js';

const metadata = {
  schemaVersion: 1,
  bbox: [18.3, -34.36, 18.99, -33.47],
  cutoffV: 110000,
  sourceTimestamp: '2026-10-22T20:21:33Z',
  features: 3,
};
const feature = (id, kind, voltage, coordinates) => ({
  type: 'Feature',
  id,
  properties: {
    kind,
    voltageState: voltage == null ? 'unknown' : 'known',
    ...(voltage == null ? {} : { voltage: voltage.join(';') }),
    voltages: voltage || [],
    representativePoint: kind === 'substation',
  },
  geometry: {
    type: kind === 'line' ? 'MultiLineString' : 'Point',
    coordinates,
  },
});
const pack = {
  type: 'FeatureCollection',
  features: [
    feature(
      'way/1',
      'line',
      [132000],
      [
        [
          [18.5, -34],
          [18.6, -33.9],
        ],
      ],
    ),
    feature('way/2', 'substation', [66000, 400000], [18.55, -33.95]),
    feature('node/3', 'substation', null, [18.56, -33.96]),
  ],
};
const snapshot = () =>
  normalizePack(structuredClone(pack), structuredClone(metadata));
const tick = () => new Promise((resolve) => setImmediate(resolve));
function fixture(
  source = { getSnapshot: async () => snapshot() },
  options = {},
) {
  let handler,
    entries = [],
    visible,
    currentPick;
  const owners = new Set(),
    credits = new Set();
  const viewer = {
    scene: {
      globe: { ellipsoid: Cesium.Ellipsoid.WGS84 },
      requestRender() {},
      pick: () => currentPick,
    },
    camera: {
      moveEnd: new Cesium.Event(),
      changed: new Cesium.Event(),
      positionCartographic: { height: 100000 },
      computeViewRectangle: () =>
        Cesium.Rectangle.fromDegrees(...metadata.bbox),
    },
    dataSources: new Cesium.DataSourceCollection(),
  };
  const layer = createTransmissionLayer({
    source,
    overlayHost: {
      setEntries: (_id, rows) => (entries = rows),
      clearSource: () => (entries = []),
      setVisible: (_id, value) => (visible = value),
    },
    picking: {
      registerPickOwner: (id) => owners.add(id),
      unregisterPickOwner: (id) => owners.delete(id),
      resolvePickId: (p) => p?.id,
      isOwnedByOtherLayer: (_id, p) => p === 'other',
    },
    screenSpaceEventHandlerFactory: () => ({
      setInputAction: (fn) => (handler = fn),
      destroy: () => (handler = null),
    }),
    credits: {
      show: (_v, owner) => credits.add(owner),
      hide: (_v, owner) => credits.delete(owner),
    },
    ...options,
  });
  return {
    layer,
    viewer,
    owners,
    credits,
    entries: () => entries,
    visible: () => visible,
    click: (id) => {
      currentPick = { id };
      handler({ position: { x: 0, y: 0 } });
    },
  };
}

test('the shipped pack has reproducible bytes, source identities, counts, and bounded coordinates', async () => {
  const body = await readFile(
    new URL(
      '../../data/local_data/transmission/cape-town.geojson',
      import.meta.url,
    ),
  );
  const meta = JSON.parse(
    await readFile(
      new URL(
        '../../data/local_data/transmission/source.json',
        import.meta.url,
      ),
    ),
  );
  const { rows } = normalizePack(JSON.parse(body), meta);
  assert.equal(
    createHash('sha256').update(body).digest('hex'),
    meta.packSha256,
  );
  assert.equal(body.length, meta.packBytes);
  assert.equal(rows.filter((r) => r.kind === 'line').length, 367);
  assert.equal(
    rows.filter((r) => r.kind === 'substation' && r.voltageState === 'known')
      .length,
    57,
  );
  assert.equal(rows.filter((r) => r.voltageState === 'unknown').length, 418);
  assert.equal(meta.overlappingSubstations.length, 1);
  assert.ok(meta.lineKm > 1000 && meta.lineKm < 1020);
});

test('rejects duplicate IDs, malformed geometry, invented known voltage, and unbounded input', () => {
  for (const mutate of [
    (p) => (p.features[2].id = 'way/1'),
    (p) => (p.features[0].geometry.coordinates[0][0] = [50, 50]),
    (p) => (p.features[1].properties.voltages = [66000]),
    (p) => (p.features[0].properties.voltageState = 'unknown'),
    (p) => (p.features[2].properties.voltage = '132000'),
    (p) => (p.features[0].geometry.coordinates = []),
  ]) {
    const bad = structuredClone(pack);
    mutate(bad);
    assert.throws(() => normalizePack(bad, metadata));
  }
  assert.throws(() => normalizePack(pack, { ...metadata, features: 9999 }));
});

test('filter preserves multi-voltage records and separates unknown substations from the voltage cutoff', () => {
  const { rows } = snapshot();
  assert.equal(
    selectRecords(rows, DEFAULT_PARAMS, metadata.bbox, 1e5).filtered.length,
    2,
  );
  assert.deepEqual(
    selectRecords(
      rows,
      { voltage: '400000', showUnknown: true },
      metadata.bbox,
      1e5,
    ).visible.map((r) => r.id),
    ['way/2', 'node/3'],
  );
  const world = selectRecords(
    rows,
    { ...DEFAULT_PARAMS, showUnknown: true },
    metadata.bbox,
    3e6,
  );
  assert.equal(world.visible.length, 0);
  assert.equal(world.filtered.length, 3);
  assert.ok(world.zoomedOut);
  assert.equal(
    selectRecords(rows, DEFAULT_PARAMS, [-100, 20, -90, 30], 1e5).visible
      .length,
    0,
  );
  const dense = Array.from({ length: 800 }, (_, i) => ({
    ...rows[0],
    id: `way/${i + 1}`,
  }));
  const chosen = selectRecords(dense, DEFAULT_PARAMS, metadata.bbox, 1e5);
  assert.equal(chosen.visible.length, DISPLAY_LIMIT);
  assert.equal(chosen.omitted, 200);
});

test('source is lazy, passes cancellation, and validates received data', async () => {
  const calls = [],
    signal = new AbortController().signal;
  const source = createTransmissionSource({
    fetchImpl: async (url, opts) => {
      calls.push({ url, opts });
      return {
        ok: true,
        json: async () => (url.endsWith('source.json') ? metadata : pack),
      };
    },
  });
  assert.equal(calls.length, 0);
  assert.equal((await source.getSnapshot({ signal })).rows.length, 3);
  assert.equal(calls.length, 2);
  assert.ok(calls.every((c) => c.opts.signal === signal));
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(source.getSnapshot({ signal: abort.signal }), {
    name: 'AbortError',
  });
});

test('share links preserve both filters with unknown voltage off in old/default state', () => {
  const state = createDefaultLayerState();
  assert.deepEqual(state.options.transmission, DEFAULT_PARAMS);
  state.enabledLayerIds = ['transmission'];
  state.options.transmission = { showUnknown: true, voltage: '400000' };
  const params = new URLSearchParams('v=2');
  encodeLayerStateParams(params, state);
  const restored = decodeLayerStateParams(params);
  assert.deepEqual(restored.options.transmission, state.options.transmission);
  assert.deepEqual(restored.enabledLayerIds, ['transmission']);
});

test('lifecycle loads once, selects safely, releases display/credits/listeners and rebuilds from cache', async () => {
  let loads = 0;
  const h = fixture({
    getSnapshot: async () => {
      loads++;
      return snapshot();
    },
  });
  h.layer.init(h.viewer);
  h.layer.enable();
  assert.ok(await h.layer.update());
  assert.equal(h.layer.getStats().count, 2);
  assert.equal(h.viewer.dataSources.length, 1);
  h.click('transmission:way/1:0');
  assert.equal(h.entries().length, 1);
  h.click('other');
  assert.equal(h.entries().length, 1);
  h.layer.setParams({ voltage: '400000', showUnknown: true });
  await tick();
  assert.equal(h.entries().length, 0);
  assert.equal(h.layer.getStats().unknownCount, 1);
  h.layer.disable();
  assert.equal(h.viewer.dataSources.length, 0);
  assert.equal(h.credits.size, 0);
  assert.equal(h.owners.size, 0);
  assert.equal(h.viewer.camera.moveEnd.numberOfListeners, 0);
  assert.equal(h.viewer.camera.changed.numberOfListeners, 0);
  assert.equal(h.visible(), false);
  h.layer.enable();
  await h.layer.update();
  assert.equal(loads, 1);
  assert.equal(h.viewer.dataSources.length, 1);
  h.layer.destroy();
  assert.equal(h.viewer.dataSources.length, 0);
});

test('late loads and delayed data-source insertion cannot resurrect disabled geometry', async () => {
  let resolve;
  const h = fixture({ getSnapshot: () => new Promise((r) => (resolve = r)) });
  h.layer.init(h.viewer);
  h.layer.enable();
  const pending = h.layer.update();
  h.layer.disable();
  resolve(snapshot());
  assert.equal(await pending, false);
  assert.equal(h.viewer.dataSources.length, 0);
  h.layer.enable();
  const originalAdd = h.viewer.dataSources.add.bind(h.viewer.dataSources);
  let addResolve;
  h.viewer.dataSources.add = (ds) =>
    new Promise((r) => (addResolve = async () => r(await originalAdd(ds))));
  const again = h.layer.update();
  resolve(snapshot());
  await tick();
  h.layer.disable();
  await addResolve();
  await again;
  assert.equal(h.viewer.dataSources.length, 0);
  h.layer.destroy();
});

test('renderer uses distinct unknown markers and cards preserve source facts', () => {
  const { rows } = snapshot();
  const ds = createTransmissionDisplay(rows, metadata.bbox);
  assert.equal(ds.entities.values.length, 4);
  assert.equal(
    ds.entities
      .getById('transmission:way/1:0')
      .polyline.classificationType.getValue(),
    Cesium.ClassificationType.BOTH,
  );
  const unknown = ds.entities.getById('transmission:node/3:0');
  assert.equal(unknown.point.outlineWidth.getValue(), 2);
  assert.equal(unknown.point.disableDepthTestDistance.getValue(), Infinity);
  const card = transmissionCard(rows[1], metadata.sourceTimestamp);
  assert.match(card.details.join(' '), /66.*400/);
  assert.match(card.details.join(' '), /2026/);
  assert.match(
    transmissionCard(rows[2], metadata.sourceTimestamp).details[0],
    /not tagged/,
  );
});

test('render failure reports unavailable geometry and a later filter can recover', async () => {
  let fail = false;
  const h = fixture(undefined, {
    createDisplay: (...args) => {
      if (fail) throw new Error('renderer unavailable');
      return createTransmissionDisplay(...args);
    },
  });
  h.layer.init(h.viewer);
  h.layer.enable();
  assert.ok(await h.layer.update());
  fail = true;
  h.layer.setParams({ showUnknown: true });
  await tick();
  assert.ok(h.layer.getStats().error);
  assert.equal(h.layer.getStats().displayedCount, 0);
  assert.equal(h.viewer.dataSources.length, 0);
  fail = false;
  h.layer.setParams({ showUnknown: false });
  await tick();
  assert.equal(h.layer.getStats().error, null);
  assert.equal(h.layer.getStats().displayedCount, 2);
  h.layer.destroy();
});
