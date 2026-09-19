// vite/proxies/gtfsrt.test.mjs
//
// Pins the dev proxy contract. The byte-exact checks guard against the
// URL-builder drift test (`src/config/apiEndpoints.test.mjs`) catching a
// regression here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  GTFS_RT_FEEDS,
  GTFSRT_MAX_BODY_BYTES,
  GTFSRT_PROXY_TIMEOUT_MS,
  GTFS_RT_CACHE_CONTROL,
  isAllowedGtfsRtFeed,
  gtfsRtCacheControl,
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
