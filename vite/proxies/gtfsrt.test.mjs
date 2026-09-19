// vite/proxies/gtfsrt.test.mjs
//
// Pins the dev proxy contract. The byte-exact checks guard against the
// URL-builder drift test (`src/config/apiEndpoints.test.mjs`) catching a
// regression here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  GTFS_RT_FEEDS,
  GTFS_RT_SERVICE_BBOXES,
  GTFS_RT_FEED_IDS,
  GTFSRT_MAX_BODY_BYTES,
  GTFSRT_PROXY_TIMEOUT_MS,
  GTFS_RT_CACHE_CONTROL,
  isAllowedGtfsRtFeed,
  gtfsRtCacheControl,
  gtfsRtFeedCoversRect,
  gtfsRtAnyFeedCoversRect,
} from '../../src/data/gtfsRtPolicy.js';

test('gtfsRtPolicy: registry exposes all expected feeds with HTTPS VehiclePositions.pb URLs', () => {
  assert.ok(Object.keys(GTFS_RT_FEEDS).length >= 1, 'at least one feed is required');
  for (const [id, url] of Object.entries(GTFS_RT_FEEDS)) {
    assert.match(url, /^https:\/\//, `${id} upstream must be HTTPS`);
    assert.match(url, /vehiclepositions\.pb(\?|$)/i, `${id} upstream must point at a VehiclePositions.pb endpoint`);
  }
});

test('gtfsRtPolicy: isAllowedGtfsRtFeed returns the URL for known feeds, null otherwise', () => {
  for (const [id, url] of Object.entries(GTFS_RT_FEEDS)) {
    assert.equal(isAllowedGtfsRtFeed(id), url, `known feed ${id} resolves to its upstream URL`);
  }
  assert.equal(isAllowedGtfsRtFeed('not-a-real-feed'), null);
  assert.equal(isAllowedGtfsRtFeed(''), null);
  assert.equal(isAllowedGtfsRtFeed(undefined), null);
  assert.equal(isAllowedGtfsRtFeed(123), null);
});

test('gtfsRtPolicy: cache header is short TTL + stale-while-revalidate (transit vehicles need motion smoothness)', () => {
  const header = gtfsRtCacheControl();
  assert.equal(header, GTFS_RT_CACHE_CONTROL);
  assert.match(header, /max-age=10/);
  assert.match(header, /stale-while-revalidate/);
});

test('gtfsRtPolicy: body cap is far above any realistic GTFS-RT feed', () => {
  // MBTA peak (rush hour) is ~80 KB; 2 MB is 25× that.
  assert.ok(GTFSRT_MAX_BODY_BYTES >= 2 * 1024 * 1024, 'cap is ≥ 2 MB');
  assert.ok(GTFSRT_PROXY_TIMEOUT_MS >= 5_000 && GTFSRT_PROXY_TIMEOUT_MS <= 30_000,
    'timeout is in the safe 5–30s window');
});

test('gtfsRtPolicy: every registered feed has a service-area bbox (no silent gaps in fallback gating)', () => {
  for (const id of GTFS_RT_FEED_IDS) {
    const box = GTFS_RT_SERVICE_BBOXES[id];
    assert.ok(box, `service bbox registered for ${id}`);
    assert.ok(box.south < box.north, `${id} bbox south<north`);
    assert.ok(box.west < box.east, `${id} bbox west<east`);
  }
});

test('gtfsRtPolicy: gtfsRtFeedCoversRect — rect inside service box returns true', () => {
  // Inside MBTA's box (Boston downtown area).
  const insideBoston = { south: 42.30, west: -71.10, north: 42.40, east: -71.00 };
  assert.equal(gtfsRtFeedCoversRect('mbta', insideBoston), true);
  // OVapi covers the Netherlands; Amsterdam is inside.
  const insideAmsterdam = { south: 52.30, west:  4.80, north: 52.45, east:  4.95 };
  assert.equal(gtfsRtFeedCoversRect('ovapi', insideAmsterdam), true);
  // MetroMN covers the Twin Cities; Minneapolis is inside.
  const insideMinneapolis = { south: 44.90, west: -93.30, north: 45.00, east: -93.20 };
  assert.equal(gtfsRtFeedCoversRect('metro-mn', insideMinneapolis), true);
});

test('gtfsRtPolicy: gtfsRtFeedCoversRect — disjoint rect returns false', () => {
  // Sydney is nowhere near any registered feed.
  const sydney = { south: -34.0, west: 150.5, north: -33.5, east: 151.5 };
  for (const id of GTFS_RT_FEED_IDS) {
    assert.equal(gtfsRtFeedCoversRect(id, sydney), false, `${id} must not claim Sydney`);
  }
});

test('gtfsRtPolicy: gtfsRtFeedCoversRect — partial overlap (edge of service area) is still covered', () => {
  // A rect straddling MBTA's eastern edge still intersects the service box.
  const partialBoston = { south: 42.60, west: -70.65, north: 42.80, east: -70.50 };
  assert.equal(gtfsRtFeedCoversRect('mbta', partialBoston), true);
});

test('gtfsRtPolicy: MBTA bbox covers Worcester (commuter-rail reach, audit 2026-09-18)', () => {
  // The original box stopped at west=-71.7, so a Worcester viewport reported
  // "no feed covers" and spawned synthetic cars on top of real MBTA
  // Framingham/Worcester-line vehicles.
  const worcester = { south: 42.20, west: -72.05, north: 42.35, east: -71.75 };
  assert.equal(gtfsRtFeedCoversRect('mbta', worcester), true);
  assert.equal(gtfsRtAnyFeedCoversRect(worcester), true);
});

test('gtfsRtPolicy: gtfsRtFeedCoversRect — unknown feed id returns false (never throws)', () => {
  assert.equal(gtfsRtFeedCoversRect('not-a-real-feed', { south: 0, west: 0, north: 1, east: 1 }), false);
});

test('gtfsRtPolicy: gtfsRtFeedCoversRect — malformed rect returns false', () => {
  const malformed = { south: 5, west: 5, north: 1, east: 1 }; // south>=north, west>=east
  assert.equal(gtfsRtFeedCoversRect('mbta', malformed), false);
  assert.equal(gtfsRtFeedCoversRect('mbta', null), false);
  assert.equal(gtfsRtFeedCoversRect('mbta', { south: Number.NaN, west: 0, north: 1, east: 1 }), false);
});

test('gtfsRtPolicy: gtfsRtAnyFeedCoversRect — true iff at least one feed covers', () => {
  // Boston → MBTA covers → synthetics OFF
  assert.equal(gtfsRtAnyFeedCoversRect({ south: 42.30, west: -71.10, north: 42.40, east: -71.00 }), true);
  // Sydney → no feed covers → synthetics ON
  assert.equal(gtfsRtAnyFeedCoversRect({ south: -34.0, west: 150.5, north: -33.5, east: 151.5 }), false);
  assert.equal(gtfsRtAnyFeedCoversRect(null), false);
});
