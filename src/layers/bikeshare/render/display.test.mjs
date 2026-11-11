// Layer display behavior on the fake engine.

import test from 'node:test';
import assert from 'node:assert/strict';

import * as geo from '../../../geo/index.js';
import { createFakeEngine } from '../../../globe/testing/fakeEngine.js';

import { createBikeshareLayer } from '../index.js';
import { capacityToPixelSize } from '../presentation.js';
import { COLOR_GREEN, COLOR_OUTLINE, COLOR_RED } from '../policy.js';
import { createBikeshareDisplay } from './display.js';

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
const near = (actual, expected, label, tolerance = 1e-6) =>
  assert.ok(
    Math.abs(actual - expected) < tolerance,
    `${label}: ${actual} vs ${expected}`,
  );

function fakeHarness() {
  const engine = createFakeEngine();
  return {
    name: 'the fake engine',
    engine,
    /** A click whose pick is `picked` (undefined: the map). */
    click(picked) {
      engine.fake.script('pick', picked);
      engine.fake.input('click', { position: { x: 100, y: 100 } });
    },
    surface(height) {
      engine.fake.script('sampleHeight', height);
    },
    point: (id, index) => {
      const { store } = engine.fake.moverSet(id);
      return {
        shown: index < store.count && store.shows[index] === 1,
        pixelSize:
          engine.fake.moverSet(id).options.point.sizePx * store.scales[index],
        color: [...store.colors.slice(index * 4, index * 4 + 4)],
        id: store.pickIds[index],
      };
    },
  };
}

const HARNESSES = [fakeHarness];

function fixture(makeHarness, getStations) {
  const h = makeHarness();
  h.engine.camera.setView({
    destination: geo.cartesian3.fromDegrees(-97.7431, 30.2672, 10000),
  });
  const entries = new Map();
  const owners = new Map();
  let context, display;
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
        setEntries: (id, value) => entries.set(id, value),
        setVisible() {},
        clearSource: (id) => entries.delete(id),
      },
      picking: {
        registerPickOwner: (id, owns) => owners.set(id, owns),
        unregisterPickOwner: (id) => owners.delete(id),
      },
    },
    rendererFactory(value) {
      context = value;
      display = createBikeshareDisplay(h.engine, value);
      return display;
    },
  });
  layer.init(null, { engine: h.engine });
  return {
    ...h,
    h,
    layer,
    entries,
    owners,
    get context() {
      return context;
    },
    get display() {
      return display;
    },
    setBikes: (value) => {
      bikes = value;
    },
    count: (id) => h.engine.movers.list().find((set) => set.id === id)?.count,
  };
}

for (const makeHarness of HARNESSES) {
  const { name } = makeHarness();

  test(`stations draw as capacity-sized discs that fade with distance (${name})`, async () => {
    const f = fixture(makeHarness);
    try {
      f.layer.enable();
      await settle();
      assert.equal(f.layer.getStats().count, 1);
      assert.equal(f.count('bikeshare'), 1);
      const station = f.point('bikeshare', 0);
      assert.equal(station.shown, true);
      assert.equal(station.id, key, 'a pick returns the station key');
      near(station.pixelSize, capacityToPixelSize(10), 'pixel size');
      // 7 of 10 bikes: plenty.
      COLOR_GREEN.rgba().forEach((value, i) =>
        near(station.color[i], value, `colour ${i}`),
      );

      const { options } = f.engine.fake.moverSet('bikeshare');
      assert.equal(options.pickable, true);
      assert.equal(options.sharpen, true);
      assert.equal(options.order, 4, 'its data/spriteOrder slot');
      assert.deepEqual(options.depthTest, { disableWithinM: 2500 });
      assert.equal(options.point.outlinePx, 1);
      assert.deepEqual(options.point.outlineColor, COLOR_OUTLINE.rgba());
      assert.deepEqual(options.point.scaleByDistance, [200, 1.35, 130000, 0.4]);
      assert.deepEqual(
        options.point.translucencyByDistance,
        [200, 1, 180000, 0.15],
      );

      f.setBikes(1);
      await f.layer.update();
      COLOR_RED.rgba().forEach((value, i) =>
        near(f.point('bikeshare', 0).color[i], value, `refreshed colour ${i}`),
      );
    } finally {
      f.layer.destroy();
    }
  });

  test(`a selected station hides under a cyan highlight and keeps its card fresh (${name})`, async () => {
    const f = fixture(makeHarness);
    try {
      f.layer.enable();
      await settle();
      f.click({ id: key, owner: 'bikeshare', instance: 0 });
      assert.equal(f.count('bikeshare-selected'), 1);
      assert.equal(f.point('bikeshare', 0).shown, false);
      const highlight = f.point('bikeshare-selected', 0);
      assert.equal(highlight.shown, true);
      near(highlight.pixelSize, 14, 'highlight size');
      assert.deepEqual(highlight.color, [0, 1, 1, 1]);

      const { options } = f.engine.fake.moverSet('bikeshare-selected');
      assert.equal(options.depthTest, 'always');
      assert.equal(options.point.scaleByDistance, null);
      assert.deepEqual(options.point.outlineColor, [0, 0, 0, 1]);
      assert.ok(
        options.order > f.engine.fake.moverSet('bikeshare').options.order,
        'over the layer’s own points',
      );

      assert.equal(
        f.entries.get('bikeshare-selected')[0].title,
        '中央 / Central',
      );
      f.click({ id: key, owner: 'bikeshare-selected', instance: 0 });
      assert.equal(
        f.count('bikeshare-selected'),
        1,
        'a click on the highlight keeps the selection',
      );
      f.setBikes(2);
      await f.layer.update();
      assert.match(
        f.entries.get('bikeshare-selected')[0].details[0],
        /2 avail/,
      );
      assert.equal(f.layer.getAnalystRecords()[0].bikesAvailable, 2);
      f.click(undefined);
      assert.equal(f.count('bikeshare-selected'), 0);
      assert.equal(f.point('bikeshare', 0).shown, true);
      assert.equal(f.entries.size, 0);
      f.click({ id: key, owner: 'bikeshare', instance: 0 });
      f.click({ id: 'flight:abc', owner: 'flights-sprites-0', instance: 0 });
      assert.equal(
        f.count('bikeshare-selected'),
        0,
        "another layer's object clears the selection too",
      );
    } finally {
      f.layer.destroy();
    }
  });

  test(`camera changes rerun the range check and ten cycles leave nothing behind (${name})`, async () => {
    const f = fixture(makeHarness);
    try {
      const base = f.engine.camera.percentageChanged;
      for (let cycle = 0; cycle < 10; cycle++) {
        f.layer.enable();
        f.layer.enable();
        await settle();
        assert.equal(f.layer.getStats().count, 1);
        assert.equal(f.engine.camera.percentageChanged, 0.05);
        assert.equal(f.owners.get('bikeshare')(key), true);
        f.engine.camera.changed.raiseEvent(0.1);
        assert.ok(f.context.state._cameraDebounceTimer);
        f.layer.disable();
        assert.equal(f.context.state._cameraDebounceTimer, null);
        assert.equal(f.context.state._cameraChangedAttached, false);
        assert.equal(f.engine.camera.percentageChanged, base);
        assert.equal(f.owners.has('bikeshare'), false);
        assert.equal(f.layer.getStats().count, 0);
        assert.deepEqual(f.layer.getDetectableObjects(), []);
        assert.equal(f.count('bikeshare'), 0);
        f.engine.camera.changed.raiseEvent(0.1);
        assert.equal(f.context.state._cameraDebounceTimer, null);
      }
      const gate = f.display.shouldActivateAtAltitude;
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

  test(`station positions sample the surface with the layer's own sets hidden (${name})`, async () => {
    const f = fixture(makeHarness);
    try {
      f.surface(175);
      f.layer.enable();
      await settle();
      const point = f.layer.getDetectableObjects()[0].position;
      near(geo.cartographic.fromCartesian(point).height, 177, 'height');

      f.display._selectStation(key);
      f.surface(210);
      await f.engine.maps.setTerrain({ kind: 'ellipsoid' });
      f.engine.fake.frame();
      near(
        geo.cartographic.fromCartesian(
          f.context.state._stationRenderMap.get(key).point.position,
        ).height,
        212,
        'selected height',
      );
      const selected =
        f.engine.fake.moverSet('bikeshare-selected').store.positions;
      near(
        geo.cartographic.fromCartesian({
          x: selected[0],
          y: selected[1],
          z: selected[2],
        }).height,
        212,
        'highlight height',
      );

      const call = f.engine.fake.callsOf('surface.sampleHeight')[0];
      assert.deepEqual(
        call.args[1].map((set) => set.id),
        ['bikeshare', 'bikeshare-selected'],
      );
    } finally {
      f.layer.destroy();
    }
  });
}

test('Escape clears the selection while the layer shows', async (t) => {
  const previous = globalThis.document;
  globalThis.document = new EventTarget();
  t.after(() => {
    if (previous === undefined) delete globalThis.document;
    else globalThis.document = previous;
  });
  const f = fixture(fakeHarness);
  try {
    f.layer.enable();
    await settle();
    f.click({ id: key, owner: 'bikeshare', instance: 0 });
    assert.equal(f.count('bikeshare-selected'), 1);
    const escape = new Event('keydown');
    escape.key = 'Escape';
    globalThis.document.dispatchEvent(escape);
    assert.equal(f.count('bikeshare-selected'), 0);
    f.click({ id: key, owner: 'bikeshare', instance: 0 });
    f.layer.disable();
    f.layer.enable();
    await settle();
    f.click({ id: key, owner: 'bikeshare', instance: 0 });
    f.layer.disable();
    globalThis.document.dispatchEvent(escape);
    assert.equal(f.count('bikeshare-selected'), 0);
  } finally {
    f.layer.destroy();
  }
});

test('an aborted response cannot repopulate caches or clear a newer request loading state', async () => {
  const pending = [];
  const f = fixture(
    fakeHarness,
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

test('a station without a published capacity re-derives it from every status poll', async () => {
  const f = fixture(fakeHarness);
  try {
    f.layer.enable();
    await settle();
    const rendering = f.display;
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
    near(
      f.point('bikeshare', open.index).pixelSize,
      capacityToPixelSize(30),
      'the point grows with it',
    );
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
