// src/data/gtfsRtPolicy.test.mjs
// The GTFS-RT policy is the shared dev/prod contract (ADR 0003) for the
// transit-vehicle feeds: one feed registry, one service-area table, one
// cache-control value for BOTH runtimes. Pinned directly here the way
// gbfsPolicy.test.mjs pins the bikeshare contract.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  GTFSRT_MAX_BODY_BYTES,
  GTFSRT_PROXY_TIMEOUT_MS,
  GTFS_RT_CACHE_CONTROL,
  GTFS_RT_FEED_IDS,
  GTFS_RT_FEEDS,
  GTFS_RT_SERVICE_BBOXES,
  gtfsRtAnyFeedCoversRect,
  gtfsRtCacheControl,
  gtfsRtFeedCoversRect,
  isAllowedGtfsRtFeed,
} from './gtfsRtPolicy.js';

test('the feed registry is exactly the three keyless feeds, all HTTPS .pb', () => {
  assert.deepEqual(GTFS_RT_FEED_IDS, ['mbta', 'ovapi', 'metro-mn']);
  for (const [id, url] of Object.entries(GTFS_RT_FEEDS)) {
    assert.match(url, /^https:\/\//, `${id} must be HTTPS`);
    assert.match(url, /\.pb$/, `${id} must be a VehiclePositions protobuf feed`);
  }
});

test('feed lookup: known ids resolve, unknown/non-string ids return null (fail-closed)', () => {
  assert.equal(isAllowedGtfsRtFeed('mbta'), GTFS_RT_FEEDS.mbta);
  assert.equal(isAllowedGtfsRtFeed('metro-mn'), GTFS_RT_FEEDS['metro-mn']);
  assert.equal(isAllowedGtfsRtFeed('bogus'), null, 'unknown feed → null, not throw');
  assert.equal(isAllowedGtfsRtFeed('__proto__'), null, 'prototype keys are not feeds');
  assert.equal(isAllowedGtfsRtFeed(undefined), null);
  assert.equal(isAllowedGtfsRtFeed(42), null);
  assert.equal(isAllowedGtfsRtFeed(null), null);
});

test('every registered feed has a service-area box (the registry and map cannot drift)', () => {
  for (const id of GTFS_RT_FEED_IDS) {
    const box = GTFS_RT_SERVICE_BBOXES[id];
    assert.ok(box, `${id} is missing its service-area box`);
    assert.ok(box.south < box.north && box.west < box.east, `${id} box is pre-validated by construction`);
  }
});

test('feed cover: the host city rect is covered by its own feed', () => {
  // Boston downtown.
  assert.equal(gtfsRtFeedCoversRect('mbta', { south: 42.3, west: -71.1, north: 42.4, east: -71.0 }), true);
  // Utrecht, NL.
  assert.equal(gtfsRtFeedCoversRect('ovapi', { south: 52.0, west: 5.0, north: 52.1, east: 5.2 }), true);
  // Minneapolis.
  assert.equal(gtfsRtFeedCoversRect('metro-mn', { south: 44.95, west: -93.3, north: 45.05, east: -93.2 }), true);
});

test('feed cover: the wrong feed for the city is disjoint', () => {
  assert.equal(gtfsRtFeedCoversRect('mbta', { south: 52.0, west: 5.0, north: 52.1, east: 5.2 }), false,
    'Utrecht is not MBTA territory');
  assert.equal(gtfsRtFeedCoversRect('unknown-feed', { south: 42.3, west: -71.1, north: 42.4, east: -71.0 }), false,
    'unregistered feed has no box');
});

test('feed cover: touching edges intersect, never the empty set', () => {
  const box = GTFS_RT_SERVICE_BBOXES.mbta;
  // A rect whose east edge equals the box's west edge — the `<=` comparisons
  // deliberately treat edge-touching as NOT covered (zero-area intersection).
  assert.equal(gtfsRtFeedCoversRect('mbta', {
    south: box.south, west: box.west - 1, north: box.north, east: box.west,
  }), false, 'east == box.west is a zero-width overlap');
  assert.equal(gtfsRtFeedCoversRect('mbta', {
    south: box.south, west: box.west - 1, north: box.north, east: box.west + 0.5,
  }), true, 'one hair of overlap is covered — fringe slack is intentional');
});

test('feed cover: malformed rects fail closed', () => {
  const bad = [
    null,
    {},
    { south: 42, west: -71, north: Number.NaN, east: -70 },
    { south: 42, west: Number.POSITIVE_INFINITY, north: 43, east: -70 },
    { south: 43, west: -71, north: 42, east: -70 }, // inverted north/south
    { south: 42, west: -70, north: 43, east: -71 }, // inverted west/east
  ];
  for (const rect of bad) {
    assert.equal(gtfsRtFeedCoversRect('mbta', rect), false, `must reject: ${JSON.stringify(rect)}`);
  }
});

test('any-feed cover: Boston yes, mid-Atlantic no, malformed no', () => {
  assert.equal(gtfsRtAnyFeedCoversRect({ south: 42.3, west: -71.1, north: 42.4, east: -71.0 }), true);
  assert.equal(gtfsRtAnyFeedCoversRect({ south: 38.8, west: -74.1, north: 39.0, east: -73.9 }), false,
    'off the coast of New Jersey no feed is the real source');
  assert.equal(gtfsRtAnyFeedCoversRect(null), false);
});

test('relay limits and the cache header are exported for both runtimes', () => {
  assert.equal(GTFSRT_MAX_BODY_BYTES, 2 * 1024 * 1024);
  assert.equal(GTFSRT_PROXY_TIMEOUT_MS, 8000);
  assert.equal(gtfsRtCacheControl(), GTFS_RT_CACHE_CONTROL);
  assert.match(GTFS_RT_CACHE_CONTROL, /max-age=10/);
  assert.match(GTFS_RT_CACHE_CONTROL, /stale-while-revalidate=20/);
});
