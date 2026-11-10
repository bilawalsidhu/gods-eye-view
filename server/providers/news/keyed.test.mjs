import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createKeyedNews,
  gdeltPlace,
  NEWS_KEYS,
  WORLDWIDE_HOTSPOT,
} from './keyed.js';
import { KEY_SETUP_KEYS } from '../../../src/keySetupCore.mjs';
import {
  normalizeFeedPayload,
  normalizeHotspotsPayload,
  normalizeOutlinePayload,
} from '../../../src/layers/news/records.js';
import { inPolygons } from '../../../src/layers/news/model.js';
import { areaAt, countryPolygons } from './areas.js';
import { exportsOfDay } from './gdeltEvents.js';
import { eventRow, gkgRow, zipTable } from './gdeltFixtures.mjs';

const NOW = Date.parse('2026-11-05T12:00:00Z');
const seconds = (iso) => Date.parse(iso) / 1000;

// Liveuamap's `a=mpts` answer, cut down: strings where it writes strings.
const LIVEUAMAP = {
  success: true,
  key: 'redacted',
  venues: [
    {
      id: 101,
      name: 'Russian drone strike on Kharkiv kills 3, injures 12',
      lat: '49.99350',
      lng: '36.23040',
      location: 'Kharkiv',
      timestamp: seconds('2026-11-05T11:00:00Z'),
      link: 'https://liveuamap.com/en/2026/5-november-kharkiv',
      img_share: 'https://a.liveuamap.com/pics/101.jpg',
      video: 'https://a.liveuamap.com/clips/101.mp4',
    },
    {
      id: 102,
      name: 'Floods kill dozens in Amman',
      lat: '31.95390',
      lng: '35.91060',
      location: 'Amman',
      timestamp: seconds('2026-11-05T10:00:00Z'),
      link: 'https://mideast.liveuamap.com/en/2026/5-november-amman',
      img_share: '',
      video: '',
    },
    {
      id: 103,
      name: 'Officials in &quot;Kherson&quot; report shelling',
      lat: '46.63540',
      lng: '32.61690',
      timestamp: seconds('2026-11-05T09:00:00Z'),
      link: 'https://liveuamap.com/en/2026/5-november-kherson',
    },
    // Without a point, a page or a headline: left out.
    { id: 104, name: 'No point', timestamp: seconds('2026-11-05T09:00:00Z') },
    {
      id: 105,
      name: 'No page',
      lat: '1',
      lng: '1',
      timestamp: seconds('2026-11-05T09:00:00Z'),
      link: 'javascript:alert(1)',
    },
    {
      id: 106,
      name: '',
      lat: '1',
      lng: '1',
      timestamp: seconds('2026-11-05T09:00:00Z'),
      link: 'https://liveuamap.com/x',
    },
  ],
};

// World News API's search-news answer, cut down.
const WORLD_NEWS = {
  offset: 0,
  number: 100,
  available: 3,
  news: [
    {
      id: 9001,
      title: 'Visiting minister arrives in Amman for talks',
      url: 'https://www.daily.example/en/minister-amman-talks',
      image: 'https://www.daily.example/pics/visit.jpg',
      publish_date: '2026-11-05 08:30:00',
      language: 'en',
      category: 'politics',
      text: 'The whole article, never kept.',
    },
    {
      id: 9002,
      title: 'Two oil firms advance subsalt exploration',
      url: 'https://markets.example/economic/oil-firms-exploration',
      publish_date: '2026-11-05 07:00:00',
      language: 'ru',
      category: 'business',
    },
    // Sport is left out.
    {
      id: 9004,
      title: 'Al-Faisaly win the cup final',
      url: 'https://sport.example/cup',
      publish_date: '2026-11-05 09:00:00',
      category: 'sports',
    },
    // The same story from another outlet is one.
    {
      id: 9003,
      title: 'TWO OIL FIRMS ADVANCE SUBSALT EXPLORATION',
      url: 'https://portal.test/oil-firms',
      publish_date: '2026-11-05 06:00:00',
    },
  ],
};

// GDELT's exports around NOW: the newest not published yet, two with
// events, the rest of the day empty.
const KHARKIV =
  'https://www.wire.example/rubric-ato/3912-russian-drones-attack-kharkiv-overnight-three-killed.html';
const RED_SEA =
  'https://news.example.com/2026/11/05/houthis-claim-missile-attack-on-tanker-in-red-sea';
const COUNCIL =
  'https://news.example.com/2026/11/05/city-council-approves-new-budget-for-schools';
const BARE = 'https://news.example.com/a/b/123456';
const exportName = (stamp) =>
  `https://data.gdeltproject.org/gdeltv2/${stamp}.export.CSV.zip`;
const EXPORTS = {
  [exportName('20261105120000')]: 404,
  [exportName('20261105114500')]: [
    eventRow({
      id: 1,
      code: '195',
      mentions: 3,
      url: KHARKIV,
      added: '20261105114500',
    }),
    eventRow({
      id: 2,
      code: '195',
      mentions: 8,
      geoType: '1',
      place: 'Yemen',
      lat: 15.5,
      lon: 47.5,
      url: RED_SEA,
      added: '20261105114500',
    }),
    eventRow({ id: 3, url: COUNCIL, added: '20261105114500' }),
  ],
  [exportName('20261105113000')]: [
    eventRow({
      id: 4,
      geoType: '1',
      place: 'Ukraine',
      lat: 49,
      lon: 32,
      url: BARE,
      added: '20261105113000',
    }),
    // An article already read is not a second report.
    eventRow({ id: 5, code: '190', url: KHARKIV, added: '20261105113000' }),
  ],
};
const EMPTY = zipTable('');
// The page titles of the newest export's quarter hour.
const GKG = {
  [exportName('20261105114500').replace('.export.CSV.zip', '.gkg.csv.zip')]: [
    gkgRow(
      KHARKIV,
      'Russian drones attack Kharkiv overnight, three killed - Wire',
    ),
  ],
};

const host = (call) => call.url.host;

/**
 * A fake upstream: answers by host, counts calls, records URLs and headers.
 * An answer is a payload, a status, or a function giving a Response (one
 * held open). `unlisted` is the status of an export not in `exports` (an
 * empty table by default); `gkg` a status for every GKG export.
 */
function upstream(answers = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const href = String(url);
    calls.push({ url: new URL(href), headers: init?.headers || {} });
    if (href.includes('gdeltproject.org')) {
      if (typeof answers.gdelt === 'number')
        return new Response('busy', { status: answers.gdelt });
      if (href.endsWith('/lastupdate.txt') && answers.lastupdate)
        return new Response(
          `95141 9197 http://data.gdeltproject.org/gdeltv2/${answers.lastupdate}.export.CSV.zip
`,
          { status: 200 },
        );
      if (answers.corrupt?.includes(href))
        return new Response('not a zip at all', { status: 200 });
      if (answers.failing?.includes(href))
        return new Response('busy', { status: 503 });
      const gkg = href.endsWith('.gkg.csv.zip');
      const listed = answers.exports ?? EXPORTS;
      const answer = gkg
        ? (answers.gkg ?? GKG[href])
        : Object.hasOwn(listed, href)
          ? listed[href]
          : answers.unlisted;
      if (typeof answer === 'number')
        return new Response('', { status: answer });
      return new Response(answer ? zipTable(answer.join('\n')) : EMPTY, {
        status: 200,
      });
    }
    const answer = href.includes('liveuamap.com')
      ? (answers.liveuamap ?? LIVEUAMAP)
      : (answers.worldnews ?? WORLD_NEWS);
    if (typeof answer === 'function') return answer();
    if (typeof answer === 'number')
      return new Response('{"message":"bad key ABC"}', { status: answer });
    return new Response(JSON.stringify(answer), { status: 200 });
  };
  return { calls, fetchImpl };
}

function keyed({ env, answers, clock = { now: NOW }, logs = [] } = {}) {
  const fake = upstream(answers);
  // The next GDELT reads, run by settle rather than on a timer.
  const timers = [];
  const news = createKeyedNews({
    env: () =>
      env ?? { LIVEUAMAP_API_KEY: 'live-key', WORLDNEWSAPI_KEY: 'wna-key' },
    fetchImpl: fake.fetchImpl,
    now: () => clock.now,
    log: (line) => logs.push(line),
    later: (run) => timers.push(run),
  });
  const ask = (path, query = '') =>
    news.answer(path, new URLSearchParams(query));
  /**
   * Let the background reads finish (the rest of the day, the titles):
   * until nothing is asked for a while, or a bounded number of turns.
   */
  async function settle() {
    let quiet = 0;
    for (let turn = 0; turn < 200 && quiet < 5; turn++) {
      const before = fake.calls.length;
      for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
      await new Promise((r) => setTimeout(r, 1));
      for (const run of timers.splice(0)) run();
      quiet = fake.calls.length === before ? quiet + 1 : 0;
    }
  }
  return { ...fake, ask, clock, logs, settle, timers };
}

const CONFLICTS =
  'hotspot=all&geo=1&today=1&events=1&relevance=core,related&limit=50';
const gdeltCalls = (calls) =>
  calls.filter(
    (c) =>
      host(c) === 'data.gdeltproject.org' &&
      c.url.pathname.endsWith('.export.CSV.zip'),
  );
const gkgCalls = (calls) =>
  calls.filter((c) => c.url.pathname.endsWith('.gkg.csv.zip'));

test('without any key Conflicts are the day of GDELT events, one worldwide hotspot', async () => {
  const { ask, calls, settle } = keyed({ env: {} });
  const answer = await ask('/hotspots');
  assert.equal(answer.status, 200);
  const payload = normalizeHotspotsPayload(answer.body);
  assert.deepEqual(
    payload.hotspots.map((h) => [h.id, h.catchAll]),
    [[WORLDWIDE_HOTSPOT, true]],
  );
  assert.equal(payload.hotspots[0].last24h, 2);
  assert.equal(payload.hotspots[0].mapped24h, 2);
  assert.equal(payload.maxWindowHours, 24);
  // The newest dozen first; the rest of the day after, in the background.
  assert.deepEqual(
    gdeltCalls(calls)
      .slice(0, 12)
      .map((c) => String(c.url)),
    exportsOfDay(NOW).slice(0, 12),
  );
  assert.equal(
    String(gdeltCalls(calls)[0].url),
    'https://data.gdeltproject.org/gdeltv2/20261105120000.export.CSV.zip',
  );
  await settle();
  assert.ok(gdeltCalls(calls).length >= 96);
  assert.ok(calls.every((c) => host(c) === 'data.gdeltproject.org'));
  // Page titles only for the newest three hours (a GKG export is 6 MB).
  assert.ok(gkgCalls(calls).length > 0 && gkgCalls(calls).length <= 12);
});

test('a GDELT article is a report at its place, in its words, credited to GDELT', async () => {
  const { ask, settle } = keyed({ env: {} });
  // The first answer has the events in, titled by their address words; the
  // page titles follow in the background.
  const first = normalizeFeedPayload((await ask('/feed', CONFLICTS)).body);
  assert.equal(
    first.reports.find((r) => r.id === 'gdelt-5').title,
    'Russian drones attack Kharkiv overnight three killed',
  );
  await settle();
  const { reports } = normalizeFeedPayload(
    (await ask('/feed', CONFLICTS)).body,
  );
  // Kharkiv's story was first seen in the earlier export: its first event
  // names it.
  assert.deepEqual(
    reports.map((r) => r.id),
    ['gdelt-2', 'gdelt-5'],
  );
  const [redSea, kharkiv] = reports;
  // Its page title, from the GKG export.
  assert.equal(
    kharkiv.title,
    'Russian drones attack Kharkiv overnight, three killed',
  );
  assert.equal(kharkiv.category, 'strike');
  assert.equal(kharkiv.relevance, 'core');
  assert.equal(kharkiv.severity, 2);
  assert.equal(kharkiv.publisher, 'wire.example');
  assert.equal(kharkiv.attribution, 'GDELT Project');
  assert.equal(kharkiv.kind, 'gdelt');
  assert.equal(kharkiv.side, 'unknown');
  assert.equal(kharkiv.geo.precision, 'city');
  assert.deepEqual(
    kharkiv.pins.map(({ lat, lon }) => [lat, lon]),
    [[49.9935, 36.2304]],
  );
  assert.equal(redSea.geo.place, 'Yemen');
  assert.equal(redSea.geo.precision, 'country');
  // An address without words has GDELT's coding alone: minor, so not in
  // Conflicts, until a page title says what it is.
  const bare = (await ask('/feed', 'hotspot=all&today=1')).body.reports.find(
    (r) => r.id === 'gdelt-4',
  );
  assert.equal(bare.title, 'Fighting reported in Ukraine');
  assert.equal(bare.relevance, 'minor');
  // The council story GDELT coded as fighting is minor: not in Conflicts.
  assert.ok(!reports.some((r) => r.url.includes('city-council')));
});

test('with a Liveuamap key its mapped items join GDELT in the one hotspot', async () => {
  const { ask, calls, settle } = keyed();
  const answer = await ask('/hotspots');
  assert.equal(answer.body.hotspots[0].counts.last24h, 5);
  const live = calls.find((c) => host(c) === 'a.liveuamap.com').url;
  assert.equal(live.searchParams.get('a'), 'mpts');
  assert.equal(live.searchParams.get('key'), 'live-key');
  assert.equal(
    Number(live.searchParams.get('time')),
    (NOW - 86_400_000) / 1000,
  );
  const { reports } = normalizeFeedPayload(
    (await ask('/feed', CONFLICTS)).body,
  );
  const kharkiv = reports.find((r) => r.id === 'lum-101');
  assert.equal(kharkiv.category, 'strike');
  assert.equal(kharkiv.severity, 2);
  assert.equal(kharkiv.publisher, 'Liveuamap');
  assert.deepEqual(
    kharkiv.pins.map(({ lat, lon }) => [lat, lon]),
    [[49.9935, 36.2304]],
  );
  assert.equal(
    kharkiv.event.image.video,
    'https://a.liveuamap.com/clips/101.mp4',
  );
  assert.deepEqual(kharkiv.media, ['video']);
  assert.equal(
    reports.find((r) => r.id === 'lum-103').title,
    'Officials in "Kherson" report shelling',
  );
  // Counts over a shorter window.
  const short = await ask('/hotspots', 'hours=2');
  assert.equal(short.body.hotspots[0].counts.last24h, 4);
  await settle();
});

test('the Conflicts feed pages by time and filters by category and hotspot', async () => {
  const { ask, settle } = keyed({ env: {} });
  // Every report of the day, the minor ones too.
  const all = 'hotspot=all&today=1&events=1';
  // A page ends between two times: both of 11:45 come together, though
  // the page asked for one.
  const first = await ask('/feed', `${all}&limit=1`);
  assert.deepEqual(
    first.body.reports.map((r) => r.id),
    ['gdelt-2', 'gdelt-3'],
  );
  assert.equal(first.body.nextBefore, '2026-11-05T11:45:00.000Z');
  const next = await ask(
    '/feed',
    `${all}&limit=1&before=${first.body.nextBefore}`,
  );
  assert.deepEqual(
    next.body.reports.map((r) => r.id),
    ['gdelt-5', 'gdelt-4'],
  );
  assert.equal(next.body.nextBefore, null);
  const strikes = await ask('/feed', 'hotspot=all&category=strike');
  assert.equal(strikes.body.reports.length, 2);
  const elsewhere = await ask('/feed', 'hotspot=ua-ru-war');
  assert.deepEqual(elsewhere.body.reports, []);
  await settle();
});

test('an export not published yet is looked for again, and the day is kept a day', async () => {
  const exports = { ...EXPORTS };
  const { ask, calls, clock, settle } = keyed({
    env: {},
    answers: { exports },
  });
  await ask('/hotspots');
  await settle();
  const read = gdeltCalls(calls).length;
  // Within five minutes nothing is asked again.
  clock.now += 2 * 60_000;
  await ask('/hotspots');
  assert.equal(gdeltCalls(calls).length, read);
  // The late export is published now, with a new article.
  exports[exportName('20261105120000')] = [
    eventRow({
      id: 6,
      code: '183',
      url: 'https://news.example.com/2026/11/05/car-bomb-kills-five-in-mogadishu-market',
      place: 'Mogadishu, Banaadir, Somalia',
      lat: 2.04,
      lon: 45.34,
      added: '20261105120000',
    }),
  ];
  clock.now += 4 * 60_000;
  await ask('/hotspots');
  await settle();
  const later = await ask('/hotspots');
  assert.equal(later.body.hotspots[0].counts.last24h, 3, 'added, not replaced');
  assert.equal(
    gdeltCalls(calls)
      .slice(read)
      .filter((c) => String(c.url).includes('20261105120000')).length,
    1,
  );
  // A day on, the old ones have aged out.
  clock.now += 24 * 3_600_000;
  const dayOn = await ask('/hotspots');
  await settle();
  assert.equal(dayOn.body.hotspots[0].counts.last24h, 0);
});

test('Local names the country at the point and outlines it, with no key', async () => {
  const { ask, calls } = keyed({ env: {} });
  const answer = await ask('/outline', 'at=31.95,35.93&v=4');
  const outline = normalizeOutlinePayload(answer.body);
  assert.deepEqual(outline.area, {
    key: 'JO',
    name: 'Jordan',
    kind: 'country',
    country: 'JO',
  });
  assert.ok(outline.polygons.length > 0);
  const sea = await ask('/outline', 'at=0,-30&v=4');
  assert.equal(normalizeOutlinePayload(sea.body).area, null);
  const developing = await ask('/outline', 'country=UA&v=4');
  assert.ok(developing.body.polygons.length > 0);
  assert.equal(calls.length, 0);
});

test("Local in a country is its outlets' everyday news, pinned inside it, plus the Conflicts reports there", async () => {
  const { ask, calls } = keyed();
  const answer = await ask(
    '/feed',
    'hotspot=all&geo=1&today=1&events=1&limit=40&at=31.95,35.93',
  );
  assert.equal(answer.status, 200);
  const search = calls.find((c) => host(c) === 'api.worldnewsapi.com');
  assert.equal(search.url.pathname, '/search-news');
  assert.equal(search.url.searchParams.get('source-country'), 'jo');
  assert.equal(search.url.searchParams.has('categories'), false);
  assert.equal(
    search.url.searchParams.get('earliest-publish-date'),
    '2026-11-04 12:00:00',
  );
  assert.equal(search.url.searchParams.has('api-key'), false);
  assert.equal(search.headers['x-api-key'], 'wna-key');

  const { reports } = normalizeFeedPayload(answer.body);
  assert.deepEqual(
    reports.map((r) => r.id),
    ['lum-102', 'wna-9001', 'wna-9002'],
  );
  const [, visit, exploration] = reports;
  assert.equal(visit.category, 'political');
  assert.equal(visit.relevance, 'minor');
  assert.equal(visit.publisher, 'daily.example');
  assert.equal(visit.snippet, null, 'titles and links only');
  assert.equal(visit.geo.precision, 'country');
  assert.equal(visit.geo.place, 'Jordan');
  assert.equal(visit.event.image.publisher, 'daily.example');
  assert.equal(exploration.category, 'economy');

  // The point each is pinned at lies in the area Local outlines.
  const outline = normalizeOutlinePayload(
    (await ask('/outline', 'at=31.95,35.93&v=4')).body,
  );
  const { inPolygons } = await import('../../../src/layers/news/model.js');
  for (const report of reports)
    assert.ok(inPolygons(outline.polygons, report.pins[0]), report.id);
});

test('a disputed area is named as itself: outlined alone, left out of the country around it, read from no country', async () => {
  const { ask, calls, settle } = keyed();
  const crimea = normalizeOutlinePayload(
    (await ask('/outline', 'at=44.95,34.1&v=4')).body,
  );
  assert.deepEqual(crimea.area, {
    key: 'disputed-crimea',
    name: 'Crimea',
    kind: 'disputed',
    country: null,
  });
  const { inPolygons } = await import('../../../src/layers/news/model.js');
  const russia = normalizeOutlinePayload(
    (await ask('/outline', 'at=55.75,37.6&v=4')).body,
  );
  assert.equal(russia.area.name, 'Russia');
  assert.equal(inPolygons(russia.polygons, { lat: 44.95, lon: 34.1 }), false);
  assert.equal(inPolygons(russia.polygons, { lat: 55.75, lon: 37.6 }), true);
  // Local in Crimea: no national outlets asked, the Conflicts reports there.
  const local = await ask('/feed', 'hotspot=all&at=44.95,34.1');
  assert.equal(local.status, 200);
  assert.ok(calls.every((c) => host(c) !== 'api.worldnewsapi.com'));
  await settle();
});

test("GDELT's places are named by their town and the area there, not its old regions", () => {
  const named = (lat, lon, place, precision = 'city') =>
    gdeltPlace({ lat, lon, place, precision }).place;
  assert.equal(
    named(31.43, 34.39, 'Bureij, Yerushalayim, Israel'),
    'Bureij, Palestine',
  );
  assert.equal(
    named(9.07, 7.48, 'Abuja, Abuja Federal Capital Territory, Niger'),
    'Abuja, Nigeria',
  );
  assert.equal(
    named(44.95, 34.1, 'Simferopol, Crimea, Ukraine'),
    'Simferopol, Crimea',
  );
  assert.equal(named(48.4, 31.2, 'Ukraine', 'country'), 'Ukraine');
});

test("a country's news is read once per half hour and Liveuamap's feed once per five minutes", async () => {
  const { ask, calls, clock } = keyed();
  const local = 'hotspot=all&at=31.95,35.93';
  await ask('/feed', local);
  await ask('/feed', local);
  await ask('/hotspots');
  const count = (name) => calls.filter((c) => host(c) === name).length;
  assert.equal(count('api.worldnewsapi.com'), 1);
  assert.equal(count('a.liveuamap.com'), 1);
  clock.now += 6 * 60_000;
  await ask('/feed', local);
  assert.equal(count('api.worldnewsapi.com'), 1);
  assert.equal(count('a.liveuamap.com'), 2);
  clock.now += 25 * 60_000;
  await ask('/feed', local);
  assert.equal(count('api.worldnewsapi.com'), 2);
});

test('Local without its key says which key it needs and reads nothing', async () => {
  const noLocal = keyed({ env: { LIVEUAMAP_API_KEY: 'live-key' } });
  assert.deepEqual(await noLocal.ask('/feed', 'at=31.95,35.93'), {
    status: 503,
    body: { error: 'no_key', key: 'worldnewsapi' },
  });
  assert.ok(noLocal.calls.every((c) => host(c) !== 'api.worldnewsapi.com'));
  // At sea Local is the Conflicts reports by distance, keyless.
  const sea = await keyed({ env: {} }).ask('/feed', 'hotspot=all&at=0,-30');
  assert.equal(sea.status, 200);
});

test('a refused Liveuamap key leaves GDELT; World News API refusing names its key', async () => {
  const logs = [];
  const refused = keyed({ answers: { liveuamap: 401, worldnews: 403 }, logs });
  const conflicts = await refused.ask('/hotspots');
  assert.equal(conflicts.status, 200);
  assert.equal(conflicts.body.hotspots[0].counts.last24h, 2);
  assert.deepEqual(await refused.ask('/feed', 'at=31.95,35.93'), {
    status: 503,
    body: { error: 'key_rejected', key: 'worldnewsapi' },
  });
  // A refused key is logged once, however often it is tried.
  for (let i = 0; i < 3; i++) {
    refused.clock.now += 61_000;
    assert.equal((await refused.ask('/hotspots')).status, 200);
  }
  assert.equal(
    logs.filter((line) => line.includes('LIVEUAMAP_API_KEY was refused'))
      .length,
    1,
  );
  assert.ok(gdeltCalls(refused.calls).length > 0);
  assert.ok(
    refused.calls.filter((c) => host(c) === 'a.liveuamap.com').length > 1,
  );
  // Neither key nor answer body reaches the log.
  assert.ok(logs.length > 0);
  for (const line of logs) assert.doesNotMatch(line, /live-key|wna-key|ABC/);
  await refused.settle();
});

test('a failing GDELT is tried again after a minute, and what it read is kept', async () => {
  const answers = { gdelt: 503 };
  const flaky = keyed({ env: {}, answers });
  assert.deepEqual(await flaky.ask('/hotspots'), {
    status: 502,
    body: { error: 'news_upstream_error' },
  });
  const tried = gdeltCalls(flaky.calls).length;
  await flaky.ask('/hotspots');
  assert.equal(gdeltCalls(flaky.calls).length, tried, 'not within a minute');
  flaky.clock.now += 61_000;
  delete answers.gdelt;
  assert.equal((await flaky.ask('/hotspots')).status, 200);
  await flaky.settle();
  answers.gdelt = 500;
  flaky.clock.now += 6 * 60_000;
  const kept = await flaky.ask('/hotspots');
  await flaky.settle();
  assert.equal(kept.status, 200);
  assert.equal(kept.body.hotspots[0].counts.last24h, 2);
});

test('a new key drops what the old one read', async () => {
  const env = { LIVEUAMAP_API_KEY: 'old', WORLDNEWSAPI_KEY: 'wna-key' };
  const { ask, calls } = keyed({ env });
  await ask('/hotspots');
  env.LIVEUAMAP_API_KEY = 'new';
  await ask('/hotspots');
  assert.deepEqual(
    calls
      .filter((c) => host(c) === 'a.liveuamap.com')
      .map((c) => c.url.searchParams.get('key')),
    ['old', 'new'],
  );
});

test('each key is one the key registry names', () => {
  for (const [id, envVar] of Object.entries(NEWS_KEYS))
    assert.deepEqual(
      KEY_SETUP_KEYS.find((entry) => entry.id === id)?.envVars,
      [envVar],
      id,
    );
});

const MINUTE = 60_000;
const count = (calls, name) => calls.filter((c) => host(c) === name).length;
const UPSTREAM_ERROR = { status: 502, body: { error: 'news_upstream_error' } };
const KEY_QUOTA = {
  status: 503,
  body: { error: 'key_quota', key: 'worldnewsapi' },
};

test('exports never published are given up on, not looked for back to back', async () => {
  // One export of the day has events; GDELT answers 404 for every other.
  const quarter = exportName('20261105114500');
  const { ask, calls, clock, settle } = keyed({
    env: {},
    // GDELT's list names the newest; every other export it answers 404.
    answers: {
      exports: { [quarter]: EXPORTS[quarter] },
      unlisted: 404,
      lastupdate: '20261105120000',
    },
  });
  assert.equal((await ask('/hotspots')).body.hotspots[0].counts.last24h, 2);
  await settle();
  // A round that brings nothing in is the last until the next five minutes.
  let seen = gdeltCalls(calls).length;
  assert.ok(seen <= 2 * 12, `${seen} at first`);
  const steps = [];
  for (let i = 0; i < 20; i++) {
    clock.now += 5 * MINUTE;
    assert.equal((await ask('/hotspots')).status, 200);
    await settle();
    steps.push(gdeltCalls(calls).length - seen);
    seen = gdeltCalls(calls).length;
  }
  // One round each five minutes, until the day has been looked through
  // once; then only the exports of the last hour and a half (GDELT's CDN
  // keeps a 404 for an hour, so a late one may still come).
  assert.ok(
    steps.every((n) => n <= 12),
    steps.join(),
  );
  assert.ok(
    steps.slice(-3).every((n) => n <= 7),
    steps.join(),
  );
  assert.ok(seen <= 2 * 12 + 20 * 12, String(seen));
});

test('GDELT with no export read at all is a 502, not an empty Conflicts', async () => {
  const { ask } = keyed({ env: {}, answers: { exports: {}, unlisted: 404 } });
  assert.deepEqual(await ask('/hotspots'), UPSTREAM_ERROR);
  assert.deepEqual(await ask('/feed', CONFLICTS), UPSTREAM_ERROR);
});

test('GDELT failing for two hours answers 502; until then what it read is served', async () => {
  const answers = {};
  const { ask, clock, settle } = keyed({ env: {}, answers });
  await ask('/hotspots');
  await settle();
  answers.gdelt = 503;
  clock.now += 60 * MINUTE;
  const hour = await ask('/hotspots');
  assert.equal(hour.status, 200);
  assert.equal(hour.body.hotspots[0].counts.last24h, 2);
  clock.now += 61 * MINUTE;
  assert.deepEqual(await ask('/hotspots'), UPSTREAM_ERROR);
  assert.deepEqual(await ask('/feed', CONFLICTS), UPSTREAM_ERROR);
  await settle();
});

test('a failed GKG read keeps the events, titled by their words, and is tried again', async () => {
  const answers = { gkg: 500 };
  const { ask, calls, clock, logs, settle } = keyed({ env: {}, answers });
  const kharkiv = (answer) =>
    normalizeFeedPayload(answer.body).reports.find((r) => r.id === 'gdelt-5');
  await ask('/hotspots');
  await settle();
  const read = await ask('/feed', CONFLICTS);
  assert.equal(read.status, 200);
  assert.equal(read.body.reports.length, 2);
  assert.equal(
    kharkiv(read).title,
    'Russian drones attack Kharkiv overnight three killed',
  );
  assert.ok(logs.some((line) => line.includes('titles read failed')));
  // Each GKG export once, not with every read of the day.
  assert.equal(gkgCalls(calls).length, 11);
  delete answers.gkg;
  clock.now += 5 * MINUTE;
  await ask('/hotspots');
  await settle();
  assert.equal(
    kharkiv(await ask('/feed', CONFLICTS)).title,
    'Russian drones attack Kharkiv overnight, three killed',
  );
});

test('Local where only Conflicts reports speak answers 502 when they fail; in a country the outlets stay', async () => {
  const { ask, calls } = keyed({ answers: { gdelt: 503, liveuamap: 500 } });
  // Crimea, and Somaliland (a territory without a code).
  assert.deepEqual(
    await ask('/feed', 'hotspot=all&at=44.95,34.1'),
    UPSTREAM_ERROR,
  );
  assert.deepEqual(
    await ask('/feed', 'hotspot=all&at=9.56,44.06'),
    UPSTREAM_ERROR,
  );
  assert.equal(count(calls, 'api.worldnewsapi.com'), 0);
  const jordan = await ask('/feed', 'hotspot=all&at=31.95,35.93');
  assert.equal(jordan.status, 200);
  assert.deepEqual(
    jordan.body.reports.map((r) => r.id),
    ['wna-9001', 'wna-9002'],
  );
});

test('a territory without a code is named as itself, not read as sea', async () => {
  const { ask, calls, settle } = keyed();
  for (const [at, key, name] of [
    ['9.56,44.06', 'disputed-somaliland', 'Somaliland'],
    ['35.12,33.94', 'disputed-northern-cyprus', 'Northern Cyprus'],
  ]) {
    const outline = normalizeOutlinePayload(
      (await ask('/outline', `at=${at}&v=4`)).body,
    );
    assert.deepEqual(outline.area, {
      key,
      name,
      kind: 'disputed',
      country: null,
    });
    assert.ok(outline.polygons.length > 0);
  }
  assert.equal(
    gdeltPlace({
      lat: 9.56,
      lon: 44.06,
      place: 'Hargeysa, Somalia',
      precision: 'city',
    }).place,
    'Hargeysa, Somaliland',
  );
  const local = await ask('/feed', 'hotspot=all&at=9.56,44.06');
  assert.equal(local.status, 200);
  assert.equal(count(calls, 'api.worldnewsapi.com'), 0);
  await settle();
});

test('a stale Liveuamap or World News API read is served while it is read again', async () => {
  const answers = {};
  const { ask, calls, clock, settle } = keyed({ answers });
  const local = 'hotspot=all&at=31.95,35.93';
  const ids = (answer) => answer.body.reports.map((r) => r.id);
  assert.deepEqual(ids(await ask('/feed', local)), [
    'lum-102',
    'wna-9001',
    'wna-9002',
  ]);
  // Both read again, and held open: the answer does not wait for them.
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const later = (payload) => () =>
    held.then(() => new Response(JSON.stringify(payload), { status: 200 }));
  answers.liveuamap = later({ venues: [] });
  answers.worldnews = later({ news: [] });
  clock.now += 31 * MINUTE;
  const served = await ask('/feed', local);
  assert.equal(served.status, 200);
  assert.deepEqual(ids(served), ['lum-102', 'wna-9001', 'wna-9002']);
  assert.equal(count(calls, 'a.liveuamap.com'), 2);
  assert.equal(count(calls, 'api.worldnewsapi.com'), 2);
  // Once read, the new answers are served.
  release();
  await settle();
  assert.deepEqual(ids(await ask('/feed', local)), []);
  // A country not read before is waited for.
  answers.worldnews = WORLD_NEWS;
  assert.equal(
    (await ask('/feed', 'hotspot=all&at=48.85,2.35')).body.reports.length,
    2,
  );
});

test('a read in flight with a replaced key is not the answer for the new one', async () => {
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const env = { LIVEUAMAP_API_KEY: 'old' };
  const answers = {
    liveuamap: () =>
      held.then(() => new Response(JSON.stringify({ venues: [] }))),
  };
  const { ask, calls, settle } = keyed({ env, answers });
  const before = ask('/hotspots');
  env.LIVEUAMAP_API_KEY = 'new';
  delete answers.liveuamap;
  const after = await ask('/hotspots');
  assert.equal(after.body.hotspots[0].counts.last24h, 5);
  assert.deepEqual(
    calls
      .filter((c) => host(c) === 'a.liveuamap.com')
      .map((c) => c.url.searchParams.get('key')),
    ['old', 'new'],
  );
  release();
  await before;
  // The old key's late answer does not replace the new one's.
  assert.equal((await ask('/hotspots')).body.hotspots[0].counts.last24h, 5);
  await settle();
});

test("World News API's reads are a daily budget: spent, Local says key_quota and serves what it read", async () => {
  const { ask, calls, clock, logs, settle } = keyed({
    env: { WORLDNEWSAPI_KEY: 'wna-key', WORLDNEWSAPI_DAILY_READS: '2' },
  });
  const at = (point) => ask('/feed', `hotspot=all&at=${point}`);
  assert.equal((await at('31.95,35.93')).status, 200);
  assert.equal((await at('48.85,2.35')).status, 200);
  // Germany would be the third read today.
  assert.deepEqual(await at('52.52,13.4'), KEY_QUOTA);
  assert.equal(count(calls, 'api.worldnewsapi.com'), 2);
  // Jordan, read earlier, is served from what was read.
  clock.now += 31 * MINUTE;
  const kept = await at('31.95,35.93');
  assert.equal(kept.status, 200);
  assert.equal(kept.body.reports.length, 2);
  assert.equal(count(calls, 'api.worldnewsapi.com'), 2);
  assert.equal(
    logs.filter((line) => line.includes('reads for today are spent')).length,
    1,
  );
  // A new UTC day has its own reads.
  clock.now = Date.parse('2026-11-06T00:30:00Z');
  assert.equal((await at('52.52,13.4')).status, 200);
  assert.equal(count(calls, 'api.worldnewsapi.com'), 3);
  await settle();
});

test('World News API answering 402 is key_quota, and nothing more is asked today; a 429 is no quota', async () => {
  const paid = keyed({ answers: { worldnews: 402 } });
  assert.deepEqual(await paid.ask('/feed', 'at=31.95,35.93'), KEY_QUOTA);
  paid.clock.now += 2 * MINUTE;
  assert.deepEqual(await paid.ask('/feed', 'at=48.85,2.35'), KEY_QUOTA);
  assert.equal(count(paid.calls, 'api.worldnewsapi.com'), 1);
  // A 429 is its per-second limit: an ordinary failure, tried again soon.
  const busy = keyed({ answers: { worldnews: 429 } });
  assert.deepEqual(await busy.ask('/feed', 'at=31.95,35.93'), UPSTREAM_ERROR);
  await paid.settle();
  await busy.settle();
});

test('one unreadable export is given up on and never holds the rest back', async () => {
  const bad = exportName('20261105114500');
  const { ask, calls, clock, settle } = keyed({
    env: {},
    answers: { corrupt: [bad] },
  });
  // The other export's stories are served, from the first answer on (its
  // copy of the Kharkiv story among them).
  const first = await ask('/hotspots');
  assert.equal(first.status, 200);
  assert.equal(first.body.hotspots[0].counts.last24h, 1);
  await settle();
  clock.now += 6 * MINUTE;
  assert.equal((await ask('/hotspots')).status, 200);
  await settle();
  const asked = gdeltCalls(calls).filter((c) => String(c.url) === bad).length;
  assert.equal(asked, 1, 'an unreadable file is not fetched again');
});

test('no export later than the newest GDELT lists is asked for (its CDN keeps a 404 an hour)', async () => {
  const { ask, calls, settle } = keyed({
    env: {},
    answers: { lastupdate: '20261105114500' },
  });
  assert.equal((await ask('/hotspots')).status, 200);
  await settle();
  assert.ok(
    !gdeltCalls(calls).some(
      (c) => String(c.url) === exportName('20261105120000'),
    ),
  );
  assert.ok(
    gdeltCalls(calls).some(
      (c) => String(c.url) === exportName('20261105114500'),
    ),
  );
});

test('a town a disputed area is named after is named as the town alone', () => {
  assert.equal(
    gdeltPlace({
      lat: 31.7667,
      lon: 35.2333,
      place: 'Jerusalem, Israel (general), Israel',
      precision: 'city',
    }).place,
    'Jerusalem',
  );
});

test('World News API is credited on each of its reports', async () => {
  const { ask, settle } = keyed();
  const { reports } = normalizeFeedPayload(
    (await ask('/feed', 'hotspot=all&at=31.95,35.93')).body,
  );
  const national = reports.filter((r) => r.kind === 'worldnewsapi');
  assert.ok(national.length > 0);
  for (const r of national) assert.equal(r.attribution, 'World News API');
  await settle();
});

test('GDELT down for a few minutes gives up on no export: they are all read once it is back', async () => {
  const answers = { gdelt: 503 };
  const { ask, calls, clock, settle } = keyed({ env: {}, answers });
  for (let i = 0; i < 4; i++) {
    await ask('/hotspots');
    await settle();
    clock.now += 61_000;
  }
  delete answers.gdelt;
  clock.now += 5 * MINUTE;
  const back = await ask('/hotspots');
  await settle();
  assert.equal(back.status, 200);
  assert.equal(back.body.hotspots[0].counts.last24h, 2);
  assert.ok(
    gdeltCalls(calls).some(
      (c) => String(c.url) === exportName('20261105114500'),
    ),
  );
});

test('a GDELT outage answering 404, its list down too, gives up on no export', async () => {
  const answers = { exports: {}, unlisted: 404 };
  const { ask, clock, settle } = keyed({ env: {}, answers });
  // Long enough for the stories' exports to be 90 minutes old.
  for (let i = 0; i < 20; i++) {
    await ask('/hotspots');
    await settle();
    clock.now += 5 * MINUTE;
  }
  delete answers.exports;
  delete answers.unlisted;
  for (let i = 0; i < 3; i++) {
    clock.now += 5 * MINUTE;
    await ask('/hotspots');
    await settle();
  }
  const back = await ask('/hotspots');
  assert.equal(back.status, 200);
  assert.equal(back.body.hotspots[0].counts.last24h, 2);
});

test('a host answering junk for every file gives up on none of them', async () => {
  const answers = {
    corrupt: [exportName('20261105114500'), exportName('20261105113000')],
    exports: {},
    unlisted: 404,
  };
  const { ask, clock, settle } = keyed({ env: {}, answers });
  await ask('/hotspots');
  await settle();
  answers.corrupt = [];
  delete answers.exports;
  delete answers.unlisted;
  clock.now += 6 * MINUTE;
  await ask('/hotspots');
  await settle();
  const back = await ask('/hotspots');
  assert.equal(back.body.hotspots[0].counts.last24h, 2);
});

test('a failing file gets one strike a round, not three within seconds', async () => {
  const flaky = exportName('20261105114500');
  const answers = { failing: [flaky] };
  const { ask, calls, clock, settle } = keyed({ env: {}, answers });
  // The startup fill runs several rounds a few seconds apart.
  await ask('/hotspots');
  await settle();
  // GDELT answers again for it before three rounds five minutes apart.
  answers.failing = [];
  clock.now += 6 * MINUTE;
  await ask('/hotspots');
  await settle();
  const back = await ask('/hotspots');
  assert.equal(back.body.hotspots[0].counts.last24h, 2);
  assert.ok(
    gdeltCalls(calls).filter((c) => String(c.url) === flaky).length >= 2,
  );
});

test("a country's own news keeps World News API's category and no severity, whatever its words", async () => {
  const { worldNewsReport } = await import('./keyed.js');
  const { countryByCode } = await import('./areas.js');
  const country = countryByCode('JO');
  const read = (title, category) =>
    worldNewsReport(
      {
        id: 1,
        title,
        url: 'https://times.example/x',
        publisher: 'times.example',
        publishedAt: '2026-11-05T08:00:00.000Z',
        category,
      },
      country,
    );
  const rankings = read(
    'Jordan Advances in Global Digital Rankings as AI Infrastructure Expands',
    'technology',
  );
  assert.equal(rankings.category, 'other');
  assert.equal(rankings.severity, undefined);
  assert.equal(
    read('Startup advances to the next funding round', 'business').category,
    'economy',
  );
  assert.equal(read('King visits Amman', 'politics').category, 'political');
  assert.equal(read('Parliament session opens', null).category, 'other');
});

test(
  'a first read slower than the browser waits answers unavailable, and the next ask is served from it',
  { timeout: 5_000 },
  async () => {
    const fake = upstream();
    let release;
    const held = new Promise((resolve) => {
      release = resolve;
    });
    const news = createKeyedNews({
      env: () => ({ WORLDNEWSAPI_KEY: 'wna-key' }),
      fetchImpl: async (url, init) => {
        if (new URL(url).host === 'api.worldnewsapi.com') await held;
        return fake.fetchImpl(url, init);
      },
      now: () => NOW,
      log: () => {},
      later: () => {},
      firstAnswerMs: 20,
    });
    const local = () =>
      news.answer('/feed', new URLSearchParams('hotspot=all&at=31.95,35.93'));
    assert.deepEqual(await local(), UPSTREAM_ERROR);
    // The read went on, and is not asked again.
    release();
    await new Promise((resolve) => setTimeout(resolve, 5));
    const served = await local();
    assert.equal(served.status, 200);
    assert.deepEqual(
      served.body.reports.map((r) => r.id),
      ['wna-9001', 'wna-9002'],
    );
    assert.equal(count(fake.calls, 'api.worldnewsapi.com'), 1);
  },
);

test(
  'a first GDELT read slower than the browser waits answers unavailable, and the next is served from it',
  { timeout: 5_000 },
  async () => {
    const fake = upstream();
    let release;
    const held = new Promise((resolve) => {
      release = resolve;
    });
    const news = createKeyedNews({
      env: () => ({}),
      fetchImpl: async (url, init) => {
        if (new URL(url).host === 'data.gdeltproject.org') await held;
        return fake.fetchImpl(url, init);
      },
      now: () => NOW,
      log: () => {},
      later: () => {},
      firstAnswerMs: 20,
    });
    const hotspots = () => news.answer('/hotspots', new URLSearchParams());
    assert.deepEqual(await hotspots(), UPSTREAM_ERROR);
    release();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal((await hotspots()).status, 200);
  },
);

test(
  'a refused key stays refused while its next read is slow',
  { timeout: 5_000 },
  async () => {
    let release;
    const held = new Promise((resolve) => {
      release = resolve;
    });
    let reads = 0;
    const clock = { now: NOW };
    const fake = upstream({
      worldnews: async () => {
        reads++;
        if (reads > 1) await held;
        return new Response('{"message":"bad key"}', { status: 401 });
      },
    });
    const news = createKeyedNews({
      env: () => ({ WORLDNEWSAPI_KEY: 'wna-key' }),
      fetchImpl: fake.fetchImpl,
      now: () => clock.now,
      log: () => {},
      later: () => {},
      firstAnswerMs: 20,
    });
    const local = () =>
      news.answer('/feed', new URLSearchParams('hotspot=all&at=31.95,35.93'));
    const refused = {
      status: 503,
      body: { error: 'key_rejected', key: 'worldnewsapi' },
    };
    assert.deepEqual(await local(), refused);
    // Past the retry wait it is read again, slowly: still refused meanwhile.
    clock.now += 61_000;
    assert.deepEqual(await local(), refused);
    assert.equal(reads, 2);
    release();
  },
);

test("World News API's news is kept an hour at most, also while it cannot be read again", async () => {
  const answers = {};
  const { ask, clock, settle } = keyed({ answers });
  const local = 'hotspot=all&at=31.95,35.93';
  const own = (answer) =>
    answer.body.reports.filter((r) => r.id.startsWith('wna-')).length;
  assert.equal(own(await ask('/feed', local)), 2);
  // Its terms: a cache of at most an hour, then deleted.
  answers.worldnews = 500;
  clock.now += 59 * MINUTE;
  assert.equal(own(await ask('/feed', local)), 2);
  clock.now += 2 * MINUTE;
  assert.deepEqual(await ask('/feed', local), UPSTREAM_ERROR);
  await settle();
});

test('a World News API read that never reached it is not counted against the day', async () => {
  const answers = {
    worldnews: () => {
      throw new TypeError('fetch failed');
    },
  };
  const { ask, clock, settle } = keyed({
    env: { WORLDNEWSAPI_KEY: 'wna-key', WORLDNEWSAPI_DAILY_READS: '2' },
    answers,
  });
  const paris = () => ask('/feed', 'hotspot=all&at=48.85,2.35');
  for (let i = 0; i < 3; i++) {
    assert.deepEqual(await paris(), UPSTREAM_ERROR);
    clock.now += 2 * MINUTE;
  }
  // Back online: the day's reads are all still there.
  answers.worldnews = WORLD_NEWS;
  assert.equal((await paris()).status, 200);
  // An answer, even a failing one, is a read, and so is a request that
  // timed out, which it may have read: two of them spend the day.
  answers.worldnews = () => {
    throw new DOMException('timed out', 'TimeoutError');
  };
  const berlin = () => ask('/feed', 'hotspot=all&at=52.52,13.4');
  assert.deepEqual(await berlin(), UPSTREAM_ERROR);
  clock.now += 2 * MINUTE;
  assert.deepEqual(await berlin(), KEY_QUOTA);
  await settle();
});

test('Local lists a Conflicts report by any of its pins, not its first alone', async () => {
  const url =
    'https://news.example.com/2026/11/05/drones-hit-kharkiv-and-belgorod-overnight';
  const exports = {
    [exportName('20261105114500')]: [
      eventRow({ id: 1, code: '195', mentions: 9, url }),
      eventRow({
        id: 2,
        code: '195',
        mentions: 2,
        place: "Belgorod, Belgorodskaya Oblast', Russia",
        lat: 50.6,
        lon: 36.6,
        url,
      }),
    ],
  };
  const { ask, settle } = keyed({
    env: { WORLDNEWSAPI_KEY: 'wna-key' },
    answers: { exports, worldnews: { news: [] } },
  });
  const urls = async (at) =>
    (await ask('/feed', `hotspot=all&at=${at}`)).body.reports.map((r) => r.url);
  assert.deepEqual(await urls('49.99,36.23'), [url]);
  assert.deepEqual(await urls('50.6,36.6'), [url]);
  await settle();
});

test('the hotspot counts the reports Conflicts lists: no minor ones', async () => {
  const { ask, settle } = keyed({ env: {} });
  const listed = (
    await ask('/feed', 'hotspot=all&today=1&relevance=core,related&limit=60')
  ).body.reports;
  const { counts } = (await ask('/hotspots')).body.hotspots[0];
  assert.equal(counts.last24h, listed.length);
  assert.equal(counts.mapped24h, listed.filter((r) => r.geo).length);
  // The council story is among the day's reports, and minor.
  const all = (await ask('/feed', 'hotspot=all&today=1&limit=60')).body.reports;
  assert.ok(all.length > listed.length);
  await settle();
});

test('a disputed area is cut out of the country it lies in, not of the neighbour its first corner touches', () => {
  const outline = (lat, lon) => countryPolygons(areaAt(lat, lon).country);
  for (const [country, at, name, inside] of [
    ['Israel', [32.08, 34.78], 'Golan Heights', [33.0, 35.75]],
    ['Moldova', [47.0, 28.85], 'Transnistria', [47.2, 29.5]],
    ['Egypt', [30.0, 31.2], 'Halayib', [22.5, 35.5]],
  ]) {
    const [lat, lon] = inside;
    assert.equal(areaAt(lat, lon).kind, 'disputed', name);
    assert.equal(
      inPolygons(outline(...at), { lat, lon }),
      false,
      `${country} without ${name}`,
    );
  }
});
