import test from 'node:test';
import assert from 'node:assert/strict';

import {
  addressWords,
  cleanTitle,
  gkgUrl,
  parseTitles,
  withNames,
  eventReports,
  exportsOfDay,
  exportUrl,
  fetchExport,
  parseEvents,
  unzipExport,
} from './gdeltEvents.js';
import { eventRow, gkgRow, zipTable } from './gdeltFixtures.mjs';

const ARTICLE =
  'https://www.wire.example/rubric-ato/3912-russian-drones-attack-kharkiv-overnight-three-killed.html';

test('the day is 96 exports, one each quarter hour, newest first', () => {
  const now = Date.parse('2026-11-05T15:07:30Z');
  assert.equal(
    exportUrl(now),
    'https://data.gdeltproject.org/gdeltv2/20261105150000.export.CSV.zip',
  );
  const day = exportsOfDay(now);
  assert.equal(day.length, 96);
  assert.equal(
    day[1],
    'https://data.gdeltproject.org/gdeltv2/20261105144500.export.CSV.zip',
  );
  assert.equal(
    day.at(-1),
    'https://data.gdeltproject.org/gdeltv2/20261104151500.export.CSV.zip',
  );
});

test('a story with physical violence is kept with all its placed events', () => {
  const rows = [
    eventRow({ id: 1, code: '195', url: ARTICLE }),
    eventRow({ id: 2, code: '183', url: ARTICLE }),
    eventRow({ id: 3, code: '2001', url: ARTICLE }),
    // Not physical, but of the same story: kept to place it by.
    eventRow({ id: 4, code: '150', url: ARTICLE }),
    eventRow({ id: 7, code: '190', quad: '3', url: ARTICLE }),
    // A story with no violence in it is left out.
    eventRow({
      id: 5,
      code: '163',
      url: 'https://x.example/talks-resume-in-geneva-today-officials',
    }),
    eventRow({
      id: 6,
      code: '173',
      url: 'https://x.example/talks-resume-in-geneva-today-officials',
    }),
    // Unplaced, at 0,0, or without a link.
    eventRow({ id: 8, geoType: '0', url: ARTICLE }),
    eventRow({ id: 9, lat: 0, lon: 0, url: ARTICLE }),
    eventRow({ id: 10, url: 'javascript:alert(1)' }),
    'short\trow',
  ];
  const events = parseEvents(rows.join('\n'));
  assert.deepEqual(
    events.map((e) => [e.id, e.violent]),
    [
      ['1', true],
      ['2', true],
      ['3', true],
      ['4', false],
      ['7', false],
    ],
  );
  assert.equal(events[0].precision, 'city');
  assert.equal(events[0].addedAt, '2026-11-05T11:45:00.000Z');
});

test("an article is one report, at its most-mentioned event, in its address's words", () => {
  const events = parseEvents(
    [
      eventRow({ id: 11, code: '195', mentions: 2, url: ARTICLE }),
      eventRow({
        id: 12,
        code: '190',
        mentions: 9,
        url: ARTICLE,
        place: "Kupiansk, Kharkivs'ka Oblast', Ukraine",
        lat: 49.71,
        lon: 37.61,
      }),
      eventRow({
        id: 13,
        code: '190',
        geoType: '1',
        place: 'Ukraine',
        lat: 49,
        lon: 32,
        url: 'https://example.com/a/b/12345',
      }),
    ].join('\n'),
  );
  const [drones, bare] = eventReports(events);
  // The story's first event (by time, then id) names it.
  assert.equal(drones.id, 'gdelt-11');
  // Its address words, with the place it is at written as a name.
  assert.equal(
    drones.title,
    'Russian drones attack Kharkiv overnight three killed',
  );
  // Kupiansk has more mentions; the article's own words name Kharkiv.
  assert.equal(drones.geo.place, "Kharkiv, Kharkivs'ka Oblast', Ukraine");
  assert.equal(drones.geo.precision, 'city');
  assert.equal(drones.locations.length, 0, 'Kupiansk is not named');
  assert.equal(drones.category, 'strike');
  assert.equal(drones.relevance, 'core');
  assert.equal(drones.severity, 2);
  assert.equal(drones.publisher, 'wire.example');
  assert.equal(drones.source.attribution, 'GDELT Project');
  assert.equal(drones.side, 'unknown', 'no actor is said');
  // No words in the address: GDELT's coding alone, so minor (not listed
  // under Conflicts), at least severity 1.
  assert.equal(bare.title, 'Fighting reported in Ukraine');
  assert.equal(bare.category, 'ground');
  assert.equal(bare.relevance, 'minor');
  assert.equal(bare.severity, 1);
  assert.equal(bare.geo.precision, 'country');
});

test('an article GDELT codes as fighting whose words say otherwise stays out of Conflicts', () => {
  const [report] = eventReports(
    parseEvents(
      eventRow({
        url: 'https://news.example.com/2026/11/05/city-council-approves-new-budget-for-schools',
        id: 20,
      }),
    ),
  );
  assert.equal(report.relevance, 'minor');
});

test('address words need four lettered words, most of the address', () => {
  assert.equal(addressWords('https://x.example/news/1234567'), null);
  assert.equal(addressWords('https://x.example/a/lueop1pzfi'), null);
  assert.equal(
    addressWords('https://x.example/2026/11/05/a-b-1-2-3-4-5'),
    null,
  );
  assert.equal(
    addressWords(
      'https://x.example/story/2638789/three-children-die-in-peshawar.html',
    ),
    'Three children die in peshawar',
  );
});

test('an export is unzipped and read; one not published yet is null', async () => {
  const zip = zipTable(eventRow({ id: 30, code: '193', url: ARTICLE }));
  assert.deepEqual(
    parseEvents(await unzipExport(zip)).map((e) => e.id),
    ['30'],
  );
  const served = await fetchExport('https://data.gdeltproject.org/x.zip', {
    fetchImpl: async () => new Response(zip, { status: 200 }),
  });
  assert.deepEqual(
    served.map((e) => e.id),
    ['30'],
  );
  const later = await fetchExport('https://data.gdeltproject.org/y.zip', {
    fetchImpl: async () => new Response('not found', { status: 404 }),
  });
  assert.equal(later, null);
  await assert.rejects(
    fetchExport('https://data.gdeltproject.org/z.zip', {
      fetchImpl: async () => new Response('busy', { status: 503 }),
    }),
    { name: 'UpstreamError' },
  );
  await assert.rejects(unzipExport(new Uint8Array([1, 2, 3])), {
    name: 'UpstreamError',
  });
});

test("a nationality is no place: a town the article's words name wins over a bare country", () => {
  const url =
    'https://www.sun.example/world/2026/11/05/security-officer-attacked-and-killed-near-sri-lankan-embassy-in-jordans-capital';
  const amman = { place: 'Amman, (JO11), Jordan', lat: 31.95, lon: 35.9333 };
  const cairo = { place: 'Cairo, Al Qahirah, Egypt', lat: 30.05, lon: 31.25 };
  const [report] = eventReports(
    parseEvents(
      [
        // "Sri Lankan embassy": GDELT's most-mentioned place, a bare country.
        eventRow({
          id: 1,
          mentions: 12,
          geoType: '1',
          place: 'Sri Lanka',
          lat: 7,
          lon: 81,
          url,
        }),
        eventRow({ id: 2, mentions: 6, ...cairo, url }),
        eventRow({ id: 3, mentions: 4, ...amman, url }),
        eventRow({ id: 4, mentions: 2, ...amman, url }),
      ].join('\n'),
    ),
  );
  assert.equal(report.geo.place, 'Amman, (JO11), Jordan');
  assert.equal(report.geo.precision, 'city');
});

test('an agency story run by several outlets is one report, placed by all their events', () => {
  const words = 'jordan-security-officer-killed-near-sri-lanka-embassy';
  const times = `https://www.times.example/story/9386807/${words}/`;
  const chronicle = `https://www.chronicle.example/story/9386807/${words}/`;
  const reports = eventReports(
    parseEvents(
      [
        // The outlet's own country, at country level, on its violent events.
        eventRow({
          id: 1,
          mentions: 6,
          geoType: '1',
          place: 'Australia',
          lat: -25,
          lon: 135,
          url: times,
          added: '20261105141500',
        }),
        // Its other events are placed in Jordan.
        eventRow({
          id: 2,
          code: '120',
          quad: '3',
          mentions: 8,
          place: 'Karak, Jordan (general), Jordan',
          lat: 31.18,
          lon: 35.7,
          url: times,
          added: '20261105141500',
        }),
        eventRow({
          id: 3,
          mentions: 4,
          geoType: '1',
          place: 'Syria',
          lat: 35,
          lon: 38,
          url: chronicle,
          added: '20261105151500',
        }),
      ].join('\n'),
    ),
  );
  assert.equal(reports.length, 1);
  const [story] = reports;
  assert.equal(story.copies, 2);
  assert.equal(story.url, times, 'the first copy');
  assert.equal(story.publishedAt, '2026-11-05T14:15:00.000Z');
  assert.equal(story.geo.place, 'Karak, Jordan (general), Jordan');
});

test("a story's title is a copy's page title from the GKG export", () => {
  const titles = parseTitles(
    [
      gkgRow(
        ARTICLE,
        'Russian drones attack Kharkiv overnight, three killed | Wire',
      ),
      gkgRow('https://elsewhere.example/a', 'Not one of ours, not kept here'),
    ].join('\n'),
    new Set([ARTICLE]),
  );
  assert.deepEqual(
    [...titles],
    [[ARTICLE, 'Russian drones attack Kharkiv overnight, three killed']],
  );
  const [report] = eventReports(
    parseEvents(eventRow({ id: 1, url: ARTICLE })),
    {
      titleOf: (url) => titles.get(url) || null,
    },
  );
  assert.equal(
    report.title,
    'Russian drones attack Kharkiv overnight, three killed',
  );
  assert.equal(report.titled, 'page');
  assert.equal(
    gkgUrl(
      'https://data.gdeltproject.org/gdeltv2/20261105141500.export.CSV.zip',
    ),
    'https://data.gdeltproject.org/gdeltv2/20261105141500.gkg.csv.zip',
  );
});

test('a page title loses its site name, keeps its words, and must be a headline', () => {
  assert.equal(
    cleanTitle(
      'Yemen&#039;s president sacks ministers | Yemen | The Daily Example',
    ),
    "Yemen's president sacks ministers",
  );
  assert.equal(
    cleanTitle('Strike in Kharkiv - live updates - Wire Service'),
    'Strike in Kharkiv - live updates',
  );
  // Too little before the dash: the dash is part of the headline.
  assert.equal(cleanTitle('Iran - Wire Service'), 'Iran - Wire Service');
  assert.equal(cleanTitle('Home'), null);
  assert.equal(
    cleanTitle('Jordanian security officer killed in stabbing attack-Newswire'),
    'Jordanian security officer killed in stabbing attack',
  );
  assert.equal(
    cleanTitle('Five killed in Gaza, sources say-X'),
    'Five killed in Gaza, sources say',
  );
  // A hyphenated name is no tag.
  assert.equal(
    cleanTitle('Talks resume with Jean-Pierre'),
    'Talks resume with Jean-Pierre',
  );
});

test('address words keep their numbers and name the places the story is at', () => {
  const words = addressWords(
    'https://x.example/2026/11/05/jordan-says-u-s-envoy-met-officials-in-amman-after-500-killed',
  );
  assert.equal(
    words,
    'Jordan says u s envoy met officials in amman after 500 killed',
  );
  assert.equal(
    withNames(words, [{ place: 'Amman, (JO11), Jordan' }]),
    'Jordan says US envoy met officials in Amman after 500 killed',
  );
});

test("a story's id is its first event's: a later, more-mentioned event keeps it", () => {
  const first = eventRow({ id: 40, mentions: 1, url: ARTICLE });
  const [before] = eventReports(parseEvents(first));
  const [after] = eventReports(
    parseEvents(
      [
        first,
        eventRow({
          id: 41,
          code: '195',
          mentions: 30,
          url: ARTICLE,
          added: '20261105120000',
        }),
      ].join('\n'),
    ),
  );
  assert.equal(before.id, 'gdelt-40');
  assert.equal(after.id, 'gdelt-40');
  assert.equal(after.mentions, 31);
});

test('words that read as no conflict leave GDELT no kind to name', () => {
  const [report] = eventReports(
    parseEvents(
      eventRow({
        id: 42,
        code: '195',
        url: 'https://x.example/2026/11/05/local-bakery-celebrates-fifty-years-of-baking',
      }),
    ),
  );
  assert.equal(report.relevance, 'minor');
  assert.equal(report.category, 'other');
});

test('a GKG address written with http is the https one the events carry', () => {
  const plain = ARTICLE.replace('https:', 'http:');
  const [event] = parseEvents(eventRow({ id: 43, url: plain }));
  assert.equal(event.url, ARTICLE);
  const titles = parseTitles(
    gkgRow(plain, 'Russian drones attack Kharkiv overnight, three killed'),
    new Set([event.url]),
  );
  assert.equal(
    titles.get(ARTICLE),
    'Russian drones attack Kharkiv overnight, three killed',
  );
});

test('a corrupt or oversized export is an UpstreamError, never a RangeError', async () => {
  const zip = zipTable(eventRow({ id: 44, url: ARTICLE }));
  const view = new DataView(zip.buffer);
  // The central directory's local header offset, pointing past the end.
  const dir = view.getUint32(zip.length - 22 + 16, true);
  const far = zip.slice();
  new DataView(far.buffer).setUint32(dir + 42, zip.length - 10, true);
  await assert.rejects(unzipExport(far), { name: 'UpstreamError' });
  // The end record cut short.
  await assert.rejects(unzipExport(zip.subarray(0, zip.length - 30)), {
    name: 'UpstreamError',
  });
  // Unzipped past the table's cap.
  await assert.rejects(unzipExport(zip, 16), { name: 'UpstreamError' });
  assert.equal((await unzipExport(zip)).length > 16, true);
});
