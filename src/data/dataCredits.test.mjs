import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DATA_CREDITS,
  LIVEUAMAP_CREDIT,
  NYC_DOT_DISCLAIMER,
  transitFeedCredit,
} from './dataCredits.js';
import { getTransitFeed } from './transitFeeds.js';
import { bindFakeCesiumCredits } from '../testSupport/fakeCreditsPort.mjs';

test('every credit carries a unique key and some markup to render', () => {
  const keys = DATA_CREDITS.map((entry) => entry.key);
  assert.equal(
    new Set(keys).size,
    keys.length,
    'a duplicate key would silently shadow one provider’s credit',
  );
  for (const entry of DATA_CREDITS) {
    assert.ok(entry.key, 'a credit without a key cannot be registered');
    assert.ok(
      entry.html && entry.html.trim().length > 0,
      `credit ${entry.key} has nothing to show`,
    );
  }
});

test('adsbdb is credited and carries its published route-data restriction', () => {
  const credit = DATA_CREDITS.find((entry) => entry.key === 'adsbdb');
  assert.ok(
    credit,
    'adsbdb supplies aircraft type and routes and must be credited',
  );
  // adsbdb publishes this restriction for its route data. Pin the provider's
  // credits and restriction here so a later edit cannot silently remove them.
  assert.match(credit.html, /David Taylor, Edinburgh/);
  assert.match(credit.html, /Jim Mason, Glasgow/);
  assert.match(
    credit.html,
    /may not be\s+copied, published, or incorporated into other databases/,
  );
  assert.match(credit.html, /explicit permission of David J Taylor, Edinburgh/);
  assert.match(credit.html, /PlaneBase/);
  assert.match(credit.html, /Guillaume Michel/);
  assert.match(credit.html, /href="https:\/\/www\.adsbdb\.com"/);
});

test('Planespotters is credited with a plain followable link', () => {
  const credit = DATA_CREDITS.find((entry) => entry.key === 'planespotters');
  assert.ok(credit, 'the tracked aircraft photos come from Planespotters');
  assert.match(credit.html, /href="https:\/\/www\.planespotters\.net"/);
  assert.doesNotMatch(credit.html, /nofollow/);
});

test('Open Vessel Photos is credited with a plain followable link', () => {
  const credit = DATA_CREDITS.find((entry) => entry.key === 'openvesselphotos');
  assert.ok(credit, 'the selected vessel photos come from Open Vessel Photos');
  assert.match(credit.html, /href="https:\/\/openvesselphotos\.org"/);
  assert.doesNotMatch(credit.html, /nofollow/);
});

test('the UCS Satellite Database is acknowledged with its version and webpage', () => {
  // UCS database manual, section 3: references name the version (the Excel
  // file's name) and link www.ucsusa.org/satellite_database.
  const credit = DATA_CREDITS.find(
    (entry) => entry.key === 'ucs-satellite-database',
  );
  assert.ok(credit, 'the satellite classes and operators come from UCS');
  assert.match(credit.html, /UCS-Satellite-Database 5-1-2023/);
  assert.match(
    credit.html,
    /href="https:\/\/www\.ucsusa\.org\/satellite_database"/,
  );
});

test('the imaging sensor swaths credit operator and agency specifications', () => {
  // Each sensor-pack entry cites its operator's or agency's own pages;
  // no aggregator database is credited.
  const credit = DATA_CREDITS.find((entry) => entry.key === 'imaging-sensors');
  assert.ok(credit, 'the orbital zoom caps come from the sensor pack');
  assert.match(credit.html, /operator and agency specifications/);
  assert.doesNotMatch(credit.html, /OSCAR|wmo\.int/);
});

test('OpenStreetMap has one generic data credit with separate tile and names distributors', () => {
  const osm = DATA_CREDITS.filter((entry) =>
    entry.html.includes('openstreetmap.org/copyright'),
  );
  assert.equal(osm.length, 1);
  assert.equal(osm[0].key, 'openstreetmap');
  assert.match(osm[0].html, /Map and place data/);
  assert.match(osm[0].html, /© OpenStreetMap contributors/);
  assert.match(
    DATA_CREDITS.find((entry) => entry.key === 'openfreemap').html,
    /Vector tiles:/,
  );
  assert.match(
    DATA_CREDITS.find((entry) => entry.key === 'overture-military-names').html,
    /Overture Maps Foundation/,
  );
});

test('inline OSM attribution persists until its last display owner leaves', async (t) => {
  const { showOsmCredit, hideOsmCredit } = await import('./dataCredits.js');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const visible = new Set();
  const viewer = bindFakeCesiumCredits({
    creditDisplay: {
      addStaticCredit: (c) => visible.add(c),
      removeStaticCredit: (c) => visible.delete(c),
    },
    scene: { requestRender() {} },
  });
  assert.equal(showOsmCredit(viewer, 'alpr'), true);
  assert.equal(showOsmCredit(viewer, 'alpr'), false);
  assert.equal(visible.size, 1);
  assert.match(
    [...visible][0].html,
    /href="https:\/\/www.openstreetmap.org\/copyright"/,
  );
  assert.match([...visible][0].html, />© OpenStreetMap</);
  assert.ok([...visible][0].showOnScreen);
  t.mock.timers.tick(60000);
  assert.equal(visible.size, 1);
  showOsmCredit(viewer, 'traffic', { openMapTiles: true });
  assert.equal(visible.size, 2);
  hideOsmCredit(viewer, 'alpr');
  assert.equal(visible.size, 2, 'traffic still owns both credits');
  showOsmCredit(viewer, 'datacenters');
  hideOsmCredit(viewer, 'traffic');
  assert.equal(
    visible.size,
    1,
    'bundled data does not retain the tile distributor',
  );
  hideOsmCredit(viewer, 'datacenters');
  assert.equal(visible.size, 0);
  assert.equal(hideOsmCredit(viewer, 'datacenters'), false);
  showOsmCredit(viewer, 'alpr');
  assert.equal(visible.size, 1, 'reenabling restores the short credit');
});

test('tile attribution follows source changes and viewers have independent ownership', async () => {
  const { showOsmCredit, hideOsmCredit } = await import('./dataCredits.js');
  const create = () => {
    const credits = new Set();
    return bindFakeCesiumCredits({
      credits,
      creditDisplay: {
        addStaticCredit: (c) => credits.add(c),
        removeStaticCredit: (c) => credits.delete(c),
      },
    });
  };
  const a = create(),
    b = create();
  showOsmCredit(a, 'installations', { openMapTiles: true });
  showOsmCredit(b, 'installations');
  assert.equal(a.credits.size, 2);
  assert.equal(b.credits.size, 1);
  showOsmCredit(a, 'installations');
  assert.equal(a.credits.size, 1, 'wide names no longer use tiles');
  hideOsmCredit(a, 'installations');
  assert.equal(a.credits.size, 0);
  assert.equal(b.credits.size, 1);
});

test('the NYC camera credit carries NYC DOT’s requested disclaimer', () => {
  const credit = DATA_CREDITS.find((entry) => entry.key === 'nyc-cctv');
  assert.ok(credit, 'NYC DOT camera frames must be credited');
  assert.ok(credit.html.includes(NYC_DOT_DISCLAIMER));
  assert.match(credit.html, /make no representation as to the accuracy/);
  assert.match(credit.html, /observe posted signage/);
});

test("the Houston camera credit names TranStar's terms and the permission they require", () => {
  const credit = DATA_CREDITS.find((entry) => entry.key === 'houston-cctv');
  assert.ok(credit, 'Houston TranStar camera frames must be credited');
  assert.match(credit.html, /\(Houston, when enabled\)/);
  assert.ok(
    credit.html.includes(
      'href="https://traffic.houstontranstar.org/disclaimer.aspx"',
    ),
  );
  assert.match(credit.html, /TxDOT's written permission/);
});

test('the Bucharest webcam credit is conditional and names the rights holders', () => {
  const credit = DATA_CREDITS.find((entry) => entry.key === 'bucharest-cctv');
  assert.ok(credit, 'Bucharest webcam streams must be credited');
  assert.match(credit.html, /\(Bucharest area, when enabled\)/);
  assert.ok(
    credit.html.includes(
      'href="https://webcamromania.ro/termeni-si-conditii/"',
    ),
  );
  assert.ok(
    credit.html.includes('href="https://www.notar-radufelix.ro/live-webcam"'),
  );
  assert.match(credit.html, /rights remain with the camera operators/);
});

test('every Street Level imagery source is in the attribution lightbox', () => {
  for (const key of [
    'mapillary',
    'google-street-view',
    'kartaview',
    'panoramax',
  ])
    assert.ok(
      DATA_CREDITS.some((entry) => entry.key === key),
      `${key} has no credit`,
    );
});

test('a credit with several links becomes one credit per link, in order', async () => {
  const {
    creditsFromMarkup,
    OSM_CREDIT,
    OPENMAPTILES_CREDIT,
    WOF_CREDIT,
    BHOTE_KOSHI_CREDIT,
  } = await import('./dataCredits.js');
  const html = (key) => DATA_CREDITS.find((entry) => entry.key === key).html;
  const read = (markup) =>
    creditsFromMarkup(markup).map(({ text, href }) => [text, href]);
  assert.deepEqual(read(OSM_CREDIT.html), [
    [
      'Map and place data © OpenStreetMap contributors',
      'https://www.openstreetmap.org/copyright',
    ],
    ['(ODbL)', 'https://opendatacommons.org/licenses/odbl/1-0/'],
  ]);
  assert.deepEqual(read(OPENMAPTILES_CREDIT.html), [
    ['Vector tiles: OpenFreeMap', 'https://openfreemap.org'],
    ['© OpenMapTiles', 'https://openmaptiles.org'],
  ]);
  assert.deepEqual(read(html('nasa-gibs'))[1], [
    'HLS product page',
    'https://lpdaac.usgs.gov/products/hlss30v002/',
  ]);
  assert.deepEqual(read(html('wfigs')), [
    [
      'Wildfire perimeters: National Interagency Fire Center (WFIGS)',
      'https://data-nifc.opendata.arcgis.com/',
    ],
    ['Incident information: InciWeb', 'https://inciweb.wildfire.gov/'],
  ]);
  assert.deepEqual(read(html('eccc-aqhi')), [
    [
      'Air quality (AQHI): Environment and Climate Change Canada — MSC GeoMet (eccc-msc.github.io/open-data)',
      'https://eccc-msc.github.io/open-data/',
    ],
    [
      'ECCC Data Servers End-use Licence',
      'https://eccc-msc.github.io/open-data/licence/readme_en/',
    ],
  ]);
  assert.deepEqual(
    read(BHOTE_KOSHI_CREDIT.html)[1][0].slice(0, 15),
    'and GeoPera (CC',
  );
  assert.deepEqual(
    read(WOF_CREDIT.html).map(([text]) => text),
    [
      "Neighborhood boundaries: Who's On First and contributors, simplified",
      '(sources and licences)',
    ],
  );
  const link = (text) => `<a href="https://example.org">${text}</a>`;
  assert.deepEqual(
    read(`${link('A')} by Hoffleit &amp; Warren ${link('B')}`).map(
      ([text]) => text,
    ),
    ['A', 'by Hoffleit & Warren B'],
    'a character reference is not a separator',
  );
  assert.deepEqual(read(html('usgs')), [
    ['Earthquakes: Data courtesy of the U.S. Geological Survey', undefined],
  ]);
  for (const entry of DATA_CREDITS) {
    const credits = creditsFromMarkup(entry.html);
    const links = entry.html.match(/<a\b/g)?.length ?? 0;
    assert.equal(credits.length, Math.max(links, 1), entry.key);
    assert.ok(
      credits.every((credit) => credit.inline === false),
      `${entry.key} belongs in the attribution list`,
    );
  }
});

test('data credits go through the renderer to the attribution list', async () => {
  const { registerDataCredits, registerDynamicCredit, TOMTOM_CREDIT } =
    await import('./dataCredits.js');
  const shown = [];
  const viewer = bindFakeCesiumCredits({
    creditDisplay: {
      addStaticCredit: (c) => shown.push(c),
      removeStaticCredit() {},
    },
  });
  const credits = DATA_CREDITS.filter((entry) =>
    ['openstreetmap', 'usgs'].includes(entry.key),
  );
  registerDataCredits(viewer, credits);
  assert.equal(shown.length, 3);
  assert.ok(shown.every((credit) => !credit.showOnScreen));
  const odbl = shown.find((credit) => credit.html.includes('opendatacommons'));
  assert.match(odbl.html, /href="https:\/\/opendatacommons.org/);
  // As the source wrote it: only the licence's name is the link.
  assert.match(odbl.html, /\(<a [^>]*>ODbL<\/a>\)/);
  assert.equal(registerDynamicCredit(viewer, TOMTOM_CREDIT), true);
  assert.equal(registerDynamicCredit(viewer, TOMTOM_CREDIT), true);
  assert.equal(shown.length, 4, 'a dynamic credit is added once');
  assert.match(shown[3].html, /Traffic flow data © <a [^>]*>TomTom<\/a>/);
  assert.equal(registerDynamicCredit({}, { key: 'none', html: 'x' }), false);
});

test('the News layer credits its built-in sources', () => {
  const credit = (key) => DATA_CREDITS.find((entry) => entry.key === key);
  // GDELT's terms ask for a citation and a link.
  assert.match(
    credit('gdelt-news').html,
    /href="https:\/\/www\.gdeltproject\.org\/"[^>]*>GDELT Project</,
  );
  // World News API's free plan asks for this exact link.
  assert.match(
    credit('worldnewsapi').html,
    /<a href="https:\/\/worldnewsapi\.com\/"[^>]*>World News API<\/a>/,
  );
  assert.match(LIVEUAMAP_CREDIT.html, />Liveuamap</);
  assert.ok(
    !DATA_CREDITS.some((entry) => entry.key === LIVEUAMAP_CREDIT.key),
    'Liveuamap is credited only once its key is in use',
  );
  assert.doesNotMatch(credit('news').html, /No single provider/);
});

test('the PR #1506 camera packs are credited with their sources and terms', () => {
  const html = (key) => DATA_CREDITS.find((entry) => entry.key === key)?.html;
  assert.match(html('ottawa-cctv') || '', /traffic\.ottawa\.ca/);
  assert.match(html('quebec-cctv') || '', /CC BY 4\.0/);
  assert.match(html('quebec-cctv') || '', /OpenStreetMap contributors/);
  assert.match(html('tripcheck-cctv') || '', /courtesy of ODOT/);
  // MLIT's terms ask for the source in this form, with the page link.
  assert.match(html('mlit-river-cctv') || '', /出典：国土交通省/);
  assert.match(
    html('mlit-river-cctv') || '',
    /href="https:\/\/www\.river\.go\.jp\//,
  );
});

test('Warsaw and Poznań credits carry the data date their licences ask for', () => {
  const warsaw = getTransitFeed('ztm-warszawa');
  // 2026-11-09T06:00:00Z as a GTFS-RT header timestamp (seconds).
  const credit = transitFeedCredit(warsaw, { feedTimestamp: 1_794_204_000 });
  assert.match(credit.html, /, data of 2026-11-09\)/);
  assert.match(credit.html, /href="http:\/\/api\.um\.warszawa\.pl"/);
  assert.equal(credit.key, 'transit-ztm-warszawa-2026-11-09');
  // Without a feed timestamp the fetch time is the download date.
  const poznan = transitFeedCredit(getTransitFeed('ztm-poznan'), {
    feedTimestamp: null,
    fetchedAt: Date.UTC(2026, 10, 10, 12),
  });
  assert.match(poznan.html, /data of 2026-11-10/);
  // Undated feeds keep one credit line for the session.
  const mbta = transitFeedCredit(getTransitFeed('mbta'), {
    feedTimestamp: 1_794_204_000,
  });
  assert.equal(mbta.key, 'transit-mbta');
  assert.doesNotMatch(mbta.html, /data of/);
});

test('the always-on rail credit names live feeds only, never timetables', () => {
  // Every train shown is where its operator reported it; none is placed
  // from a timetable.
  const rail = DATA_CREDITS.find((entry) => entry.key === 'rail-gtfs-rt');
  assert.ok(rail);
  assert.match(rail.html, /realtime feeds/);
  assert.doesNotMatch(rail.html, /timetable|placed from/i);
});
