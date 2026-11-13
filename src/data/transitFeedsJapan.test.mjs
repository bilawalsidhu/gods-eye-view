import { readFileSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TRANSIT_FEED_ID_PATTERN,
  getTransitFeed,
  publicTransitCatalog,
  transitFeedsInRange,
} from './transitFeeds.js';
import { JAPAN_TRANSIT_FEED_ROWS } from './transitFeedsJapan.js';

test('every Japanese row is a live, keyless feed under CC0 or CC BY', () => {
  const ids = new Set();
  for (const row of JAPAN_TRANSIT_FEED_ROWS) {
    assert.match(row.id, TRANSIT_FEED_ID_PATTERN);
    assert.equal(ids.has(row.id), false, `${row.id} is unique`);
    ids.add(row.id);
    assert.ok(getTransitFeed(row.id), `${row.id} is routable`);
    assert.ok(
      publicTransitCatalog().some((entry) => entry.id === row.id),
      `${row.id} is offered to the browser`,
    );
    assert.ok(['CC0 1.0', 'CC BY 4.0'].includes(row.license));
    assert.match(
      row.licenseUrl,
      /^https:\/\/mobilitydatabase\.org\/feeds\/gtfs_rt\//,
      `${row.id} links its catalogue record`,
    );
    assert.match(
      row.terms.quote,
      row.license === 'CC0 1.0'
        ? /creativecommons\.org\/publicdomain\/zero\/1\.0/
        : /creativecommons\.org\/licenses\/by\/4\.0/,
      `${row.id} quotes the licence it names`,
    );
    assert.match(
      row.terms.note,
      /Vehicle positions were seen on|its positions have not been seen yet/,
      `${row.id} says whether positions were seen`,
    );
    assert.equal(new URL(row.url).protocol, 'https:');
    assert.ok(
      // Japan, Hokkaidō to Okinawa.
      row.center.lat > 24 &&
        row.center.lat < 46 &&
        row.center.lon > 122 &&
        row.center.lon < 146,
      `${row.id} is centred in Japan`,
    );
    assert.ok(
      transitFeedsInRange(row.center.lat, row.center.lon).some(
        (entry) => entry.id === row.id,
      ),
      `${row.id} covers its own centre`,
    );
  }
});

test('every Japanese feed is documented with its licence', () => {
  const lines = readFileSync(
    new URL('../../DATA_SOURCES.md', import.meta.url),
    'utf8',
  ).split('\n');
  for (const row of JAPAN_TRANSIT_FEED_ROWS) {
    const line = lines.find((l) => l.startsWith(`| **${row.name}** `));
    assert.ok(line, `${row.name} has a DATA_SOURCES row`);
    assert.ok(line.includes(row.license) && line.includes(row.licenseUrl));
  }
});
