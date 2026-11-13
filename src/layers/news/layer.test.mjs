import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { KEY_SETUP_KEYS } from '../../keySetupCore.mjs';
import { NEWS_KEY_PROVIDERS, createNewsLayer } from './index.js';

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
    credits = [],
    now = () => NOW,
    pictureCards,
  } = {},
) {
  const calls = { feed: [], hotspots: 0, outline: 0 };
  const reports = [
    report('major', {
      severity: 3,
      attribution: 'GDELT Project',
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
    added: [],
    dataSources: {
      add(source) {
        viewer.added.push(source);
      },
      remove() {},
    },
  };
  const layer = createNewsLayer({
    source,
    overlayHost,
    now,
    matchMedia: () => ({ matches: reduced }),
    getViewCentre: () => centre(),
    registerCredit: (_viewer, credit) => {
      credits.push(credit.key);
      return true;
    },
    ...(pictureCards ? { pictureCards } : {}),
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
const flush = async () => {
  for (let i = 0; i < 6; i++) await Promise.resolve();
};
const keyError = (key, extra = {}) =>
  Object.assign(new Error('News key required'), {
    keyRequired: true,
    keyRejected: false,
    keyId: key,
    retryable: true,
    ...extra,
  });
const ukraine = {
  area: { key: 'UA', name: 'Ukraine', kind: 'country', country: 'UA' },
  polygons: [
    {
      outer: [
        [35, 48],
        [37, 48],
        [37, 50.5],
        [35, 50.5],
      ],
      holes: [],
    },
  ],
  borders: [],
  disputed: [],
};
const noArea = { area: null, polygons: [], borders: [], disputed: [] };

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
  // The service the report came through is credited where it shows.
  assert.ok(card.details.includes('via GDELT Project'));
  assert.equal(layer.getRowControls().feed.selected.via, 'via GDELT Project');
  assert.equal(layer.getRowControls().feed.selected.id, 'major');
  layer.setParams({ clear: true });
  assert.equal(layer.getRowControls().feed.selected, null);
});

test('the severity floor changes what is shown, not what is read', async (t) => {
  const { layer, entries, calls } = fixture(t, { height: 500_000 });
  layer.enable();
  await layer.update();
  const cards = () =>
    entries.at(-1).filter((entry) => entry.id.startsWith('event-card:'));
  // No canvas in Node: cards need one, so none are painted, and nothing throws.
  assert.deepEqual(cards(), []);
  await settle();
  const reads = calls.feed.length;
  layer.setParams({ filters: { minSeverity: 0 } });
  assert.equal(calls.feed.length, reads);
  assert.deepEqual(
    layer.getRowControls().feed.items.map((item) => item.id),
    ['major', 'minor', 'far'],
  );
});

test('a host that draws the picture cards is handed one card per pictured event on the map, most severe first', async (t) => {
  const picture = (url, extra = {}) => ({
    size: 1,
    lastAt: '2026-10-28T09:00:00.000Z',
    sides: [],
    image: { url, publisher: 'Example', ...extra },
  });
  const reports = [
    report('single', {
      severity: 1,
      event: picture('https://example.com/single.jpg', {
        video: 'https://example.com/single.mp4',
      }),
    }),
    report('major', {
      severity: 3,
      event: {
        ...picture('https://example.com/major.jpg'),
        id: 'event-major',
        size: 3,
      },
    }),
    // Another report of the same event: its picture stands once.
    report('repeat', {
      severity: 2,
      event: {
        ...picture('https://example.com/major.jpg'),
        id: 'event-major',
        size: 3,
      },
    }),
    report('bare', { severity: 2 }),
  ];
  const handed = [];
  const { layer, entries } = fixture(t, {
    height: 500_000,
    source: { getFeed: async () => ({ reports, nextBefore: null }) },
    pictureCards: (cards, state) => handed.push({ cards, ...state }),
  });
  layer.enable();
  await layer.update();
  layer.setParams({ filters: { minSeverity: 0 } });
  const { cards, selectedId } = handed.at(-1);
  assert.equal(selectedId, null);
  // A single source is enough; a report without a picture has none.
  assert.deepEqual(
    cards.map((card) => card.id),
    ['major', 'single'],
  );
  assert.equal(cards[1].image, 'https://example.com/single.jpg');
  assert.equal(cards[1].video, 'https://example.com/single.mp4');
  assert.equal(cards[0].video, null);
  assert.equal(cards[0].credit, 'Example');
  assert.ok(
    Math.abs(cards[0].lat - 50) < 0.5 && Math.abs(cards[0].lon - 36) < 0.5,
  );
  // The layer paints none of its own.
  assert.ok(
    entries.flat().every((entry) => !entry.id.startsWith('event-card:')),
  );
  // The selected report is named, pictured or not.
  layer.setParams({ reportId: 'bare' });
  assert.equal(handed.at(-1).selectedId, 'bare');
  layer.disable();
  assert.deepEqual(handed.at(-1), { cards: [], selectedId: null });
});

test("a host's picture cards stay at every height, beacons or markers", async (t) => {
  const reports = [
    report('major', {
      severity: 3,
      event: {
        size: 1,
        lastAt: '2026-10-28T09:00:00.000Z',
        sides: [],
        image: { url: 'https://example.com/major.jpg', publisher: 'Example' },
      },
    }),
  ];
  const handed = [];
  const { layer } = fixture(t, {
    // The whole globe: the hotspot stands as one beacon, its reports unmarked.
    height: 20_000_000,
    source: { getFeed: async () => ({ reports, nextBefore: null }) },
    pictureCards: (cards) => handed.push(cards),
  });
  layer.enable();
  await layer.update();
  layer.setParams({ filters: { minSeverity: 0 } });
  assert.deepEqual(
    handed.at(-1).map((card) => card.id),
    ['major'],
  );
});

test('picture cards must be drawn by a function', () => {
  assert.throws(
    () =>
      createNewsLayer({
        source: { getHotspots() {}, getFeed() {} },
        overlayHost: {},
        pictureCards: 'yes',
      }),
    TypeError,
  );
});

test('Local reads every report once, lists those near the view and takes the map over', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let centre = { lat: 49, lon: 36 };
  let fail = false;
  const localReads = [];
  const { layer, camera, viewer } = fixture(t, {
    height: 1_000_000,
    centre: () => centre,
    source: {
      getFeed: async (query) => {
        if (query.relevance === '' && query.limit === 500) {
          localReads.push(query);
          if (fail) throw new Error('boom');
          return {
            reports: [
              report('broad', { severity: 1, relevance: 'minor' }),
              report('south', {
                severity: 2,
                pins: [{ lat: 31.5, lon: 34.4, place: 'Gaza', mappable: true }],
              }),
            ],
            nextBefore: null,
          };
        }
        return {
          reports: [report('major', { severity: 3 })],
          nextBefore: null,
        };
      },
    },
  });
  const markers = () =>
    // The layer adds its outlines' source first, then its markers'.
    viewer.added[1].entities.values
      .map((entity) => String(entity.id))
      .filter((id) => /~\d+$/.test(id))
      .map((id) => id.replace(/^.*:/, '').replace(/~\d+$/, ''));
  layer.enable();
  await layer.update();
  for (let i = 0; i < 4; i++) await Promise.resolve();
  // Conflicts: no read of minor news, the hotspots' news on the map.
  assert.equal(localReads.length, 0);
  assert.equal(layer.getRowControls().feed.inView.active, true);
  assert.deepEqual(markers(), ['major']);
  layer.setParams({ filters: { section: 'local' } });
  for (let i = 0; i < 4; i++) await Promise.resolve();
  assert.equal(localReads.length, 1);
  let view = layer.getRowControls().feed;
  // Every severity near the centre; Gaza is beyond 500 km; no older pages.
  assert.deepEqual(
    view.inView.items.map((item) => item.id),
    ['broad'],
  );
  assert.equal(view.hasMore, false);
  assert.deepEqual(markers(), ['broad']);
  // A pan reads nothing more and follows the camera once it settles.
  centre = { lat: 31.5, lon: 34.4 };
  camera.moveEnd.raiseEvent();
  t.mock.timers.tick(800);
  await Promise.resolve();
  assert.equal(localReads.length, 1);
  assert.deepEqual(
    layer.getRowControls().feed.inView.items.map((item) => item.id),
    ['south'],
  );
  assert.deepEqual(markers(), ['south']);
  // Up above 3,000 km there is no "near here": the map shows conflicts again.
  camera.positionCartographic.height = 5_000_000;
  camera.moveEnd.raiseEvent();
  t.mock.timers.tick(800);
  view = layer.getRowControls().feed;
  assert.equal(view.inView.active, false);
  assert.ok(!markers().includes('south'));
  // Back to Conflicts and to Local again with the server failing: it shows.
  camera.positionCartographic.height = 1_000_000;
  layer.setParams({ filters: { section: 'conflicts' } });
  fail = true;
  layer.setParams({ filters: { section: 'local' } });
  for (let i = 0; i < 4; i++) await Promise.resolve();
  assert.equal(localReads.length, 2);
  view = layer.getRowControls().feed;
  assert.equal(view.inView.error, 'News feed unavailable');
  assert.deepEqual(view.inView.items, []);
});

test('Local reads the area at the view centre, lists its reports and outlines it faintly', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let centre = { lat: 49, lon: 36 };
  const areaReads = [];
  const feedReads = [];
  const box = [
    [35, 48],
    [37, 48],
    [37, 50.5],
    [35, 50.5],
  ];
  const { layer, camera, viewer } = fixture(t, {
    height: 1_000_000,
    centre: () => centre,
    source: {
      getFeed: async (query) => {
        feedReads.push(query);
        return {
          reports: [
            report('inside', { severity: 1, relevance: 'minor' }),
            report('beyond', {
              severity: 2,
              pins: [{ lat: 49, lon: 39, place: 'Luhansk', mappable: true }],
            }),
          ],
          nextBefore: null,
        };
      },
      getAreaOutline: async (point) => {
        areaReads.push(point);
        return point.lat > 45
          ? {
              area: {
                key: 'UA',
                name: 'Ukraine',
                kind: 'country',
                country: 'UA',
              },
              polygons: [{ outer: box, holes: [] }],
              borders: [],
              disputed: [],
            }
          : { area: null, polygons: [], borders: [], disputed: [] };
      },
    },
  });
  const outline = () =>
    viewer.added[0].entities.values.filter((e) =>
      String(e.id).includes('local:UA'),
    );
  layer.enable();
  await layer.update();
  await flush();
  // Conflicts reads no area.
  assert.equal(areaReads.length, 0);
  layer.setParams({ filters: { section: 'local' } });
  await flush();
  assert.equal(areaReads.length, 1);
  // The read asks the server for the area's reports, at the point named.
  const localRead = () => feedReads.filter((q) => q.relevance === '').at(-1);
  assert.deepEqual(localRead().at, { lat: 49, lon: 36 });
  let view = layer.getRowControls().feed;
  assert.equal(view.inView.area, 'Ukraine');
  // Luhansk is within 500 km, outside the area.
  assert.deepEqual(
    view.inView.items.map((item) => item.id),
    ['inside'],
  );
  assert.ok(outline().length > 0);
  assert.ok(
    outline().every((e) => e.show && e.polyline.width.getValue() === 1.5),
  );
  // A pan inside the area reads it again only once the centre leaves it.
  centre = { lat: 50, lon: 36.5 };
  camera.moveEnd.raiseEvent();
  t.mock.timers.tick(800);
  await flush();
  assert.equal(areaReads.length, 1);
  // At sea: no area, the radius, and the outline hidden.
  centre = { lat: 43, lon: 34 };
  camera.moveEnd.raiseEvent();
  t.mock.timers.tick(800);
  await flush();
  assert.equal(areaReads.length, 2);
  assert.equal(localRead().at, undefined);
  view = layer.getRowControls().feed;
  assert.equal(view.inView.area, null);
  assert.equal(view.inView.radiusKm, 500);
  assert.ok(outline().every((e) => !e.show));
  // Conflicts hides the area's outline too.
  centre = { lat: 49, lon: 36 };
  camera.moveEnd.raiseEvent();
  t.mock.timers.tick(800);
  await flush();
  assert.ok(outline().every((e) => e.show));
  layer.setParams({ filters: { section: 'conflicts' } });
  await flush();
  assert.ok(outline().every((e) => !e.show));
});

test('a shorter window narrows the feed and reads the hotspot counts for it', async (t) => {
  const asked = [];
  const { layer } = fixture(t, {
    source: {
      getHotspots: async ({ hours } = {}) => {
        asked.push(hours);
        return {
          ...hotspotsPayload,
          windowHours: hours ?? 12,
          maxWindowHours: 12,
        };
      },
      getFeed: async () => ({
        reports: [
          report('recent', { publishedAt: '2026-10-28T09:30:00.000Z' }),
          report('earlier', { publishedAt: '2026-10-28T05:00:00.000Z' }),
        ],
        nextBefore: null,
      }),
    },
  });
  layer.enable();
  await layer.update();
  await settle();
  let view = layer.getRowControls().feed;
  assert.deepEqual(view.windowChoices, [12, 6, 3, 1]);
  assert.equal(view.windowHours, 12);
  assert.deepEqual(
    view.items.map((item) => item.id),
    ['recent', 'earlier'],
  );
  layer.setParams({ filters: { hours: 3 } });
  view = layer.getRowControls().feed;
  assert.equal(view.windowHours, 3);
  assert.deepEqual(
    view.items.map((item) => item.id),
    ['recent'],
  );
  for (let i = 0; i < 3; i++) await settle();
  assert.deepEqual(asked, [undefined, 3]);
  // The server's own window still bounds the choices.
  assert.deepEqual(layer.getRowControls().feed.windowChoices, [12, 6, 3, 1]);
  // A choice longer than the server serves shows all it serves.
  layer.setParams({ filters: { hours: 24 } });
  assert.equal(layer.getRowControls().feed.windowHours, 12);
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

test('a section read from a key the server lacks says which key, and the other still reads', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let liveuamap = keyError('liveuamap');
  let worldNews = keyError('worldnewsapi');
  let hotspotReads = 0;
  const { layer } = fixture(t, {
    height: 1_000_000,
    source: {
      getHotspots: async () => {
        hotspotReads++;
        if (liveuamap) throw liveuamap;
        return hotspotsPayload;
      },
      getFeed: async (query) => {
        if (query.at && worldNews) throw worldNews;
        if (!query.at && liveuamap) throw liveuamap;
        return {
          reports: [report('inside', { relevance: 'minor' })],
          nextBefore: null,
        };
      },
      getAreaOutline: async () => ukraine,
    },
  });
  layer.enable();
  assert.equal(await layer.update(), true);
  await flush();
  let view = layer.getRowControls().feed;
  assert.equal(view.key.title, 'Liveuamap key required');
  assert.match(view.key.hint, /LIVEUAMAP_API_KEY/);
  assert.equal(view.error, null, 'a missing key is no failure');
  assert.equal(layer.getStats().sourceUnavailable, undefined);

  layer.setParams({ filters: { section: 'local' } });
  await flush();
  view = layer.getRowControls().feed;
  assert.equal(view.inView.key.title, 'World News API key required');
  assert.match(view.inView.key.hint, /WORLDNEWSAPI_KEY/);
  assert.equal(view.inView.error, null);

  // A key set meanwhile is picked up by the next refresh.
  worldNews = null;
  await layer.update();
  await flush();
  view = layer.getRowControls().feed;
  assert.equal(view.inView.key, null);
  assert.deepEqual(
    view.inView.items.map((item) => item.id),
    ['inside'],
  );
  assert.equal(view.key.title, 'Liveuamap key required');

  liveuamap = keyError('liveuamap', { keyRejected: true });
  await layer.update();
  view = layer.getRowControls().feed;
  assert.equal(view.key.title, 'Liveuamap refused its key');
  assert.equal(view.key.hint, 'Check LIVEUAMAP_API_KEY in Provider Settings');

  liveuamap = null;
  await layer.update();
  await flush();
  view = layer.getRowControls().feed;
  assert.equal(view.key, null);
  assert.equal(hotspotReads, 4, 'a missing key is asked again each refresh');
});

test("Local says when its provider's allowance for the day is spent, until a read passes", async (t) => {
  let quota = true;
  const { layer } = fixture(t, {
    height: 1_000_000,
    source: {
      getFeed: async (query) => {
        if (query.at && quota)
          throw keyError('worldnewsapi', { keyQuota: true });
        return {
          reports: [report('inside', { relevance: 'minor' })],
          nextBefore: null,
        };
      },
      getAreaOutline: async () => ukraine,
    },
  });
  layer.enable();
  await layer.update();
  await flush();
  layer.setParams({ filters: { section: 'local' } });
  await flush();
  let view = layer.getRowControls().feed;
  assert.deepEqual(view.inView.key, {
    title: 'World News API limit reached for today',
    hint: 'News resumes tomorrow, or with a paid plan',
  });
  assert.equal(view.inView.error, null, 'a spent allowance is no failure');
  quota = false;
  await layer.update();
  await flush();
  view = layer.getRowControls().feed;
  assert.equal(view.inView.key, null);
  assert.deepEqual(
    view.inView.items.map((item) => item.id),
    ['inside'],
  );
});

test('a Conflicts feed read that passes clears its key notice', async (t) => {
  let refuse = true;
  const { layer } = fixture(t, {
    source: {
      getFeed: async (query) => {
        // The panel's feed page, not the map's read.
        if (query.limit === 60 && refuse) throw keyError('liveuamap');
        return {
          reports: [report('major', { severity: 3 })],
          nextBefore: null,
        };
      },
    },
  });
  layer.enable();
  await layer.update();
  await settle();
  assert.equal(layer.getRowControls().feed.key.title, 'Liveuamap key required');
  refuse = false;
  layer.setParams({ filters: { category: 'strike' } });
  await settle();
  const view = layer.getRowControls().feed;
  assert.equal(view.key, null);
  assert.deepEqual(
    view.items.map((item) => item.id),
    ['major'],
  );
});

test('the key providers the layer names match the key registry', () => {
  for (const [id, { envVar }] of Object.entries(NEWS_KEY_PROVIDERS)) {
    const entry = KEY_SETUP_KEYS.find((key) => key.id === id);
    assert.ok(entry, `${id} is in the key registry`);
    assert.deepEqual([...entry.envVars], [envVar]);
  }
});

test('a slower area read for where the camera was never lands over the area it came back to', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let centre = { lat: 49, lon: 36 };
  const pending = [];
  const { layer, camera } = fixture(t, {
    height: 1_000_000,
    centre: () => centre,
    source: {
      getAreaOutline: (point) =>
        point.lat > 45
          ? Promise.resolve(ukraine)
          : new Promise((resolve) => pending.push(resolve)),
    },
  });
  const look = async (at) => {
    centre = at;
    camera.moveEnd.raiseEvent();
    t.mock.timers.tick(800);
    await flush();
  };
  layer.enable();
  await layer.update();
  await flush();
  layer.setParams({ filters: { section: 'local' } });
  await flush();
  assert.equal(layer.getRowControls().feed.inView.area, 'Ukraine');
  // Out to sea, where the area read is slow, and back before it answers.
  await look({ lat: 43, lon: 34 });
  assert.equal(pending.length, 1);
  assert.equal(layer.getRowControls().feed.inView.areaLoading, true);
  await look({ lat: 49.6, lon: 36.2 });
  pending[0](noArea);
  await flush();
  const view = layer.getRowControls().feed;
  assert.equal(view.inView.area, 'Ukraine');
  assert.equal(view.inView.areaLoading, false);
  assert.equal(view.inView.loading, false);
});

test('leaving Local while its area is read sends no Local read', async (t) => {
  let answer = null;
  const localReads = [];
  // The camera stays put: only the section changes.
  const here = { lat: 49, lon: 36 };
  const { layer } = fixture(t, {
    height: 1_000_000,
    centre: () => here,
    source: {
      getFeed: async (query) => {
        if (query.relevance === '') localReads.push(query);
        return { reports: [], nextBefore: null };
      },
      getAreaOutline: () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    },
  });
  layer.enable();
  await layer.update();
  await flush();
  layer.setParams({ filters: { section: 'local' } });
  await flush();
  assert.equal(layer.getRowControls().feed.inView.loading, true);
  layer.setParams({ filters: { section: 'conflicts' } });
  await flush();
  assert.equal(layer.getRowControls().feed.inView.loading, false);
  answer(ukraine);
  await flush();
  assert.equal(localReads.length, 0);
  assert.equal(layer.getRowControls().feed.inView.loading, false);
});

test('a server without the area route keeps Local to the radius and is asked once', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let centre = { lat: 49, lon: 36 };
  let areaReads = 0;
  const localReads = [];
  const { layer, camera } = fixture(t, {
    height: 1_000_000,
    centre: () => centre,
    source: {
      getFeed: async (query) => {
        if (query.relevance === '') localReads.push(query);
        return { reports: [report('near')], nextBefore: null };
      },
      getAreaOutline: async () => {
        areaReads++;
        throw Object.assign(
          new Error('News feed not configured on this server'),
          { status: 404, code: 'unavailable', unavailable: true },
        );
      },
    },
  });
  layer.enable();
  await layer.update();
  await flush();
  layer.setParams({ filters: { section: 'local' } });
  await flush();
  assert.equal(areaReads, 1);
  assert.equal(localReads.length, 1);
  assert.equal(localReads[0].at, undefined);
  let view = layer.getRowControls().feed;
  assert.equal(view.inView.area, null);
  assert.equal(view.inView.areaLoading, false);
  assert.deepEqual(
    view.inView.items.map((item) => item.id),
    ['near'],
  );
  // The settles that follow do not ask for an area again.
  centre = { lat: 47, lon: 31 };
  camera.moveEnd.raiseEvent();
  t.mock.timers.tick(800);
  await flush();
  assert.equal(areaReads, 1);
  // Turning the layer off and on asks again.
  layer.disable();
  layer.enable();
  await layer.update();
  await flush();
  assert.equal(areaReads, 2);
  view = layer.getRowControls().feed;
  assert.equal(view.inView.error, null);
});

test('Liveuamap and Natural Earth are credited once what they credit shows', async (t) => {
  const credits = [];
  const { layer } = fixture(t, {
    height: 1_000_000,
    credits,
    source: {
      getFeed: async (query) => ({
        reports:
          query.relevance === ''
            ? [report('near', { kind: 'rss' })]
            : [report('mapped', { kind: 'liveuamap', severity: 3 })],
        nextBefore: null,
      }),
      getAreaOutline: async () => ukraine,
    },
  });
  layer.enable();
  await layer.update();
  await flush();
  layer.getRowControls();
  assert.deepEqual(credits, ['liveuamap']);
  // The Local area's outline (the built-in server's are Natural Earth's).
  layer.setParams({ filters: { section: 'local' } });
  await flush();
  assert.deepEqual(credits, ['liveuamap', 'natural-earth']);
  // Shown again: registered once.
  layer.setParams({ filters: { section: 'conflicts' } });
  await layer.update();
  await flush();
  layer.getRowControls();
  assert.deepEqual(credits, ['liveuamap', 'natural-earth']);
});

test('without Liveuamap reports or a Local area, nothing is credited', async (t) => {
  const credits = [];
  const { layer } = fixture(t, { height: 1_000_000, credits });
  layer.enable();
  await layer.update();
  await flush();
  layer.getRowControls();
  assert.deepEqual(credits, []);
});

test('a failed Conflicts read leaves Local reading with each refresh', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const failure = () => new Error('News feed unavailable');
  let local = failure();
  const { layer } = fixture(t, {
    height: 1_000_000,
    source: {
      getHotspots: async () => {
        throw failure();
      },
      getFeed: async (query) => {
        if (!query.at) throw failure();
        if (local) throw local;
        return {
          reports: [report('inside', { relevance: 'minor' })],
          nextBefore: null,
        };
      },
      getAreaOutline: async () => ukraine,
    },
  });
  layer.enable();
  await layer.update();
  layer.setParams({ filters: { section: 'local' } });
  await flush();
  assert.equal(
    layer.getRowControls().feed.inView.error,
    'News feed unavailable',
  );
  // The area's read lands meanwhile; Conflicts still fails.
  local = null;
  await layer.update();
  await flush();
  const view = layer.getRowControls().feed;
  assert.deepEqual(
    view.inView.items.map((item) => item.id),
    ['inside'],
  );
  assert.equal(view.error, 'News feed unavailable');
});

test("a country's own news is one badge with a count, not markers piled on its centre", async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const anchor = {
    lat: 49,
    lon: 36,
    place: 'Ukraine',
    precision: 'country',
    mappable: true,
  };
  const { layer, viewer } = fixture(t, {
    height: 1_000_000,
    source: {
      getFeed: async () => ({
        reports: [
          report('own-1', { relevance: 'minor', pins: [anchor] }),
          report('own-2', { relevance: 'minor', pins: [anchor] }),
          report('placed', { relevance: 'minor' }),
        ],
        nextBefore: null,
      }),
    },
  });
  const ids = () =>
    viewer.added[1].entities.values.map((entity) => String(entity.id));
  layer.enable();
  await layer.update();
  layer.setParams({ filters: { section: 'local' } });
  await flush();
  assert.deepEqual(
    ids().filter((id) => /~\d+$/.test(id)),
    ['news:report:placed~0'],
  );
  assert.deepEqual(
    ids().filter((id) => id.startsWith('news:country:')),
    ['news:country:Ukraine'],
  );
  // Both are still listed, and one picked there gets its own marker.
  assert.equal(layer.getRowControls().feed.inView.items.length, 3);
  layer.setParams({ reportId: 'own-1' });
  await flush();
  assert.ok(ids().includes('news:report:own-1~0'));
});

test('Local reports are listed an hour at most while they cannot be read again', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let at = NOW;
  let failing = false;
  const { layer } = fixture(t, {
    height: 1_000_000,
    now: () => at,
    source: {
      getFeed: async (query) => {
        if (query.at && failing) throw new Error('News feed unavailable');
        return {
          reports: [report('inside', { relevance: 'minor' })],
          nextBefore: null,
        };
      },
      getAreaOutline: async () => ukraine,
    },
  });
  const listed = () =>
    layer.getRowControls().feed.inView.items.map((item) => item.id);
  layer.enable();
  await layer.update();
  layer.setParams({ filters: { section: 'local' } });
  await flush();
  assert.deepEqual(listed(), ['inside']);
  // World News API's terms: its news is kept an hour at most, here too.
  failing = true;
  at += 59 * 60_000;
  await layer.update();
  await flush();
  assert.deepEqual(listed(), ['inside']);
  at += 2 * 60_000;
  await layer.update();
  await flush();
  assert.deepEqual(listed(), []);
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

test('narrowing the window and widening it again loses no report already read', async (t) => {
  const { layer } = fixture(t, {
    source: {
      // Two pages: the head page, and an older one behind its cursor.
      getFeed: async ({ before } = {}) =>
        before
          ? {
              reports: [
                report('earlier', { publishedAt: '2026-10-28T05:00:00.000Z' }),
              ],
              nextBefore: null,
            }
          : {
              reports: [
                report('recent', { publishedAt: '2026-10-28T09:30:00.000Z' }),
              ],
              nextBefore: '2026-10-28T09:30:00.000Z',
            },
    },
  });
  const shown = () => layer.getRowControls().feed.items.map((item) => item.id);
  layer.enable();
  await layer.update();
  for (let i = 0; i < 3; i++) await settle();
  assert.deepEqual(shown(), ['recent', 'earlier']);
  layer.setParams({ filters: { hours: 1 } });
  for (let i = 0; i < 3; i++) await settle();
  assert.deepEqual(shown(), ['recent']);
  layer.setParams({ filters: { hours: 24 } });
  for (let i = 0; i < 3; i++) await settle();
  assert.deepEqual(shown(), ['recent', 'earlier']);
});

test("a slower Local read for the area just left never replaces the current area's reports", async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let centre = { lat: 49, lon: 36 };
  const pending = [];
  const russia = {
    area: { key: 'RU', name: 'Russia', kind: 'country', country: 'RU' },
    polygons: [
      {
        outer: [
          [38, 48],
          [40, 48],
          [40, 50.5],
          [38, 50.5],
        ],
        holes: [],
      },
    ],
    borders: [],
    disputed: [],
  };
  const { layer, camera } = fixture(t, {
    height: 1_000_000,
    centre: () => centre,
    source: {
      getAreaOutline: async (point) => (point.lon < 37.5 ? ukraine : russia),
      getFeed: (query) => {
        if (!(query.relevance === '' && query.limit === 500))
          return Promise.resolve({ reports: [], nextBefore: null });
        if (query.at.lon < 37.5)
          return Promise.resolve({
            reports: [report('kharkiv', { severity: 1 })],
            nextBefore: null,
          });
        // Russia's read is slow.
        return new Promise((resolve) => pending.push(resolve));
      },
    },
  });
  const look = async (at) => {
    centre = at;
    camera.moveEnd.raiseEvent();
    t.mock.timers.tick(800);
    await flush();
  };
  const shown = () =>
    layer.getRowControls().feed.inView.items.map((item) => item.id);
  layer.enable();
  await layer.update();
  await flush();
  layer.setParams({ filters: { section: 'local' } });
  await flush();
  assert.deepEqual(shown(), ['kharkiv']);
  await look({ lat: 49, lon: 39 });
  assert.equal(pending.length, 1);
  await look({ lat: 49, lon: 36 });
  pending[0]({
    reports: [
      report('belgorod', {
        severity: 1,
        pins: [{ lat: 49, lon: 39, place: 'Rossosh', mappable: true }],
      }),
    ],
    nextBefore: null,
  });
  await flush();
  const view = layer.getRowControls().feed;
  assert.equal(view.inView.area, 'Ukraine');
  assert.equal(view.inView.loading, false);
  assert.deepEqual(shown(), ['kharkiv']);
});
