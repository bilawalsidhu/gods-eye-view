import { readFileSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TRANSIT_FEED_REGISTRY,
  TRANSIT_FEED_ID_PATTERN,
  getTransitFeed,
  publicTransitCatalog,
  transitFeedsInRange,
  transitModeFor,
} from './transitFeeds.js';
import { CATALOGUE_TRANSIT_FEED_ROWS } from './transitFeedsCatalogue.js';

test('every catalogue row becomes a live, keyless feed that covers its own centre', () => {
  const ids = new Set();
  for (const row of CATALOGUE_TRANSIT_FEED_ROWS) {
    assert.match(row.id, TRANSIT_FEED_ID_PATTERN);
    assert.equal(ids.has(row.id), false, `${row.id} is unique`);
    ids.add(row.id);
    const feed = getTransitFeed(row.id);
    assert.ok(feed, `${row.id} is routable`);
    assert.ok(
      publicTransitCatalog().some((entry) => entry.id === row.id),
      `${row.id} is offered to the browser`,
    );
    const url = new URL(row.url);
    assert.equal(url.protocol, 'https:');
    assert.equal(/key=/i.test(url.search), false, `${row.id} has no key`);
    assert.match(
      feed.terms.note,
      /\d+ vehicles on 2026-11-13\./,
      `${row.id} records the day it was seen live`,
    );
    assert.ok(
      transitFeedsInRange(row.center.lat, row.center.lon).some(
        (entry) => entry.id === row.id,
      ),
      `${row.id} covers its own centre`,
    );
  }
});

test('a catalogue row either quotes terms that were read or says no licence is stated', () => {
  let read = 0;
  for (const row of CATALOGUE_TRANSIT_FEED_ROWS) {
    if (row.license === 'No licence stated') {
      assert.equal(row.terms.quote, undefined, `${row.id} quotes nothing`);
      assert.match(
        row.terms.note,
        /Keyless feed on .+ with no licence stated\. Shipped on the same basis as Metro Transit and OVapi|Same server and basis/,
        `${row.id} names the basis it ships on`,
      );
      assert.match(
        row.licenseUrl,
        /^https:\/\/(mobilitydatabase\.org|www\.transit\.land|gtfsrt\.io)\//,
        `${row.id} links its catalogue record`,
      );
    } else {
      read++;
      assert.ok(row.terms.quote, `${row.id} quotes the grant`);
      assert.match(
        row.terms.note,
        /read 2026-11-13|same click-through agreement/,
        `${row.id} says when its terms were read`,
      );
    }
  }
  assert.equal(read, 10);
});

test('feeds whose terms forbid this use, or could not be read, are not registered', () => {
  const hosts = new Set(
    TRANSIT_FEED_REGISTRY.map((feed) => new URL(feed.url).hostname),
  );
  for (const host of [
    // Terms exclude keyless public display.
    'gtfsrt.prod.obanyc.com',
    'www.myddotbus.com',
    'everett.mapstrat.com',
    'duluthtransit.com',
    'ridetime.greaterdaytonrta.org',
    'cttprdtmgtfs.ctttrpcloud.com',
    'truetime.portauthority.org',
    // Terms could not be read.
    'gtfs.sofiatraffic.bg',
    'track.ua-gis.com',
    'www.ridedart.com',
    'ride.smtd.org',
    'knoxville.syncromatics.com',
    'bustracker.pvta.com',
    'bus.gocitybus.com',
    // A third party's republication.
    'proxy.busone.app',
  ]) {
    assert.equal(hosts.has(host), false, `${host} is not fetched`);
  }
});

test('licences that ask for specific credit get it', () => {
  const bilbao = getTransitFeed('metro-bilbao');
  assert.equal(bilbao.creditDated, true);
  assert.equal(transitModeFor(bilbao, null), 'subway');
  const fairfax = getTransitFeed('fairfax-connector');
  assert.match(fairfax.attribution, /Visit fairfaxconnector\.com/);
  assert.equal(fairfax.sourceUrl, 'https://www.fairfaxconnector.com');
  assert.match(getTransitFeed('gcrta-cleveland').attribution, /GCRTA/);
  assert.equal(transitModeFor(getTransitFeed('marc-train-md'), null), 'rail');
  assert.equal(transitModeFor(getTransitFeed('ny-waterway'), null), 'ferry');
});

test('every catalogue feed is documented with its licence', () => {
  const lines = readFileSync(
    new URL('../../DATA_SOURCES.md', import.meta.url),
    'utf8',
  ).split('\n');
  for (const row of CATALOGUE_TRANSIT_FEED_ROWS) {
    const line = lines.find((l) => l.startsWith(`| **${row.name}** `));
    assert.ok(line, `${row.name} has a DATA_SOURCES row`);
    assert.ok(line.includes(row.license), `${row.name} row names its licence`);
    assert.ok(
      line.includes(row.licenseUrl),
      `${row.name} row links its source`,
    );
  }
});
