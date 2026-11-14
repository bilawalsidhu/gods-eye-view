// Asian feeds: Japan's live tram feeds (Manyōsen and Toyama), registered,
// switched on with their licence basis recorded, and sorted into
// categories.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RAIL_ENABLED_FEEDS,
  classifyTrain,
  getRailFeed,
  getRegisteredRailFeed,
  railFeedPositions,
  railFeedsInRange,
} from './railFeeds.js';

const LIVE = ['jp-manyosen', 'jp-toyama-tram'];

const feed = (id) => getRegisteredRailFeed(id);
const kind = (id, routeId) => classifyTrain(feed(id), routeId);

const TRAM = { category: 'transit', mode: 'tram' };

test('the Japanese feeds are on, with their licence basis recorded', () => {
  for (const id of LIVE) {
    assert.ok(getRailFeed(id), `${id} is pollable`);
    assert.ok(RAIL_ENABLED_FEEDS.includes(feed(id)), id);
    assert.ok(feed(id).license, id);
    assert.match(feed(id).licenseUrl, /^https:\/\//, id);
    assert.ok(feed(id).attribution, id);
    assert.ok(feed(id).terms.quote, `${id} quotes its terms`);
    assert.match(feed(id).terms.note, /read 2026-11-10/, id);
    assert.doesNotMatch(feed(id).terms.note, /@/, id);
    assert.equal(railFeedPositions(feed(id)), 'gps', id);
    assert.match(feed(id).url, /^https:\/\/gtfs-rt-files\.buscatch\.jp\//);
  }
  assert.equal(
    feed('jp-toyama-tram').staticGtfsUrl,
    undefined,
    'its static GTFS codes the tram as buses',
  );
});

test('Japan: the Manyōsen and Toyama trams are transit', () => {
  assert.deepEqual(kind('jp-manyosen', '1'), TRAM);
  assert.deepEqual(
    kind('jp-toyama-tram', '富山港線（南富山）(3004-1)'),
    TRAM,
    'a route id seen live',
  );
});

test('each Japanese tram feed is polled around its own city only', () => {
  const near = (lat, lon) => railFeedsInRange(lat, lon).map((f) => f.id);
  // Takaoka for the Manyōsen, Toyama station for the city tram.
  assert.ok(near(36.75, 137.02).includes('jp-manyosen'));
  assert.ok(near(36.7, 137.21).includes('jp-toyama-tram'));
  // Tokyo and Nagoya are hundreds of kilometres off.
  for (const [lat, lon] of [
    [35.68, 139.77],
    [35.17, 136.88],
  ])
    for (const id of LIVE) assert.ok(!near(lat, lon).includes(id), id);
  for (const id of LIVE) assert.ok(feed(id).loadRadiusKm <= 25, id);
});
