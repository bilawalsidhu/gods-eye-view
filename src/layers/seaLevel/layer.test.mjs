import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';
import { createSeaLevelLayer } from './index.js';
import { layerFeedState } from '../../data/feedState.js';

const HOUR = 3_600_000;
const station = (code, ageMs, lat = 52, lon = 4) => ({
  id: `sea-level:${code}`,
  code,
  name: `Station ${code}`,
  country: 'Netherlands',
  lat,
  lon,
  sensor: 'flt',
  lastIso: '2026-10-24T20:20:00.000Z',
  lastValue: 0.54,
  ageMs,
});
const snapshot = (stations, extra = {}) => ({
  stations,
  generatedAt: '2026-10-24T20:40:00.000Z',
  stale: false,
  ...extra,
});
const SERIES = {
  code: 'hoek',
  sensor: 'flt',
  count: 3,
  min: 0.2,
  max: 1.8,
  latest: { iso: '2026-10-24T20:20:00.000Z', value: 1.4 },
  points: [
    [Date.parse('2026-10-22T20:20:00Z'), 0.2],
    [Date.parse('2026-10-23T20:20:00Z'), 1.8],
    [Date.parse('2026-10-24T20:15:00Z'), 1.4],
  ],
};

/** The real layer over a viewer stand-in: scene, camera, picking, overlay host. */
function harness({ getSnapshot, getStation = async () => SERIES, now }) {
  const primitives = [];
  const cards = new Map();
  const opened = [];
  const owners = new Map();
  let clickAction = null;
  let picked;
  let cardHit = null;
  const viewer = {
    camera: {
      // Above the North Sea, 3,000 km up.
      positionWC: Cesium.Cartesian3.fromDegrees(4, 52, 3_000_000),
      viewMatrix: Cesium.Matrix4.clone(Cesium.Matrix4.IDENTITY),
    },
    scene: {
      canvas: {},
      preRender: new Cesium.Event(),
      primitives: {
        add: (p) => (primitives.push(p), p),
        remove: (p) => primitives.splice(primitives.indexOf(p), 1),
      },
      pick: () => picked,
    },
  };
  const layer = createSeaLevelLayer({
    source: { getSnapshot, getStation, label: 'IOC / VLIZ · RAW' },
    overlayHost: {
      setEntries: (id, entries) => cards.set(id, entries),
      setVisible() {},
      clearSource: (id) => cards.delete(id),
      hitTest: () => cardHit,
    },
    picking: {
      resolvePickId: (p) => (typeof p?.id === 'string' ? p.id : null),
      isOwnedByOtherLayer: (layerId, id) => id.startsWith('flight:'),
      registerPickOwner: (id, owns) => owners.set(id, owns),
      unregisterPickOwner: (id) => owners.delete(id),
    },
    pointer: { isPointerFree: () => true },
    openExternal: (url) => opened.push(url),
    screenSpaceEventHandlerFactory: () => ({
      setInputAction: (fn) => (clickAction = fn),
      destroy: () => (clickAction = null),
    }),
    ...(now ? { now } : {}),
  });
  layer.init(viewer);
  return {
    layer,
    viewer,
    primitives,
    opened,
    owners,
    card: () => cards.get('sea-level-stations')?.[0] || null,
    points: () => primitives[0],
    pointFor: (code) => {
      const collection = primitives[0];
      for (let i = 0; i < collection.length; i++)
        if (collection.get(i).id === `sea-level:${code}`)
          return collection.get(i);
      return null;
    },
    click(id, hit = null) {
      picked = id ? { id } : undefined;
      cardHit = hit;
      clickAction({ position: new Cesium.Cartesian2(10, 10) });
    },
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test('a snapshot draws one point per station coloured by freshness, reporting on top', async () => {
  const h = harness({
    getSnapshot: async () =>
      snapshot([
        station('hoek', 20 * 60_000),
        station('vlis', 5 * HOUR),
        station('dead', 400 * HOUR),
        station('none', null),
      ]),
  });
  h.layer.enable();
  assert.equal(await h.layer.update(), true);
  const points = h.points();
  assert.equal(points.length, 4);
  // Silent stations are drawn first, so reporting ones paint over them.
  assert.equal(points.get(points.length - 1).id, 'sea-level:hoek');
  assert.ok(
    h.pointFor('hoek').color.equals(Cesium.Color.fromCssColorString('#38c6f4')),
  );
  assert.ok(
    h.pointFor('vlis').color.equals(Cesium.Color.fromCssColorString('#e0a23a')),
  );
  assert.ok(h.pointFor('dead').color.alpha < 1, 'silent is dimmed');
  assert.ok(h.pointFor('none').color.alpha < 1, 'no reading is silent');
  assert.ok(h.pointFor('hoek').pixelSize > h.pointFor('dead').pixelSize);
  const stats = h.layer.getStats();
  assert.equal(stats.count, 4);
  assert.equal(stats.countLabel, '1 reporting · 4 stations');
  assert.deepEqual(stats.countsByFreshness, {
    reporting: 1,
    late: 1,
    silent: 2,
  });
  assert.equal(stats.observedAt, Date.parse('2026-10-24T20:20:00.000Z'));
  assert.equal(layerFeedState(stats), 'nominal');
  const legend = h.layer.getRowControls().legend;
  assert.deepEqual(
    legend.map((l) => [l.label, l.count]),
    [
      ['Reporting (within 3 h)', 1],
      ['Late (3 to 24 h)', 1],
      ['Silent (over 24 h)', 2],
    ],
  );
  assert.match(legend[0].blurb, /never the level/);
  assert.ok(h.owners.get('sea-level-stations')('sea-level:hoek'));
  assert.equal(h.layer.updateInterval, 600_000);
});

test('stations on the far side of the globe are hidden', async () => {
  const h = harness({
    getSnapshot: async () =>
      snapshot([station('near', 0), station('farr', 0, -52, -176)]),
  });
  h.layer.enable();
  await h.layer.update();
  assert.equal(h.pointFor('near').show, true);
  assert.equal(h.pointFor('farr').show, false);
});

test('a click opens the card, loads the last 72 hours, and the card opens IOC', async () => {
  let clock = 1_000_000;
  const asked = [];
  const h = harness({
    now: () => clock,
    getSnapshot: async () => snapshot([station('hoek', 20 * 60_000)]),
    getStation: async (code) => (asked.push(code), SERIES),
  });
  h.layer.enable();
  await h.layer.update();
  clock += 10 * 60_000;
  h.click('sea-level:hoek');
  let card = h.card();
  assert.equal(card.title, 'Station hoek');
  assert.equal(card.accent, '#38c6f4');
  assert.equal(card.details[0], 'SEA LEVEL STATION · IOC hoek · Netherlands');
  assert.ok(card.details.includes('Reporting (within 3 h)'));
  // The reading's age moves on with the clock since the snapshot arrived.
  assert.ok(
    card.details.includes('Last reading 0.54 m · 30 minutes ago'),
    card.details.join('\n'),
  );
  assert.ok(card.details.includes('Loading the last 72 hours…'));
  assert.ok(h.pointFor('hoek').pixelSize > 7, 'selected point grows');
  await settle();
  card = h.card();
  assert.deepEqual(asked, ['hoek']);
  assert.ok(
    card.details.includes('Last 72 h: low 0.20 m · high 1.80 m'),
    card.details.join('\n'),
  );
  assert.ok(card.details.includes('Latest 1.40 m is at 75% of that range'));
  assert.ok(card.details.includes('Raw data, not quality controlled'));
  assert.ok(card.details.some((line) => /own datum/.test(line)));
  // A click on the card itself opens the station page and keeps the selection.
  h.click(null, { entryId: card.id });
  assert.deepEqual(h.opened, [
    'https://www.ioc-sealevelmonitoring.org/station.php?code=hoek',
  ]);
  assert.ok(h.card());
  // Another layer's aircraft leaves the selection alone; empty map clears it.
  h.click('flight:abc123');
  assert.ok(h.card());
  h.click(null);
  assert.equal(h.card(), null);
  assert.equal(h.pointFor('hoek').pixelSize, 7);
  // The series is kept for the session: reselecting asks nothing new.
  h.click('sea-level:hoek');
  await settle();
  assert.deepEqual(asked, ['hoek']);
});

test('a failed series read says so and is asked again on reselection', async () => {
  let fail = true;
  const h = harness({
    getSnapshot: async () => snapshot([station('hoek', 0)]),
    getStation: async () => {
      if (fail) throw new Error('IOC HTTP 502');
      return SERIES;
    },
  });
  h.layer.enable();
  await h.layer.update();
  h.click('sea-level:hoek');
  await settle();
  assert.ok(h.card().details.includes('Last 72 hours unavailable'));
  h.click(null);
  fail = false;
  h.click('sea-level:hoek');
  await settle();
  assert.ok(h.card().details.some((line) => line.startsWith('Last 72 h: low')));
});

test('a series that lands after the selection moved on is not shown', async () => {
  const releases = new Map();
  const h = harness({
    getSnapshot: async () => snapshot([station('hoek', 0), station('vlis', 0)]),
    getStation: (code, { signal }) =>
      new Promise((resolve, reject) => {
        releases.set(code, () => resolve({ ...SERIES, code }));
        signal.addEventListener('abort', () => reject(signal.reason));
      }),
  });
  h.layer.enable();
  await h.layer.update();
  h.click('sea-level:hoek');
  h.click('sea-level:vlis');
  releases.get('hoek')();
  await settle();
  assert.equal(h.card().title, 'Station vlis');
  assert.ok(h.card().details.includes('Loading the last 72 hours…'));
});

test('a failed refresh keeps the stations up as stale with a fixed error', async () => {
  let fail = false;
  const h = harness({
    getSnapshot: async () => {
      if (fail) throw new Error('IOC HTTP 503');
      return snapshot([station('hoek', 0)]);
    },
  });
  h.layer.enable();
  await h.layer.update();
  fail = true;
  assert.equal(await h.layer.update(), false);
  const stats = h.layer.getStats();
  assert.equal(stats.count, 1);
  assert.equal(stats.stale, true);
  assert.equal(stats.error, 'IOC HTTP 503');
  assert.equal(layerFeedState(stats), 'stale');
  assert.equal(h.points().length, 1);

  const stale = harness({
    getSnapshot: async () => snapshot([station('hoek', 0)], { stale: true }),
  });
  stale.layer.enable();
  await stale.layer.update();
  assert.equal(layerFeedState(stale.layer.getStats()), 'stale');

  const empty = harness({
    getSnapshot: async () => {
      throw new Error('IOC HTTP 503');
    },
  });
  empty.layer.enable();
  await empty.layer.update();
  assert.equal(layerFeedState(empty.layer.getStats()), 'unavailable');
  assert.equal(empty.layer.getStats().stale, false);
});

test('late answers are dropped: after disable, and when a newer update superseded them', async () => {
  const pending = [];
  const h = harness({
    getSnapshot: () =>
      new Promise((resolve) => {
        pending.push((stations) => resolve(snapshot(stations)));
      }),
  });
  h.layer.enable();
  const first = h.layer.update();
  assert.equal(h.layer.getStats().loading, true);
  const second = h.layer.update();
  pending[1]([station('newr', 0)]);
  assert.equal(await second, true);
  pending[0]([station('oldr', 0)]);
  assert.equal(await first, false);
  assert.equal(h.points().length, 1);
  assert.ok(h.pointFor('newr'));

  const third = h.layer.update();
  h.layer.disable();
  pending[2]([station('gone', 0)]);
  assert.equal(await third, false);
  assert.equal(h.points().length, 0);
  assert.equal(h.points().show, false);
  assert.equal(h.owners.size, 0);
  assert.equal(h.layer.getStats().countLabel, '');
  h.layer.destroy();
  assert.equal(h.primitives.length, 0);
});
