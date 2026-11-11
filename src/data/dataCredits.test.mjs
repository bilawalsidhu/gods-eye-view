import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DATA_CREDITS,
  LIVEUAMAP_CREDIT,
  NYC_DOT_DISCLAIMER,
  transitFeedCredit,
} from './dataCredits.js';
import { getTransitFeed } from './transitFeeds.js';

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
  const viewer = {
    creditDisplay: {
      addStaticCredit: (c) => visible.add(c),
      removeStaticCredit: (c) => visible.delete(c),
    },
    scene: { requestRender() {} },
  };
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
    return {
      credits,
      creditDisplay: {
        addStaticCredit: (c) => credits.add(c),
        removeStaticCredit: (c) => credits.delete(c),
      },
    };
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
