import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakeEngine } from '../../../globe/testing/fakeEngine.js';
import { createBikeshareLayer } from '../index.js';
import { createBikeshareNavaraRenderer } from './navara.js';
import * as geo from '../../../geo/index.js';

const city = 'austin-capmetro';
const key = `${city}:central`;
const information = {
  data: {
    stations: [
      {
        station_id: 'central',
        name: '中央 / Central',
        lat: 30.2672,
        lon: -97.7431,
        capacity: 10,
      },
    ],
  },
};
const status = (bikes = 7) => ({
  data: {
    stations: [
      {
        station_id: 'central',
        num_bikes_available: bikes,
        num_docks_available: 10 - bikes,
        is_installed: true,
        is_renting: true,
        is_returning: true,
      },
    ],
  },
});
const settle = () => new Promise((resolve) => setImmediate(resolve));

function fixture(getStations) {
  const engine = createFakeEngine({ kind: 'navara' });
  engine.fake.setPose({
    longitude: (-97.7431 * Math.PI) / 180,
    latitude: (30.2672 * Math.PI) / 180,
    height: 10000,
  });
  engine.fake.script('viewRectangle', null);
  const entries = new Map();
  let context, renderer;
  let bikes = 7;
  const source = {
    getStations:
      getStations ??
      (async (url) =>
        url.includes('station_information') ? information : status(bikes)),
  };
  const layer = createBikeshareLayer({
    source,
    services: {
      render: { governorRequestRender() {} },
      overlays: {
        setOverlayEntries: (id, value) => entries.set(id, value),
        setOverlaySourceVisible() {},
        clearOverlaySource: (id) => entries.delete(id),
      },
    },
    rendererFactory(value) {
      context = value;
      renderer = createBikeshareNavaraRenderer(engine, value);
      return renderer;
    },
  });
  layer.init(null, { engine });
  return {
    engine,
    layer,
    entries,
    context,
    renderer,
    setBikes: (value) => {
      bikes = value;
    },
  };
}

test('Navara GBFS loads real parsed stations, picks stable IDs and refreshes a selected status card', async () => {
  const f = fixture();
  try {
    f.layer.enable();
    await settle();
    assert.equal(f.layer.getStats().count, 1);
    const normal = f.engine.fake.moverSet('bikeshare');
    const selected = f.engine.fake.moverSet('bikeshare-selected');
    assert.equal(normal.options.sharpen, true);
    assert.equal(selected.options.sharpen, true);
    assert.equal(normal.store.pickIds[0], key);
    assert.deepEqual(
      normal.options.point.translucencyByDistance,
      [200, 1, 180000, 0.15],
    );
    assert.equal(selected.options.point.scaleByDistance, null);
    assert.deepEqual(selected.options.point.outlineColor, [0, 0, 0, 1]);
    f.engine.fake.script('pick', { id: key });
    f.engine.fake.input('click', { position: { x: 100, y: 100 } });
    assert.equal(selected.store.count, 1);
    assert.equal(normal.store.shows[0], 0);
    assert.equal(
      f.entries.get('bikeshare-selected')[0].title,
      '中央 / Central',
    );
    f.setBikes(2);
    await f.layer.update();
    assert.match(f.entries.get('bikeshare-selected')[0].details[0], /2 avail/);
    assert.equal(f.layer.getAnalystRecords()[0].bikesAvailable, 2);
    f.engine.fake.script('pick', null);
    f.engine.fake.input('click', { position: { x: 100, y: 100 } });
    assert.equal(selected.store.count, 0);
    assert.equal(normal.store.shows[0], 1);
    assert.equal(f.entries.size, 0);
  } finally {
    f.layer.destroy();
  }
});

test('camera callbacks preserve hysteresis and ten enable/disable cycles leave no owned data or listeners', async () => {
  const f = fixture();
  try {
    for (let cycle = 0; cycle < 10; cycle++) {
      f.layer.enable();
      f.layer.enable();
      await settle();
      assert.equal(f.layer.getStats().count, 1);
      f.engine.fake.emit('camera.moveEnd');
      assert.ok(f.context.state._cameraDebounceTimer);
      f.layer.disable();
      assert.equal(f.context.state._cameraDebounceTimer, null);
      assert.equal(f.context.state._cameraChangedAttached, false);
      assert.equal(f.layer.getStats().count, 0);
      assert.deepEqual(f.layer.getDetectableObjects(), []);
      assert.equal(f.engine.fake.moverSet('bikeshare').store.count, 0);
      f.engine.fake.emit('camera.moveEnd');
      assert.equal(f.context.state._cameraDebounceTimer, null);
    }
    const gate = f.renderer.viewport.shouldActivateAtAltitude;
    assert.equal(gate(49000), false);
    assert.equal(gate(48000), true);
    assert.equal(gate(51000), true);
    assert.equal(gate(52000), false);
  } finally {
    f.layer.destroy();
    f.layer.destroy();
  }
  assert.deepEqual(f.engine.movers.list(), []);
});

test('an aborted response cannot repopulate caches or clear a newer request loading state', async () => {
  const pending = [];
  const f = fixture(
    (url, { signal }) =>
      new Promise((resolve) => pending.push({ url, signal, resolve })),
  );
  f.layer.enable();
  assert.equal(pending.length, 1);
  f.layer.disable();
  assert.equal(pending[0].signal.aborted, true);
  f.layer.enable();
  assert.equal(pending.length, 2);
  pending[0].resolve(information);
  await settle();
  assert.equal(f.context.state._stationInfoCache.size, 0);
  assert.equal(f.layer.getStats().loading, true);
  f.layer.destroy();
  pending[1].resolve(information);
  await settle();
  assert.equal(f.context.state._stationInfoCache.size, 0);
  assert.equal(f.layer.getStats().count, 0);
  assert.deepEqual(f.engine.movers.list(), []);
});

test('station positions sample the visible surface with own point sets excluded', async () => {
  const f = fixture();
  try {
    f.engine.fake.script('sampleHeight', 175);
    f.layer.enable();
    await settle();
    const point = f.layer.getDetectableObjects()[0].position;
    const height = geo.cartographic.fromCartesian(point).height;
    assert.ok(Math.abs(height - 177) < 1e-6);
    const call = f.engine.fake.callsOf('surface.sampleHeight')[0];
    assert.deepEqual(
      call.args[1].map((set) => set.id),
      ['bikeshare', 'bikeshare-selected'],
    );
  } finally {
    f.layer.destroy();
  }
});

test('a Navara station without a published capacity re-derives it from every status poll', async () => {
  const f = fixture();
  try {
    f.layer.enable();
    await settle();
    const { rendering } = f.renderer;
    const { model } = f.context.parts;
    const info = model.parseStationInformation({
      data: {
        stations: [
          { station_id: 'open', name: 'Open', lat: 30.26, lon: -97.74 },
        ],
      },
    });
    rendering.ensureCityPoints(city, info);
    const poll = (stations) =>
      rendering.applyStatusToPoints(
        city,
        model.parseStationStatus({ data: { stations } }),
      );
    const open = f.context.state._stationRenderMap.get(`${city}:open`);
    poll([
      { station_id: 'open', num_bikes_available: 10, num_docks_available: 20 },
    ]);
    assert.equal(open.capacity, 30);
    poll([
      { station_id: 'open', num_bikes_available: 4, num_docks_available: 2 },
    ]);
    assert.equal(open.capacity, 6, 'the second poll is not pinned to 30');
    assert.equal(
      f.context.state._stationRenderMap.get(key).capacity,
      10,
      'a published capacity is kept',
    );
  } finally {
    f.layer.destroy();
  }
});
