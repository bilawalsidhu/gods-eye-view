import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import * as picking from '../../data/pickRegistry.js';
import {
  createShipwrecksLayer,
  markerPixelSize,
  snapshotDeadline,
} from './index.js';

const wreck = (id, extra = {}) => ({
  id,
  source: 'wikidata',
  name: id,
  lat: 50,
  lon: -1,
  year: 1912,
  date: null,
  casualties: null,
  ...extra,
});

const snapshot = (records, version = 'v1') => ({
  records,
  fetchedAt: 1,
  stale: false,
  version,
  sources: { emodnet: true, wikidata: true },
});

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** A fake billboard collection that records what the layer adds. */
function fakeMarkers() {
  const collection = {
    show: true,
    billboards: [],
    rebuilds: 0,
    add(options) {
      const billboard = { show: true, ...options };
      collection.billboards.push(billboard);
      return billboard;
    },
    removeAll() {
      collection.rebuilds++;
      collection.billboards = [];
    },
  };
  return collection;
}

function harness({ snapshots, now = () => 1 } = {}) {
  const markers = fakeMarkers();
  const primitives = [];
  const cards = [];
  const handlers = [];
  const opened = [];
  let pickResult = null;
  const viewer = {
    camera: { positionWC: Cesium.Cartesian3.fromDegrees(-1, 50, 2e6) },
    scene: {
      canvas: {},
      requestRender() {},
      pick: () => pickResult,
      preRender: { addEventListener: () => () => {} },
      primitives: {
        add: (primitive) => primitives.push(primitive),
        remove: (primitive) =>
          primitives.splice(primitives.indexOf(primitive), 1),
        raiseToTop() {},
        contains: (primitive) => primitives.includes(primitive),
      },
    },
  };
  const queue = [...(snapshots || [])];
  const requests = [];
  const layer = createShipwrecksLayer({
    source: {
      getSnapshot({ signal }) {
        requests.push(signal);
        const next = queue.shift();
        if (next instanceof Error) return Promise.reject(next);
        return next instanceof Promise ? next : Promise.resolve(next);
      },
    },
    createMarkers: () => markers,
    overlayHost: {
      setEntries: (_source, entries) => cards.push(entries),
      setVisible() {},
      hitTest: () => null,
    },
    screenSpaceEventHandlerFactory: () => {
      const handler = {
        setInputAction(callback) {
          handler.click = callback;
        },
        destroy() {
          handler.destroyed = true;
        },
      };
      handlers.push(handler);
      return handler;
    },
    picking,
    pointer: { isPointerFree: () => true },
    openExternal: (url) => opened.push(url),
    now: () => now(),
  });
  layer.init(viewer);
  return {
    layer,
    markers,
    primitives,
    cards,
    handlers,
    requests,
    opened,
    pick(id) {
      pickResult = id ? { id: `shipwreck:${id}` } : null;
    },
    lastCard: () => cards.at(-1),
  };
}

test('markers live in one collection, shown only while the layer is on', async () => {
  const h = harness({ snapshots: [snapshot([wreck('a'), wreck('b')])] });
  assert.deepEqual(h.primitives, [h.markers]);
  assert.equal(h.markers.show, false);
  h.layer.enable();
  assert.equal(h.markers.show, true);
  assert.equal(await h.layer.update(), true);
  assert.equal(h.markers.billboards.length, 2);
  assert.equal(h.layer.getStats().count, 2);
  h.layer.disable();
  assert.equal(h.markers.show, false);
  assert.equal(h.handlers[0].destroyed, true);
  h.layer.destroy();
  assert.deepEqual(h.primitives, [], 'the collection leaves the scene');
});

test('markers sit on the wreck: no eye offset, bigger toll drawn last', async () => {
  const h = harness({
    snapshots: [
      snapshot([
        wreck('big', { casualties: 1500 }),
        wreck('none'),
        wreck('small', { casualties: 3 }),
      ]),
    ],
  });
  h.layer.enable();
  await h.layer.update();
  const ids = h.markers.billboards.map((billboard) => billboard.id);
  assert.deepEqual(ids, ['shipwreck:none', 'shipwreck:small', 'shipwreck:big']);
  for (const billboard of h.markers.billboards)
    assert.equal(billboard.eyeOffset, undefined);
  assert.equal(h.markers.billboards[2].width, markerPixelSize(1500));
});

test('an unchanged snapshot does not rebuild the markers', async () => {
  const records = [wreck('a')];
  const h = harness({
    snapshots: [
      snapshot(records, 'v1'),
      snapshot(records, 'v1'),
      snapshot([wreck('a'), wreck('b')], 'v2'),
    ],
  });
  h.layer.enable();
  await h.layer.update();
  await h.layer.update();
  assert.equal(h.markers.rebuilds, 1);
  await h.layer.update();
  assert.equal(h.markers.rebuilds, 2);
  assert.equal(h.markers.billboards.length, 2);
});

test('a response that arrives after the layer is turned off is ignored', async () => {
  const late = deferred();
  const h = harness({ snapshots: [late.promise] });
  h.layer.enable();
  const pending = h.layer.update();
  h.layer.disable();
  assert.equal(h.requests[0].aborted, true);
  late.resolve(snapshot([wreck('a')]));
  assert.equal(await pending, false);
  assert.equal(h.markers.billboards.length, 0);
});

test('a click opens the card; a period that excludes the wreck closes it', async () => {
  const h = harness({
    snapshots: [
      snapshot([wreck('old', { year: 1850 }), wreck('new', { year: 1990 })]),
    ],
  });
  h.layer.enable();
  await h.layer.update();
  h.pick('old');
  h.handlers[0].click({ position: { x: 1, y: 1 } });
  const [card] = h.lastCard();
  assert.equal(card.id, 'shipwreck-card:old');
  h.layer.setParams({ from: 1900, to: 1990 });
  assert.deepEqual(h.lastCard(), [], 'the hidden wreck loses its card');
  const shown = h.markers.billboards.filter((billboard) => billboard.show);
  assert.deepEqual(
    shown.map((billboard) => billboard.id),
    ['shipwreck:new'],
  );
  assert.equal(h.layer.getStats().count, 1);
});

test('the year pickers list only years with a wreck, and each era is counted', async () => {
  const h = harness({
    snapshots: [
      snapshot([
        wreck('a', { year: 300 }),
        wreck('b', { year: 1912 }),
        wreck('c', { year: 1912 }),
        wreck('d', { year: 1990 }),
        wreck('e', { year: null }),
      ]),
    ],
  });
  h.layer.enable();
  await h.layer.update();
  let controls = h.layer.getRowControls();
  assert.deepEqual(
    controls.range.options.map((option) => option.value),
    [1990, 1912, 300],
  );
  assert.deepEqual(
    controls.legend.map((era) => era.count),
    [1, 2, 1, 1],
  );
  h.layer.setParams({ from: 1900, to: 1950 });
  controls = h.layer.getRowControls();
  assert.deepEqual(
    controls.range.options.map((option) => option.value),
    [1990, 1950, 1912, 1900, 300],
    'the chosen ends are listed too',
  );
  assert.deepEqual(
    controls.legend.map((era) => era.count),
    [0, 2, 0, 0],
  );
});

test('a source without a version rebuilds on every new snapshot', async () => {
  const bare = (records) => {
    const value = snapshot(records);
    delete value.version;
    return value;
  };
  const h = harness({
    snapshots: [
      bare([wreck('a')]),
      bare([wreck('a'), wreck('b')]),
      { ...snapshot([wreck('a')]), version: null },
      { ...snapshot([wreck('a'), wreck('b'), wreck('c')]), version: null },
    ],
  });
  h.layer.enable();
  for (const expected of [1, 2, 1, 3]) {
    await h.layer.update();
    assert.equal(h.markers.billboards.length, expected);
  }
});

test('a failed refresh marks the shown wrecks stale, and clears them after seven days', async () => {
  const DAY = 24 * 60 * 60 * 1000;
  let clock = 1;
  const h = harness({
    now: () => clock,
    snapshots: [
      snapshot([wreck('a')]),
      new Error('Shipwrecks unavailable (HTTP 502)'),
      new Error('Shipwrecks unavailable (HTTP 502)'),
    ],
  });
  h.layer.enable();
  await h.layer.update();
  assert.equal(h.layer.getStats().stale, false);
  clock = 1 + 2 * DAY;
  assert.equal(await h.layer.update(), false);
  assert.equal(h.layer.getStats().stale, true);
  assert.equal(h.layer.getStats().count, 1, 'still shown, as stale');
  clock = 1 + 8 * DAY;
  await h.layer.update();
  assert.equal(h.layer.getStats().count, 0, 'expired wrecks leave the map');
  assert.equal(h.markers.billboards.length, 0);
});

test('expiry runs on the page clock and keeps every wreck until the newest source is too old', async () => {
  const DAY = 24 * 60 * 60 * 1000;
  const down = () => new Error('Shipwrecks unavailable (HTTP 502)');
  // The page clock is far from the proxy's fetchedAt: only reported ages count.
  let clock = 5e12;
  const h = harness({
    now: () => clock,
    snapshots: [
      {
        ...snapshot([
          wreck('fresh', { source: 'emodnet' }),
          wreck('merged', { source: 'wikidata', alsoIn: 'emodnet' }),
        ]),
        fetchedAt: 1,
        ages: { emodnet: 0, wikidata: 6.5 * DAY },
        maxAgeMs: 7 * DAY,
      },
      down(),
      down(),
    ],
  });
  h.layer.enable();
  await h.layer.update();
  clock += 1 * DAY;
  await h.layer.update();
  assert.equal(
    h.layer.getStats().count,
    2,
    'nothing leaves while EMODnet is in date',
  );
  assert.equal(h.layer.getStats().stale, true);
  clock += 6.5 * DAY;
  await h.layer.update();
  assert.equal(
    h.layer.getStats().count,
    0,
    'all leave once the newest is too old',
  );
});

test('a snapshot with no timestamp or ages still expires seven days after it arrived', async () => {
  const DAY = 24 * 60 * 60 * 1000;
  let clock = 100;
  const h = harness({
    now: () => clock,
    snapshots: [
      { ...snapshot([wreck('a')]), fetchedAt: null },
      new Error('down'),
    ],
  });
  h.layer.enable();
  await h.layer.update();
  clock += 8 * DAY;
  await h.layer.update();
  assert.equal(h.layer.getStats().count, 0);
});

test('the page deadline subtracts the newest available source age from the limit', () => {
  const DAY = 24 * 60 * 60 * 1000;
  const both = { emodnet: true, wikidata: true };
  assert.equal(
    snapshotDeadline(
      {
        sources: both,
        ages: { emodnet: 2 * DAY, wikidata: 6.5 * DAY },
        maxAgeMs: 5 * DAY,
      },
      100,
    ),
    100 + 3 * DAY,
  );
  assert.equal(
    snapshotDeadline(
      {
        sources: { emodnet: false, wikidata: true },
        ages: { emodnet: null, wikidata: 4 * DAY },
        maxAgeMs: 5 * DAY,
      },
      0,
    ),
    1 * DAY,
    'an unavailable source does not count',
  );
  assert.equal(snapshotDeadline({ sources: both }, 0), 7 * DAY, 'defaults');
});
