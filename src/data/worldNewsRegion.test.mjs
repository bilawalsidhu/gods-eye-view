import assert from 'node:assert/strict';
import test from 'node:test';
import {
  NEWS_REGION_MAX_RADIUS_KM,
  describeNewsRegion,
  newsRegionQueryString,
  parseNewsRegionQuery,
  quantizeRegionPoint,
  resolveNewsRegion,
  snapRegionRadiusKm,
  viewRadiusKm,
  wrapLongitude,
} from './worldNewsRegion.js';

const rectAround = (lat, lon, halfDeg) => ({
  west: lon - halfDeg,
  east: lon + halfDeg,
  south: lat - halfDeg,
  north: lat + halfDeg,
});

test('radius snaps up to an accepted value, and refuses what the provider caps', () => {
  // The provider answers 400 above 100 km, so nothing may round past it.
  assert.equal(snapRegionRadiusKm(1), 25);
  assert.equal(snapRegionRadiusKm(25), 25);
  assert.equal(snapRegionRadiusKm(25.1), 50);
  assert.equal(snapRegionRadiusKm(100), 100);
  assert.equal(snapRegionRadiusKm(100.1), null);
  assert.equal(snapRegionRadiusKm(NEWS_REGION_MAX_RADIUS_KM + 1), null);
  assert.equal(snapRegionRadiusKm(0), null);
  assert.equal(snapRegionRadiusKm(-5), null);
  assert.equal(snapRegionRadiusKm(NaN), null);
});

test('a view wider than the provider cap is global, not a clamped circle', () => {
  // Clamping would silently fetch a circle that does not cover what the
  // operator is looking at, and cache it as if it did.
  assert.equal(resolveNewsRegion({ rect: rectAround(0, 0, 45) }).band, 'global');
  assert.equal(resolveNewsRegion({ rect: null }).band, 'global');
  assert.equal(resolveNewsRegion({ rect: undefined }).band, 'global');
  // A horizon gaze reports a near-hemispheric span.
  assert.equal(
    viewRadiusKm({ west: -170, east: 170, south: -80, north: 80 }),
    Number.POSITIVE_INFINITY,
  );
  assert.equal(resolveNewsRegion({ rect: { west: 1, east: 2 } }).band, 'global');
  assert.equal(resolveNewsRegion({ rect: rectAround(0, 0, 0) }).band, 'global');
});

test('a metro-scale view resolves to a local circle keyed by the grid', () => {
  // Half-diagonal at Moscow's latitude: 0.2 deg is ~25 km, so it snaps to 50.
  const region = resolveNewsRegion({
    rect: rectAround(55.7558, 37.6173, 0.2),
    language: 'en',
  });
  assert.equal(region.band, 'local');
  assert.equal(region.radiusKm, 50);
  // 55.7558 snaps to the NEAREST 0.5 gridline, which is 56.
  assert.deepEqual(region.center, { lat: 56, lon: 37.5 });
  assert.equal(region.key, 'l:en:56:37.5:50');

  // A tighter view takes the smallest circle the provider accepts.
  const close = resolveNewsRegion({ rect: rectAround(55.7558, 37.6173, 0.05) });
  assert.equal(close.radiusKm, 25);
  assert.equal(close.key, 'l:en:56:37.5:25');
});

test('the look-at point wins over the rectangle midpoint', () => {
  // At oblique pitch the rectangle spans toward the horizon, so its midpoint
  // is not what the operator is looking at.
  const rect = rectAround(50, 10, 0.2);
  const region = resolveNewsRegion({ rect, lookAt: { lat: 55.8, lon: 37.6 } });
  assert.deepEqual(region.center, { lat: 56, lon: 37.5 });
});

test('small pans reuse one key; crossing the grid makes a new one', () => {
  const key = (lat, lon) =>
    resolveNewsRegion({ rect: rectAround(lat, lon, 0.2) }).key;
  // Same grid cell -> same key, so panning does not buy a fresh page.
  assert.equal(key(55.7, 37.6), key(55.74, 37.62));
  assert.notEqual(key(55.7, 37.6), key(56.4, 37.6));
});

test('longitudes wrap so the dateline does not fork the key', () => {
  assert.equal(wrapLongitude(180), 180);
  assert.equal(wrapLongitude(-180), 180);
  assert.equal(wrapLongitude(190), -170);
  assert.equal(wrapLongitude(-190), 170);
  assert.equal(wrapLongitude(NaN), 0);
  assert.equal(quantizeRegionPoint(91, 400).lat, 90);
  assert.equal(Math.abs(quantizeRegionPoint(0, 179.9).lon) <= 180, true);
});

test('a malformed region is rejected, never quietly served as global news', () => {
  // The provider IGNORES unknown parameters and answers 200 with the whole
  // global feed, so a bad region must fail loudly instead of being cached
  // under a region key.
  const parse = (qs) => parseNewsRegionQuery(new URLSearchParams(qs));
  assert.deepEqual(parse(''), { ok: true, region: null });
  assert.equal(parse('region=view&lat=55&lon=37&radius=500').ok, false);
  assert.equal(parse('region=view&lat=55&lon=37&radius=0').ok, false);
  assert.equal(parse('region=view&lat=91&lon=37&radius=50').ok, false);
  assert.equal(parse('region=view&lat=55&lon=181&radius=50').ok, false);
  assert.equal(parse('region=view&lat=abc&lon=37&radius=50').ok, false);
  assert.equal(parse('region=view&lon=37&radius=50').ok, false);
  assert.equal(parse('region=elsewhere').ok, false);

  const good = parse('region=view&lat=55.7558&lon=37.6173&radius=50');
  assert.equal(good.ok, true);
  assert.equal(good.region.key, 'l:en:56:37.5:50');
  assert.equal(good.region.radiusKm, 50);
});

test('the query string round-trips to the same key the browser resolved', () => {
  const region = resolveNewsRegion({ rect: rectAround(-33.87, 151.21, 0.3) });
  const parsed = parseNewsRegionQuery(
    new URLSearchParams(newsRegionQueryString(region)),
  );
  assert.equal(parsed.ok, true);
  assert.equal(parsed.region.key, region.key);
  assert.equal(newsRegionQueryString(null), '');
  assert.match(describeNewsRegion(region), /^within \d+ km of /);
  assert.equal(describeNewsRegion(null), 'whole earth');
});
