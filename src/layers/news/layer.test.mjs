import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { createNewsLayer } from './index.js';

const NOW = Date.parse('2026-10-28T10:00:00Z');
const hotspotsPayload = {
  hotspots: [
    {
      id: 'ua-ru-war',
      name: 'Russia–Ukraine war',
      bbox: [22, 44, 42, 56],
      focus: { lat: 48.6, lon: 35.5 },
      last24h: 3,
      parties: ['UA', 'RU'],
    },
  ],
  categories: [],
  lastRunAt: null,
};
const report = (id, extra = {}) => ({
  id,
  title: `Report ${id}`,
  url: `https://example.com/${id}`,
  publishedAt: '2026-10-28T09:00:00.000Z',
  publisher: 'Example',
  side: 'UA',
  category: 'strike',
  hotspotId: 'ua-ru-war',
  hotspotIds: ['ua-ru-war'],
  severity: 2,
  geo: { lat: 50, lon: 36, place: 'Kharkiv', mappable: true },
  pins: [{ lat: 50, lon: 36, place: 'Kharkiv', mappable: true }],
  event: null,
  media: [],
  ...extra,
});

function fixture(
  t,
  {
    source: overrides = {},
    height = 20_000_000,
    reduced = false,
    centre = () => ({ lat: 49, lon: 36 }),
  } = {},
) {
  const calls = { feed: [], hotspots: 0, outline: 0 };
  const reports = [
    report('major', {
      severity: 3,
      event: {
        size: 3,
        severity: 3,
        status: 'both-sides',
        lastAt: '2026-10-28T09:30:00.000Z',
        sides: [],
        image: null,
      },
    }),
    report('minor', { severity: 1 }),
    report('old', { publishedAt: '2026-10-26T09:00:00.000Z', severity: 3 }),
    report('far', {
      severity: 2,
      pins: [{ lat: 31.5, lon: 34.4, place: 'Gaza', mappable: true }],
    }),
  ];
  const source = {
    getHotspots: async () => {
      calls.hotspots++;
      return hotspotsPayload;
    },
    getFeed: async (query) => {
      calls.feed.push(query);
      return { reports, nextBefore: null };
    },
    getOutline: async () => {
      calls.outline++;
      return { polygons: [], borders: [], disputed: [] };
    },
    ...overrides,
  };
  const entries = [];
  const overlayHost = {
    setEntries: (_id, list) => entries.push(list),
    setVisible() {},
    clearSource: () => entries.push([]),
  };
  const flights = [];
  const camera = {
    positionCartographic: { height },
    positionWC: Cesium.Cartesian3.fromDegrees(36, 49, height),
    moveEnd: new Cesium.Event(),
    flyTo: (options) => flights.push(options),
  };
  const viewer = {
    camera,
    scene: { requestRender() {}, preRender: new Cesium.Event() },
    dataSources: { add() {}, remove() {} },
  };
  const layer = createNewsLayer({
    source,
    overlayHost,
    now: () => NOW,
    matchMedia: () => ({ matches: reduced }),
    getViewCentre: () => centre(),
  });
  // The context store announces selections on `window`, which Node lacks.
  const originalWindow = globalThis.window;
  globalThis.window = new EventTarget();
  layer.init(viewer);
  layer.attachShellServices({ runNavigation: (navigate) => navigate() });
  t.after(() => {
    layer.destroy();
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  });
  return { layer, viewer, camera, calls, entries, flights };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test('the feed shows the last 24 h at significant and above, beacons when zoomed out', async (t) => {
  const { layer, calls, entries } = fixture(t);
  layer.enable();
  assert.equal(await layer.update(), true);
  await settle();
  assert.equal(calls.hotspots, 1);
  // The map read and the panel's feed read both ask for the last day only.
  assert.ok(calls.feed.every((query) => query.today === true));
  const view = layer.getRowControls().feed;
  assert.deepEqual(
    view.items.map((item) => item.id),
    ['major', 'far'],
  );
  assert.deepEqual(
    view.hotspots.map((chip) => [chip.id, chip.label, chip.active]),
    [
      ['all', 'All', true],
      ['ua-ru-war', 'Ukraine–Russia', false],
    ],
  );
  const labels = entries.at(-1);
  assert.ok(labels.some((entry) => entry.id === 'hotspot:ua-ru-war'));
  assert.equal(layer.getStats().error, null);
  // Zoomed out, the camera is too high for "In view".
  assert.equal(view.inView.active, false);
});

test('choosing a card selects it and flies straight down from 150 km; reduced motion jumps', async (t) => {
  const { layer, flights, entries } = fixture(t, { reduced: true });
  layer.enable();
  await layer.update();
  layer.setParams({ reportId: 'major', focus: true });
  assert.equal(flights.length, 1);
  assert.equal(flights[0].duration, 0);
  const at = Cesium.Cartographic.fromCartesian(flights[0].destination);
  assert.ok(Math.abs(at.height - 150_000) < 1);
  assert.ok(Math.abs(Cesium.Math.toDegrees(at.latitude) - 50) < 1e-6);
  const card = entries.at(-1).find((e) => e.id === 'selected-report:major');
  assert.ok(card.details.includes('Source: example.com ↗'));
  assert.equal(layer.getRowControls().feed.selected.id, 'major');
  layer.setParams({ clear: true });
  assert.equal(layer.getRowControls().feed.selected, null);
});

test('the card toggle and the severity floor change what is shown, not what is read', async (t) => {
  const { layer, entries, calls } = fixture(t, { height: 500_000 });
  layer.enable();
  await layer.update();
  const cards = () =>
    entries.at(-1).filter((entry) => entry.id.startsWith('event-card:'));
  // No canvas in Node: cards need one, so none are painted, and nothing throws.
  assert.deepEqual(cards(), []);
  await settle();
  const reads = calls.feed.length;
  layer.setParams({ filters: { cards: false, minSeverity: 0 } });
  assert.equal(calls.feed.length, reads);
  assert.equal(layer.getRowControls().feed.filters.cards, false);
  assert.deepEqual(
    layer.getRowControls().feed.items.map((item) => item.id),
    ['major', 'minor', 'far'],
  );
});

test('In view places the held reports when the camera settles low, with no new read', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let centre = { lat: 49, lon: 36 };
  const { layer, camera, calls } = fixture(t, {
    height: 1_000_000,
    centre: () => centre,
  });
  layer.enable();
  await layer.update();
  const reads = calls.feed.length;
  const view = layer.getRowControls().feed.inView;
  assert.equal(view.active, true);
  assert.equal(view.loading, false);
  // Gaza is beyond 500 km of the view centre; the old report is past 24 h.
  assert.deepEqual(
    view.items.map((item) => item.id),
    ['major'],
  );
  // Panning to another cell (over Gaza) reads nothing: it reuses the map's
  // reports, once the camera has settled.
  centre = { lat: 31.5, lon: 34.4 };
  camera.moveEnd.raiseEvent();
  t.mock.timers.tick(799);
  assert.deepEqual(
    layer.getRowControls().feed.inView.items.map((item) => item.id),
    ['major'],
  );
  t.mock.timers.tick(1);
  await Promise.resolve();
  assert.deepEqual(
    layer.getRowControls().feed.inView.items.map((item) => item.id),
    ['far'],
  );
  assert.equal(calls.feed.length, reads);
  // Up above 3,000 km, In view goes away.
  camera.positionCartographic.height = 5_000_000;
  camera.moveEnd.raiseEvent();
  t.mock.timers.tick(800);
  assert.equal(layer.getRowControls().feed.inView.active, false);
});

test('In view with minor news reads once, not per pan; a failed read shows', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let centre = { lat: 49, lon: 36 };
  let fail = false;
  const minorReads = [];
  const { layer, camera } = fixture(t, {
    height: 1_000_000,
    centre: () => centre,
    source: {
      getFeed: async (query) => {
        if (query.relevance === '' && query.limit === 500) {
          minorReads.push(query);
          if (fail) throw new Error('boom');
          return {
            reports: [report('broad', { severity: 2, relevance: 'minor' })],
            nextBefore: null,
          };
        }
        return { reports: [], nextBefore: null };
      },
    },
  });
  layer.enable();
  await layer.update();
  camera.moveEnd.raiseEvent();
  t.mock.timers.tick(800);
  await Promise.resolve();
  assert.equal(minorReads.length, 0);
  layer.setParams({ filters: { includeMinor: true } });
  for (let i = 0; i < 4; i++) await Promise.resolve();
  assert.equal(minorReads.length, 1);
  assert.deepEqual(
    layer.getRowControls().feed.inView.items.map((item) => item.id),
    ['broad'],
  );
  centre = { lat: 47, lon: 33 };
  camera.moveEnd.raiseEvent();
  t.mock.timers.tick(800);
  await Promise.resolve();
  assert.equal(minorReads.length, 1);
  // Turned off and on again with the server failing: the error is shown.
  layer.setParams({ filters: { includeMinor: false } });
  fail = true;
  layer.setParams({ filters: { includeMinor: true } });
  for (let i = 0; i < 4; i++) await Promise.resolve();
  assert.equal(minorReads.length, 2);
  const view = layer.getRowControls().feed.inView;
  assert.equal(view.error, 'News feed unavailable');
  assert.deepEqual(view.items, []);
});

test('a server without news is unavailable once and is not asked again', async (t) => {
  const failure = Object.assign(
    new Error('News feed not configured on this server'),
    {
      unavailable: true,
    },
  );
  let reads = 0;
  const { layer } = fixture(t, {
    source: {
      getHotspots: async () => {
        reads++;
        throw failure;
      },
    },
  });
  layer.enable();
  assert.equal(await layer.update(), true);
  assert.equal(await layer.update(), true);
  assert.equal(reads, 1);
  const stats = layer.getStats();
  assert.equal(stats.sourceUnavailable, true);
  assert.equal(stats.status, 'unavailable');
  assert.equal(layer.getRowControls().feed.error, failure.message);
  // Turning the layer off and on asks again.
  layer.disable();
  layer.enable();
  await layer.update();
  assert.equal(reads, 2);
});

test('a failed read keeps the layer on with an error; disable clears the overlay', async (t) => {
  const { layer, entries } = fixture(t, {
    source: { getFeed: async () => Promise.reject(new Error('boom')) },
  });
  layer.enable();
  assert.equal(await layer.update(), true);
  assert.equal(layer.getStats().error, 'boom');
  assert.equal(layer.getStats().sourceUnavailable, undefined);
  layer.disable();
  assert.deepEqual(entries.at(-1), []);
  assert.deepEqual(layer.getRowControls().feed.items, []);
});
