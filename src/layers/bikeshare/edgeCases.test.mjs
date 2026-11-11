import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakeEngine } from '../../globe/testing/fakeEngine.js';
import { createBikeshareLayer } from './index.js';
import { createBikeshareDisplay } from './render/display.js';
import { CITY_BY_ID } from './registry.js';

// Two systems that cover one view and both number a station "1".
const BICING = 'barcelona-bicing';
const AMBICI = 'barcelona-ambici';
const STATION = '1';
const settle = () => new Promise((resolve) => setImmediate(resolve));

const information = (name, lat, lon) => ({
  data: {
    stations: [{ station_id: STATION, name, lat, lon, capacity: 20 }],
  },
});
const status = (bikes) => ({
  data: {
    stations: [
      {
        station_id: STATION,
        num_bikes_available: bikes,
        num_docks_available: 20 - bikes,
        is_installed: true,
        is_renting: true,
        is_returning: true,
      },
    ],
  },
});

function fixture() {
  const bicing = CITY_BY_ID.get(BICING);
  const ambici = CITY_BY_ID.get(AMBICI);
  const feeds = new Map([
    [bicing.stationInformationUrl, () => information('Bicing 1', 41.39, 2.16)],
    [ambici.stationInformationUrl, () => information('AMBici 1', 41.37, 2.07)],
    [bicing.stationStatusUrl, () => status(5)],
    [ambici.stationStatusUrl, () => status(11)],
  ]);
  const makeEngine = () => {
    const engine = createFakeEngine({ kind: 'navara' });
    engine.fake.setPose({
      longitude: (2.12 * Math.PI) / 180,
      latitude: (41.38 * Math.PI) / 180,
      height: 10000,
    });
    engine.fake.script('viewRectangle', null);
    return engine;
  };
  let engine = makeEngine();
  const entries = new Map();
  const layer = createBikeshareLayer({
    source: {
      async getStations(url) {
        const feed = feeds.get(url);
        if (!feed) throw new Error(`unexpected ${url}`);
        return feed();
      },
    },
    services: {
      render: { governorRequestRender() {} },
      overlays: {
        setEntries: (id, value) => entries.set(id, value),
        setVisible() {},
        clearSource: (id) => entries.delete(id),
      },
    },
    rendererFactory: (context) => createBikeshareDisplay(engine, context),
  });
  layer.init(null, { engine });
  return {
    layer,
    entries,
    feeds,
    get engine() {
      return engine;
    },
    switchEngine() {
      layer.detachRenderer();
      engine = makeEngine();
      layer.attachRenderer({ engine });
    },
    card: () => entries.get('bikeshare-selected')?.[0] ?? null,
    click(key) {
      engine.fake.script('pick', { id: key });
      engine.fake.input('click', { position: { x: 100, y: 100 } });
    },
  };
}

test('edge:bikeshare: two systems with the same station ID stay two stations', async () => {
  const f = fixture();
  try {
    f.layer.enable();
    await settle();
    const pickIds = f.engine.fake.moverSet('bikeshare').store.pickIds;
    const keys = [...pickIds].slice(0, f.layer.getStats().count).sort();
    assert.deepEqual(keys, [`${AMBICI}:${STATION}`, `${BICING}:${STATION}`]);
    f.click(`${BICING}:${STATION}`);
    assert.equal(f.card().title, 'Bicing 1');
    assert.match(f.card().details[0], /5 avail/);
    f.click(`${AMBICI}:${STATION}`);
    assert.equal(f.card().title, 'AMBici 1');
    assert.match(f.card().details[0], /11 avail/);
    // A status poll of one system never rewrites the other's station.
    f.feeds.set(CITY_BY_ID.get(BICING).stationStatusUrl, () => status(0));
    await f.layer.update();
    assert.match(f.card().details[0], /11 avail/);
  } finally {
    f.layer.destroy();
  }
});

test('edge:bikeshare: during a source outage the card keeps the last status, across an engine switch', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const f = fixture();
  try {
    f.layer.enable();
    await settle();
    const key = `${AMBICI}:${STATION}`;
    f.click(key);
    assert.match(f.card().details[0], /11 avail/);
    f.feeds.set(CITY_BY_ID.get(AMBICI).stationStatusUrl, () => {
      throw new Error('HTTP 503');
    });
    await f.layer.update();
    assert.equal(f.card().title, 'AMBici 1');
    assert.match(f.card().details[0], /11 avail/);
    // The other system still draws, so the layer is not reported as failed.
    assert.equal(f.layer.getStats().error, undefined);

    f.switchEngine();
    await settle();
    assert.equal(f.card()?.title, 'AMBici 1');
    assert.match(f.card().details[0], /11 avail/);
    assert.equal(f.layer.getStats().count, 2);
  } finally {
    f.layer.destroy();
  }
});
