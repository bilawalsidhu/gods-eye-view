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

test('Rainfolk hosting credit preserves USGWD original attribution, licence and adaptation notice', () => {
  const credit = DATA_CREDITS.find(
    (entry) => entry.key === 'rainfolk-groundwater',
  );
  assert.ok(credit);
  assert.match(credit.html, /Rainfolk.*preparation and hosting/);
  assert.match(credit.html, /USGWD.*Lin, Miller, Waqar and Marston/);
  assert.match(credit.html, /10\.4211/);
  assert.match(credit.html, /creativecommons\.org\/licenses\/by\/4\.0/);
  assert.match(
    credit.html,
    /normalized, datum-converted and spatially packaged/,
  );
  assert.match(credit.html, /State credits and supplied notices/);
  const notices = new URL(credit.html.match(/href="([^"]*Table_S2[^"]*)"/)[1]);
  assert.equal(notices.origin, 'https://www.hydroshare.org');
  assert.equal(notices.username, '');
  assert.equal(notices.search, '');
  assert.ok(
    notices.pathname.startsWith(
      '/resource/8b02895f02c14dd1a749bcc5584a5c55/data/contents/Metadata/',
    ),
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

test('the always-on rail credit names live feeds only, never timetables', () => {
  // Every train shown is where its operator reported it; none is placed
  // from a timetable.
  const rail = DATA_CREDITS.find((entry) => entry.key === 'rail-gtfs-rt');
  assert.ok(rail);
  assert.match(rail.html, /realtime feeds/);
  assert.doesNotMatch(rail.html, /timetable|placed from/i);
});
