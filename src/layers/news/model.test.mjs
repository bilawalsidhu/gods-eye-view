import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeFeedPayload,
  normalizeHotspotsPayload,
  normalizeOutlinePayload,
} from './records.js';
import {
  NEWS_IN_VIEW_RADIUS_KM,
  ageWords,
  areaLabel,
  beaconPixelSize,
  cardEvents,
  cardView,
  distanceKm,
  eventPixelSize,
  feedCardView,
  feedQueryFor,
  hotspotLabel,
  hotspotTrend,
  inPolygons,
  isPressing,
  markerStyle,
  mergeFeedPage,
  newsWindowChoices,
  newsWindowMs,
  normalizeFilters,
  passesFilters,
  reportMarkerPosition,
  reportSeverity,
  reportsInView,
  sidesLine,
  sourceLinkLabel,
  viewCell,
  visibleOnMap,
  withinNewsWindow,
} from './model.js';
import { newsFeedQuery } from './source.js';

const NOW = Date.parse('2026-10-28T10:00:00Z');
const report = (id, publishedAt, extra = {}) => ({
  id,
  title: `Report ${id}`,
  url: `https://example.com/${id}`,
  publishedAt,
  publisher: 'Example',
  side: 'UA',
  category: 'strike',
  hotspotIds: ['ua'],
  geo: {
    lat: 50,
    lon: 36,
    place: 'Kharkiv',
    precision: 'city',
    mappable: true,
  },
  pins: [
    { lat: 50, lon: 36, place: 'Kharkiv', precision: 'city', mappable: true },
  ],
  ...extra,
});
const event = (extra = {}) => ({
  status: 'both-sides',
  size: 6,
  severity: 3,
  lastAt: '2026-10-28T09:30:00Z',
  sides: [
    {
      side: 'UA',
      title: 'a',
      url: 'https://a.test/',
      publisher: 'A',
      publishedAt: '2026-10-28T09:00:00Z',
    },
    {
      side: 'RU',
      title: 'b',
      url: 'https://b.test/',
      publisher: 'B',
      publishedAt: '2026-10-28T09:20:00Z',
    },
  ],
  image: { url: 'https://a.test/p.jpg', publisher: 'A' },
  ...extra,
});

test('payloads are validated record by record; empty and malformed payloads', () => {
  const hotspots = normalizeHotspotsPayload({
    hotspots: [
      {
        id: 'ua',
        name: 'UA',
        bbox: [22, 44, 42, 56],
        parties: ['UA', 'RU', '<x>'],
        counts: { last24h: 3 },
      },
      { id: 'bad', name: 'Bad', bbox: [42, 44, 22, 56] },
      { id: '../x', name: 'Bad id', bbox: [22, 44, 42, 56] },
    ],
    ingest: { lastRunAt: '2026-10-28T10:00:00Z' },
  });
  assert.deepEqual(
    hotspots.hotspots.map((h) => [h.id, h.parties, h.last24h]),
    [['ua', ['UA', 'RU'], 3]],
  );
  assert.equal(hotspots.lastRunAt, '2026-10-28T10:00:00.000Z');
  assert.equal(normalizeHotspotsPayload({}), null);
  assert.equal(normalizeHotspotsPayload(null), null);
  assert.deepEqual(normalizeHotspotsPayload({ hotspots: [] }).hotspots, []);

  const feed = normalizeFeedPayload({
    reports: [
      {
        id: 'r_1',
        title: ' Strike  on Kharkiv ',
        url: 'https://x.test/a',
        publishedAt: '2026-10-28T09:00:00Z',
        geo: { lat: 50, lon: 36, mappable: true },
        media: ['video', 'video', 'audio'],
        event: { size: 3, image: { url: 'http://x.test/p.jpg' } },
      },
      {
        id: 'r_2',
        title: 'Bad link',
        url: 'javascript:alert(1)',
        publishedAt: '2026-10-28T09:00:00Z',
      },
      {
        id: 'r_3',
        title: 'Bad geo',
        url: 'https://user:pw@x.test/c',
        publishedAt: '2026-10-28T09:00:00Z',
      },
      {
        id: 'r_4',
        title: 'Off the globe',
        url: 'https://x.test/d',
        publishedAt: '2026-10-28T09:00:00Z',
        geo: { lat: 200, lon: 36 },
      },
    ],
    nextBefore: '2026-10-28T08:00:00Z',
  });
  assert.deepEqual(
    feed.reports.map((r) => [r.id, r.title, Boolean(r.geo), r.pins.length]),
    [
      ['r_1', 'Strike on Kharkiv', true, 1],
      ['r_4', 'Off the globe', false, 0],
    ],
  );
  assert.deepEqual(feed.reports[0].media, ['video']);
  // A picture must be HTTPS on the publisher's site.
  assert.equal(feed.reports[0].event.image, null);
  assert.equal(feed.nextBefore, '2026-10-28T08:00:00.000Z');
  assert.equal(normalizeFeedPayload({ reports: 'x' }), null);
  assert.deepEqual(normalizeFeedPayload({ reports: [] }), {
    reports: [],
    nextBefore: null,
  });
});

test("an event's clip is kept only as an HTTPS file a browser plays itself", () => {
  const clip = (video) =>
    normalizeFeedPayload({
      reports: [
        {
          id: 'r',
          title: 'T',
          url: 'https://x.test/r',
          publishedAt: '2026-10-28T09:00:00Z',
          event: {
            size: 1,
            image: { url: 'https://cdn.test/p.jpg', publisher: 'P', video },
          },
        },
      ],
    }).reports[0].event.image.video;
  assert.equal(
    clip('https://cdn.test/v.mp4?token=a'),
    'https://cdn.test/v.mp4?token=a',
  );
  assert.equal(clip('https://cdn.test/v.webm'), 'https://cdn.test/v.webm');
  assert.equal(clip('http://cdn.test/v.mp4'), undefined);
  assert.equal(clip('https://cdn.test/v.m3u8'), undefined);
  assert.equal(clip(undefined), undefined);
});

test('outlines keep valid rings, borders and named disputed areas', () => {
  const ring = [
    [30, 45],
    [31, 45],
    [31, 46],
  ];
  const outline = normalizeOutlinePayload({
    polygons: [{ outer: ring, holes: [[[0, 0]]] }, { outer: [[1, 2]] }],
    borders: [ring, 'x'],
    disputed: [
      {
        name: 'Crimea',
        kind: 'held',
        heldBy: 'RU',
        claimedBy: 'UA',
        rings: [ring],
      },
      { name: 'No rings', rings: [] },
      { name: 'Odd kind', kind: 'zzz', heldBy: 'nope', rings: [ring] },
    ],
  });
  assert.equal(outline.polygons.length, 1);
  assert.deepEqual(outline.polygons[0].holes, []);
  assert.equal(outline.borders.length, 1);
  assert.deepEqual(
    outline.disputed.map((d) => [d.name, d.kind, d.heldBy]),
    [
      ['Crimea', 'held', 'RU'],
      ['Odd kind', 'held', null],
    ],
  );
  assert.deepEqual(normalizeOutlinePayload(null), {
    polygons: [],
    borders: [],
    disputed: [],
    area: null,
  });
  // Indonesia's 208 islands are all kept.
  const islands = Array.from({ length: 208 }, () => ({ outer: ring }));
  assert.equal(
    normalizeOutlinePayload({ polygons: islands }).polygons.length,
    208,
  );
});

test('a point outline names its area, and Local keeps to it', () => {
  const box = [
    [35, 48],
    [37, 48],
    [37, 50.5],
    [35, 50.5],
  ];
  const { area, polygons } = normalizeOutlinePayload({
    area: { key: 'US-TX', name: 'Texas', kind: 'region', country: 'US' },
    polygons: [{ outer: box, holes: [] }],
  });
  assert.deepEqual(area, {
    key: 'US-TX',
    name: 'Texas',
    kind: 'region',
    country: 'US',
  });
  assert.equal(areaLabel(area), 'Texas, United States');
  assert.equal(
    areaLabel({ ...area, kind: 'country', country: 'UA' }),
    'Ukraine',
  );
  // A disputed area is named as itself, never as either side's.
  assert.equal(
    areaLabel({ key: 'disputed:Crimea', name: 'Crimea', kind: 'disputed' }),
    'Crimea',
  );
  assert.equal(normalizeOutlinePayload({ area: { key: 'X' } }).area, null);
  const at = (id, lat, lon) =>
    report(id, '2026-10-28T09:00:00Z', {
      pins: [{ lat, lon, mappable: true }],
    });
  const reports = [at('inside', 50, 36), at('beyond', 49, 39)];
  const filters = normalizeFilters({ minSeverity: 0 });
  const centre = { lat: 49, lon: 36 };
  const now = Date.parse('2026-10-28T10:00:00Z');
  const ids = (area) =>
    reportsInView(reports, centre, filters, now, 10, undefined, area).map(
      (r) => r.id,
    );
  // Within 500 km both; inside the area only the one.
  assert.deepEqual(ids(null), ['inside', 'beyond']);
  assert.deepEqual(ids(polygons), ['inside']);
  assert.ok(inPolygons(polygons, { lat: 49, lon: 36 }));
  assert.ok(!inPolygons([{ outer: box, holes: [box] }], { lat: 49, lon: 36 }));
});

test('feed pages merge newest first without duplicates', () => {
  const a = report('a', '2026-10-28T10:00:00Z');
  const b = report('b', '2026-10-28T09:00:00Z');
  const c = report('c', '2026-10-28T08:00:00Z');
  let feed = mergeFeedPage(
    { items: [] },
    { reports: [a, b], nextBefore: 'B' },
    'replace',
    NOW,
  );
  assert.deepEqual(
    [feed.items.map((r) => r.id), feed.nextBefore],
    [['a', 'b'], 'B'],
  );
  feed = mergeFeedPage(
    feed,
    { reports: [b, c], nextBefore: null },
    'append',
    NOW,
  );
  assert.deepEqual(
    [feed.items.map((r) => r.id), feed.nextBefore],
    [['a', 'b', 'c'], null],
  );
  const newer = report('n', '2026-10-28T11:00:00Z');
  feed = mergeFeedPage(
    { ...feed, nextBefore: 'C' },
    { reports: [newer, a], nextBefore: 'X' },
    'head',
    NOW + 3_600_000,
  );
  assert.deepEqual(
    [feed.items.map((r) => r.id), feed.nextBefore],
    [['n', 'a', 'b', 'c'], 'C'],
  );
  assert.deepEqual(
    mergeFeedPage({ items: [] }, { reports: [], nextBefore: null }, 'replace'),
    { items: [], nextBefore: null },
  );
});

test('a head page that does not reach the rows held starts the list over', () => {
  const held = report('h', '2026-10-28T06:00:00Z');
  const fresh = report('n', '2026-10-28T09:30:00Z');
  // More than a page arrived since the last refresh (a suspended tab): the
  // reports between this page and the rows held are behind its cursor.
  const feed = mergeFeedPage(
    { items: [held], nextBefore: 'OLD' },
    { reports: [fresh], nextBefore: 'NEW' },
    'head',
    NOW,
  );
  assert.deepEqual(
    [feed.items.map((r) => r.id), feed.nextBefore],
    [['n'], 'NEW'],
  );
});

test('the feed list keeps only the last 24 hours and at most its cap', () => {
  const fresh = report('f', '2026-10-28T09:00:00Z');
  const stale = report('s', '2026-10-27T09:00:00Z');
  const ahead = report('x', '2026-10-28T11:00:00Z');
  // A long session: yesterday's rows already held fall out on the next merge.
  const feed = mergeFeedPage(
    { items: [stale], nextBefore: 'S' },
    { reports: [fresh, ahead], nextBefore: 'F' },
    'head',
    NOW,
  );
  assert.deepEqual(
    feed.items.map((r) => r.id),
    ['f'],
  );
  const many = Array.from({ length: 30 }, (_, i) =>
    report(`r${i}`, new Date(NOW - (i + 1) * 60_000).toISOString()),
  );
  const capped = mergeFeedPage(
    { items: [] },
    { reports: many, nextBefore: null },
    'replace',
    NOW,
    10,
  );
  assert.equal(capped.items.length, 10);
  assert.equal(capped.items[0].id, 'r0');
  assert.equal(capped.items.at(-1).id, 'r9');
  // Everything outside the window: an empty list, not an error.
  assert.deepEqual(
    mergeFeedPage(
      { items: [] },
      { reports: [stale], nextBefore: null },
      'replace',
      NOW,
    ).items,
    [],
  );
});

test('filters default to significant news and map to a last-24-hours query', () => {
  const hotspots = [{ id: 'ua' }, { id: 'me' }];
  const filters = normalizeFilters(
    { hotspot: 'ua', category: 'nope', minSeverity: 9 },
    hotspots,
  );
  assert.deepEqual(filters, {
    hotspot: 'ua',
    category: 'all',
    minSeverity: 2,
    section: 'conflicts',
    hours: null,
  });
  assert.equal(
    normalizeFilters({ section: 'local' }, hotspots).section,
    'local',
  );
  assert.equal(
    normalizeFilters({ section: 'nope' }, hotspots).section,
    'conflicts',
  );
  assert.equal(normalizeFilters({ hours: 6 }, hotspots).hours, 6);
  assert.equal(normalizeFilters({ hours: 5 }, hotspots).hours, null);
  assert.equal(normalizeFilters({ minSeverity: 0 }, hotspots).minSeverity, 0);
  assert.equal(normalizeFilters({ hotspot: 'gone' }, hotspots).hotspot, 'all');
  assert.equal(
    newsFeedQuery(
      feedQueryFor(filters, { before: '2026-10-28T08:00:00.000Z' }),
    ),
    'hotspot=ua&before=2026-10-28T08%3A00%3A00.000Z&limit=60&relevance=core%2Crelated&today=1&events=1',
  );
  // The Conflicts feed reads the same whichever section is chosen.
  assert.equal(
    newsFeedQuery(feedQueryFor({ ...filters, section: 'local' })),
    newsFeedQuery(feedQueryFor(filters)),
  );
});

test('only the last 24 hours pass, and the severity floor applies', () => {
  const filters = normalizeFilters();
  const fresh = report('f', '2026-10-28T09:00:00Z', { severity: 2 });
  const minor = report('m', '2026-10-28T09:00:00Z', { severity: 1 });
  const old = report('o', '2026-10-27T09:00:00Z', { severity: 3 });
  assert.equal(withinNewsWindow(fresh, NOW), true);
  assert.equal(withinNewsWindow(old, NOW), false);
  assert.equal(withinNewsWindow({ publishedAt: 'x' }, NOW), false);
  // Clock skew up to 15 min ahead passes; further ahead is not news yet.
  const skew = report('k', '2026-10-28T10:14:00Z');
  const future = report('z', '2026-10-28T10:16:00Z');
  assert.equal(withinNewsWindow(skew, NOW), true);
  assert.equal(withinNewsWindow(future, NOW), false);
  assert.deepEqual(
    [fresh, minor, old]
      .filter((r) => passesFilters(r, filters, NOW))
      .map((r) => r.id),
    ['f'],
  );
  assert.equal(visibleOnMap(minor, { ...filters, minSeverity: 0 }, NOW), true);
  assert.equal(visibleOnMap(fresh, { ...filters, hotspot: 'me' }, NOW), false);
});

test('ageWords says now, minutes or hours', () => {
  assert.equal(ageWords('2026-10-28T09:59:30Z', NOW), 'now');
  assert.equal(ageWords('2026-10-28T09:55:00Z', NOW), '5 min');
  assert.equal(ageWords('2026-10-28T07:10:00Z', NOW), '2 h');
  assert.equal(ageWords('2026-10-26T07:10:00Z', NOW), '24 h');
  assert.equal(ageWords('not a date', NOW), '');
});

test('markers spread deterministically near their place; source link line', () => {
  const r = report('r_spread', '2026-10-28T10:00:00Z');
  const p1 = reportMarkerPosition(r);
  assert.deepEqual(reportMarkerPosition(r), p1);
  assert.ok(Math.abs(p1.lat - 50) < 0.02 && Math.abs(p1.lon - 36) < 0.04);
  assert.notDeepEqual(
    reportMarkerPosition(report('r_other', r.publishedAt)),
    p1,
  );
  assert.equal(
    sourceLinkLabel('https://www.reliefweb.int/report/x'),
    'Source: reliefweb.int ↗',
  );
  assert.equal(sourceLinkLabel('not a url'), '');
});

test('beacons carry a focus, a size by activity and a trend only against a prior day', () => {
  const { hotspots } = normalizeHotspotsPayload({
    hotspots: [
      {
        id: 'a',
        name: 'A',
        bbox: [20, 40, 40, 50],
        focus: { lat: 45, lon: 30 },
        counts: { last24h: 120, prev24h: 80 },
      },
      {
        id: 'b',
        name: 'B',
        bbox: [20, 40, 40, 50],
        focus: { lat: 80, lon: 30 },
      },
    ],
  });
  assert.deepEqual(
    hotspots.map((h) => h.focus),
    [
      { lat: 45, lon: 30 },
      { lat: 45, lon: 30 },
    ],
  );
  assert.equal(hotspotTrend(120, 80), '▲');
  assert.equal(hotspotTrend(50, 80), '▼');
  assert.equal(hotspotTrend(85, 80), '');
  assert.equal(hotspotTrend(40, 0), '');
  assert.equal(beaconPixelSize(0), 10);
  assert.equal(beaconPixelSize(10_000), 26);
  assert.equal(
    hotspotLabel({ id: 'ua-ru-war', name: 'Russia–Ukraine war' }),
    'Ukraine–Russia',
  );
  assert.equal(hotspotLabel({ id: 'new-one', name: 'New one' }), 'New one');
  assert.equal(
    hotspotLabel({ id: 'x', name: 'X', catchAll: true }),
    'Elsewhere',
  );
  assert.equal(
    hotspotLabel({ id: 'worldwide', name: 'Worldwide', catchAll: true }),
    'Worldwide',
  );
});

test('marker style: severity fill, attestation rim, size by sources, fading with age', () => {
  const r = report('r_style', '2026-10-28T10:00:00Z', {
    severity: 2,
    event: event({
      status: 'claimed',
      size: 4,
      lastAt: '2026-10-28T10:00:00Z',
    }),
  });
  const fresh = markerStyle(r, NOW);
  assert.equal(fresh.severity, 3); // the event's, when higher than the report's
  assert.equal(fresh.rim, 'claimed');
  assert.equal(fresh.size, eventPixelSize(4));
  // The icon is half the disc: no marker is too small to read it.
  assert.equal(eventPixelSize(1), 24);
  assert.equal(eventPixelSize(1000), 36);
  assert.equal(fresh.alpha, 1);
  assert.equal(markerStyle(r, NOW + 48 * 3_600_000).alpha, 0.45);
  assert.equal(reportSeverity({ category: 'political' }), 0);
  assert.equal(reportSeverity({ category: 'strike' }), 1);
});

test('picture cards: physical, two or more sources, major or pressing, at most ten', () => {
  const big = report('big', '2026-10-28T09:30:00Z', { event: event() });
  const statement = report('st', '2026-10-28T09:30:00Z', {
    category: 'political',
    event: event(),
  });
  const lone = report('lone', '2026-10-28T09:30:00Z', {
    event: event({ size: 1 }),
  });
  const stale = report('stale', '2026-10-28T01:00:00Z', {
    event: event({ severity: 2, lastAt: '2026-10-28T01:00:00Z' }),
  });
  assert.equal(isPressing(big, NOW), true);
  assert.deepEqual(
    cardEvents([statement, lone, stale, big], NOW).map((r) => r.id),
    ['big'],
  );
  const many = Array.from({ length: 14 }, (_, i) =>
    report(`m${i}`, '2026-10-28T09:30:00Z', { event: event() }),
  );
  assert.equal(cardEvents(many, NOW).length, 10);
  const view = cardView(big, NOW);
  assert.equal(view.image, 'https://a.test/p.jpg');
  assert.equal(view.credit, 'A');
  assert.equal(view.meta, '30 min · 6 sources · UA, RU');
  assert.equal(cardView(lone, NOW).image, null);
});

test('feed cards: headline, meta parts, sides and chips', () => {
  const r = report('fc', '2026-10-28T09:00:00Z', {
    title: 'Удар по Харкову',
    titleEn: 'Strike on Kharkiv',
    affiliation: 'military',
    media: ['video', 'photo'],
    geo: { lat: 50, lon: 36, place: 'Kharkiv', mappable: true, byModel: true },
    event: event({ lastAt: '2026-10-28T09:50:00Z' }),
  });
  const view = feedCardView(r, NOW);
  assert.equal(view.title, 'Strike on Kharkiv');
  assert.equal(view.original, 'Удар по Харкову');
  assert.equal(view.placedByModel, true);
  assert.equal(view.severityLabel, 'Major');
  assert.equal(view.color, '#ff4444');
  assert.equal(view.category, 'Strike');
  assert.equal(view.place, 'Kharkiv');
  assert.equal(view.sources, '6 sources');
  assert.equal(view.age, '10 min');
  assert.equal(view.sides, 'Reported by UA sources · RU sources');
  assert.deepEqual(view.picture, { url: 'https://a.test/p.jpg', credit: 'A' });
  assert.deepEqual(
    view.chips.map((c) => [c.kind, c.label]),
    [
      ['official', 'Official'],
      ['confirmed', 'Reported by both sides'],
      ['media', 'Video'],
      ['media', 'Photos'],
    ],
  );
  assert.deepEqual(
    view.others.map((o) => o.side),
    ['RU'],
  );
  // A lone report: its own side, no picture, one source.
  const single = feedCardView(report('s', '2026-10-28T09:00:00Z'), NOW);
  assert.equal(single.sides, 'Reported by UA sources');
  assert.equal(single.picture, null);
  // A one-source event (a Telegram post) shows its picture and its clip in
  // the panel, though the globe's picture cards need two sources.
  const post = report('p', '2026-10-28T09:00:00Z', {
    event: {
      size: 1,
      sides: [],
      image: {
        url: 'https://cdn4.telesco.pe/file/v.jpg',
        publisher: 'Channel',
        video: 'https://cdn4.telesco.pe/file/v.mp4?token=x',
      },
    },
  });
  assert.deepEqual(feedCardView(post, NOW).picture, {
    url: 'https://cdn4.telesco.pe/file/v.jpg',
    credit: 'Channel',
    video: 'https://cdn4.telesco.pe/file/v.mp4?token=x',
  });
  assert.equal(single.original, null);
  assert.equal(sidesLine({ side: 'unknown' }), '');
});

test('event sides older than a day are left out of the card and its sides line', () => {
  const r = report('w', '2026-10-28T09:00:00Z', {
    event: event({
      sides: [
        {
          side: 'UA',
          title: 'a',
          url: 'https://a.test/',
          publisher: 'A',
          publishedAt: '2026-10-28T08:00:00Z',
        },
        {
          side: 'RU',
          title: 'old',
          url: 'https://b.test/',
          publisher: 'B',
          publishedAt: '2026-10-26T08:00:00Z',
        },
        {
          side: 'unknown',
          title: 'c',
          url: 'https://c.test/',
          publisher: 'C',
          publishedAt: '2026-10-28T09:10:00Z',
        },
        // No date: nothing shows it is recent.
        { side: 'IL', title: 'd', url: 'https://d.test/', publisher: 'D' },
      ],
    }),
  });
  const view = feedCardView(r, NOW);
  assert.deepEqual(
    view.others.map((o) => [o.side, o.title]),
    [['Unattributed', 'c']],
  );
  // The unattributed side is not named in the sides line.
  assert.equal(view.sides, 'Reported by UA sources');
  assert.equal(cardView(r, NOW).meta, '30 min · 6 sources · UA, Unattributed');
  // All sides outside the window: no others, the report's own side remains.
  const stale = report('v', '2026-10-28T09:00:00Z', {
    event: event({
      sides: [
        {
          side: 'RU',
          title: 'old',
          url: 'https://b.test/',
          publisher: 'B',
          publishedAt: '2026-10-26T08:00:00Z',
        },
      ],
    }),
  });
  assert.deepEqual(feedCardView(stale, NOW).others, []);
  assert.equal(feedCardView(stale, NOW).sides, 'Reported by UA sources');
});

test('in view: half-degree cells and reports within 500 km of the centre', () => {
  assert.equal(viewCell({ lat: 50.2, lon: 36.7 }), '100:73');
  assert.equal(viewCell({ lat: 50.4, lon: 36.9 }), '100:73');
  assert.notEqual(viewCell({ lat: 50.6, lon: 36.7 }), '100:73');
  assert.ok(
    Math.abs(distanceKm({ lat: 0, lon: 0 }, { lat: 0, lon: 1 }) - 111.2) < 0.5,
  );
  const filters = normalizeFilters({ minSeverity: 0 });
  const near = report('near', '2026-10-28T09:00:00Z', { severity: 1 });
  const major = report('major', '2026-10-28T08:00:00Z', { severity: 3 });
  const far = report('far', '2026-10-28T09:00:00Z', {
    pins: [{ lat: 31.5, lon: 34.4, place: 'Gaza', mappable: true }],
  });
  const old = report('old', '2026-10-27T08:00:00Z');
  const centre = { lat: 49, lon: 36 };
  assert.ok(distanceKm(centre, far.pins[0]) > NEWS_IN_VIEW_RADIUS_KM);
  assert.deepEqual(
    reportsInView([near, far, old, major], centre, filters, NOW).map(
      (r) => r.id,
    ),
    ['near', 'major'],
  );
  assert.deepEqual(reportsInView([near], null, filters, NOW), []);
  assert.deepEqual(reportsInView([], centre, filters, NOW), []);
});

test('a server may serve fewer hours than the day, never more', () => {
  assert.equal(newsWindowMs(12), 12 * 3_600_000);
  assert.equal(newsWindowMs(24), 24 * 3_600_000);
  for (const bad of [0, 25, 12.5, '12', null, undefined])
    assert.equal(newsWindowMs(bad), 24 * 3_600_000);
  const page = {
    reports: [
      report('fresh', '2026-10-28T02:00:00Z'),
      report('old', '2026-10-27T20:00:00Z'),
    ],
    nextBefore: null,
  };
  const empty = { items: [], nextBefore: null };
  const ids = (windowMs) =>
    mergeFeedPage(empty, page, 'replace', NOW, undefined, windowMs).items.map(
      (r) => r.id,
    );
  assert.deepEqual(ids(newsWindowMs(12)), ['fresh']);
  assert.deepEqual(ids(newsWindowMs(24)), ['fresh', 'old']);
});

test('the hotspots answer carries the window it was counted over', () => {
  const base = {
    hotspots: [],
    ingest: { lastRunAt: '2026-10-28T09:00:00Z' },
  };
  assert.equal(
    normalizeHotspotsPayload({ ...base, windowHours: 12 }).windowHours,
    12,
  );
  assert.equal(normalizeHotspotsPayload(base).windowHours, null);
  assert.equal(
    normalizeHotspotsPayload({ ...base, windowHours: 48 }).windowHours,
    null,
  );
  const shorter = normalizeHotspotsPayload({
    ...base,
    windowHours: 3,
    maxWindowHours: 12,
  });
  assert.deepEqual([shorter.windowHours, shorter.maxWindowHours], [3, 12]);
  assert.equal(normalizeHotspotsPayload(base).maxWindowHours, null);
});

test('the window choices stop at the window the server serves', () => {
  assert.deepEqual(newsWindowChoices(24), [24, 12, 6, 3, 1]);
  assert.deepEqual(newsWindowChoices(12), [12, 6, 3, 1]);
  assert.deepEqual(newsWindowChoices(8), [8, 6, 3, 1]);
  assert.deepEqual(newsWindowChoices(1), [1]);
  assert.deepEqual(newsWindowChoices(null), [24, 12, 6, 3, 1]);
});

test('a checked severity keeps saying who set it', () => {
  const page = normalizeFeedPayload({
    reports: ['label', 'model', 'guess'].map((by, i) => ({
      ...report(`r${i}`, '2026-10-28T09:00:00Z'),
      severity: 2,
      severityBy: by,
    })),
  });
  assert.deepEqual(
    page.reports.map((r) => r.severityBy),
    ['label', 'model', 'rules'],
  );
});
