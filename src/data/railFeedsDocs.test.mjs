// The rail registry's counts, and one DATA_SOURCES.md row per feed, none for a feed the registry does not hold.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  RAIL_ENABLED_FEEDS,
  RAIL_FEED_REGISTRY,
  railFeedNeedsSchedulePack,
  railFeedPositions,
} from './railFeeds.js';

const read = (file) =>
  readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');

const counts = {
  registry: RAIL_FEED_REGISTRY.length,
  gps: RAIL_FEED_REGISTRY.filter((feed) => railFeedPositions(feed) === 'gps')
    .length,
  stationReports: RAIL_FEED_REGISTRY.filter(
    (feed) => railFeedPositions(feed) === 'event',
  ).length,
  outOfTheBox: RAIL_ENABLED_FEEDS.filter(
    (feed) => !railFeedNeedsSchedulePack(feed),
  ).length,
  tripUpdates: RAIL_FEED_REGISTRY.filter(
    (feed) => typeof feed.tripUpdatesUrl === 'string',
  ).length,
  staticGtfs: RAIL_FEED_REGISTRY.filter(
    (feed) => typeof feed.staticGtfsUrl === 'string',
  ).length,
};

test('the rail registry holds the pinned feed counts', () => {
  assert.deepEqual(counts, {
    registry: 30,
    gps: 29,
    stationReports: 1,
    outOfTheBox: 28,
    tripUpdates: 22,
    staticGtfs: 29,
  });
  assert.equal(RAIL_ENABLED_FEEDS.length, counts.registry, 'all switched on');
  assert.deepEqual(
    RAIL_FEED_REGISTRY.filter(
      (feed) => railFeedPositions(feed) === 'event',
    ).map((feed) => feed.id),
    ['irish-rail'],
    'the station reports are Irish Rail’s',
  );
});

test('DATA_SOURCES.md has one row per rail feed', () => {
  const sources = read('DATA_SOURCES.md');
  const { registry } = counts;
  const rows = sources
    .split('\n')
    .filter((line) => /^\| \*\*.+\| Rail layer trains, /.test(line));
  assert.equal(rows.length, registry, 'one row per feed');
  for (const feed of RAIL_FEED_REGISTRY)
    assert.ok(
      rows.some((row) => row.includes(`| Rail layer trains, ${feed.region}:`)),
      `${feed.id} has a row`,
    );
});
