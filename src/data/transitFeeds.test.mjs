import { readFileSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TRANSIT_ENABLED_FEEDS,
  TRANSIT_FEED_REGISTRY,
  TRANSIT_FEED_ID_PATTERN,
  TRANSIT_MODES,
  getRegisteredTransitFeed,
  getTransitFeed,
  haversineKm,
  publicTransitCatalog,
  transitFeedsInRange,
  transitModeFor,
  transitModeResolved,
} from './transitFeeds.js';

test('every registered feed is keyless, https, licensed, and uniquely identified', () => {
  const ids = new Set();
  for (const feed of TRANSIT_FEED_REGISTRY) {
    assert.match(
      feed.id,
      TRANSIT_FEED_ID_PATTERN,
      `${feed.id} is a valid path segment`,
    );
    assert.equal(ids.has(feed.id), false, `${feed.id} is unique`);
    ids.add(feed.id);
    const url = new URL(feed.url);
    assert.equal(url.protocol, 'https:', `${feed.id} fetches over https`);
    assert.equal(
      url.search.includes('key='),
      false,
      `${feed.id} carries no key in its URL`,
    );
    assert.ok(
      feed.license && feed.licenseUrl && feed.attribution,
      `${feed.id} names its license`,
    );
    assert.ok(
      feed.loadRadiusKm > 0 && feed.loadRadiusKm <= 1000,
      `${feed.id} radius is sane`,
    );
    assert.ok(
      Math.abs(feed.center.lat) <= 90 && Math.abs(feed.center.lon) <= 180,
    );
    assert.ok(
      TRANSIT_MODES.includes(feed.defaultMode),
      `${feed.id} default mode is known`,
    );
    assert.ok(Object.isFrozen(feed), `${feed.id} is immutable`);
  }
});

test('getTransitFeed is the only door to an upstream URL and refuses anything unregistered', () => {
  assert.equal(
    getTransitFeed('mbta')?.url,
    'https://cdn.mbta.com/realtime/VehiclePositions.pb',
  );
  assert.equal(getTransitFeed('MBTA'), null);
  assert.equal(getTransitFeed('../etc/passwd'), null);
  assert.equal(getTransitFeed('https://evil.example'), null);
  assert.equal(getTransitFeed(''), null);
  assert.equal(getTransitFeed(null), null);
  assert.equal(getTransitFeed(42), null);
});

test('haversine matches known city distances', () => {
  const bostonToNyc = haversineKm(42.3601, -71.0589, 40.7128, -74.006);
  assert.ok(
    Math.abs(bostonToNyc - 306) < 5,
    `Boston–NYC ≈ 306 km, got ${bostonToNyc}`,
  );
  assert.equal(haversineKm(0, 0, 0, 0), 0);
});

test('feeds in range are nearest-first and honor slack as hysteresis', () => {
  // Camera over Cambridge, MA → MBTA only.
  const boston = transitFeedsInRange(42.37, -71.11);
  assert.deepEqual(
    boston.map((f) => f.id),
    ['mbta'],
  );
  // Mid-Atlantic: nothing.
  assert.deepEqual(transitFeedsInRange(40, -40), []);
  // Just outside MBTA's 70 km circle (≈ 80 km south) — out without slack, in with 20 km slack.
  const farLat = 42.3601 - 80 / 111;
  assert.deepEqual(transitFeedsInRange(farLat, -71.0589), []);
  assert.deepEqual(
    transitFeedsInRange(farLat, -71.0589, 20).map((f) => f.id),
    ['mbta'],
  );
  // Bad input never throws.
  assert.deepEqual(transitFeedsInRange(NaN, 1), []);
  // A national feed covers its own cities and not the neighbour's capital.
  for (const [city, lat, lon] of [
    ['Oslo', 59.91, 10.75],
    ['Bergen', 60.39, 5.32],
    ['Tromsø', 69.65, 18.96],
  ]) {
    assert.ok(
      transitFeedsInRange(lat, lon).some((f) => f.id === 'entur-norway'),
      `${city} is covered by Entur`,
    );
  }
  assert.deepEqual(
    transitFeedsInRange(60.17, 24.94).map((f) => f.id),
    ['hsl-helsinki'],
    'Helsinki polls HSL only',
  );
});

test('route hints refine a feed default and never escape the known modes', () => {
  const mbta = getTransitFeed('mbta');
  assert.equal(transitModeFor(mbta, 'Red'), 'subway');
  assert.equal(transitModeFor(mbta, 'Green-B'), 'tram');
  assert.equal(transitModeFor(mbta, 'CR-Fitchburg'), 'rail');
  assert.equal(transitModeFor(mbta, 'Boat-F1'), 'ferry');
  assert.equal(transitModeFor(mbta, '66'), 'bus');
  assert.equal(transitModeFor(mbta, null), 'bus');
  const hsl = getTransitFeed('hsl-helsinki');
  assert.equal(transitModeFor(hsl, '31M1'), 'subway');
  assert.equal(transitModeFor(hsl, '1006'), 'tram');
  assert.equal(transitModeFor(hsl, '9982'), 'bus');
  const msp = getTransitFeed('metrotransit-msp');
  assert.equal(transitModeFor(msp, '901'), 'tram');
  assert.equal(transitModeFor(msp, '17'), 'bus');
  const entur = getTransitFeed('entur-norway');
  assert.equal(transitModeFor(entur, 'VYG:Line:R10'), 'rail');
  assert.equal(transitModeFor(entur, 'TRO:Line:1_310'), 'bus');
  assert.equal(transitModeFor({ defaultMode: 'spaceship' }, 'x'), 'unknown');
  assert.equal(transitModeFor(null, 'x'), 'unknown');
});

test('the public catalog exposes coverage and credit, never the upstream URL or headers', () => {
  const catalog = publicTransitCatalog();
  assert.equal(catalog.length, TRANSIT_ENABLED_FEEDS.length);
  for (const entry of catalog) {
    assert.equal('url' in entry, false);
    assert.equal('headers' in entry, false);
    assert.ok(entry.id && entry.name && entry.region && entry.attribution);
    assert.ok(
      Number.isFinite(entry.center.lat) && Number.isFinite(entry.loadRadiusKm),
    );
  }
});

test('the enabled set is a gate on the registry, not a copy of it', () => {
  // Every registered feed is switched on today. The gate still has to be the
  // thing that decides that, because the moment an operator's terms change the
  // owner flips one flag and expects the feed to become unreachable — not to
  // stay routable because the filter had quietly become a no-op.
  assert.deepEqual(
    TRANSIT_ENABLED_FEEDS.map((feed) => feed.id),
    TRANSIT_FEED_REGISTRY.filter((feed) => feed.defaultEnabled === true).map(
      (feed) => feed.id,
    ),
  );
  for (const feed of TRANSIT_FEED_REGISTRY) {
    assert.equal(
      typeof feed.defaultEnabled,
      'boolean',
      `${feed.id} states whether it ships on`,
    );
    assert.equal(
      Boolean(getTransitFeed(feed.id)),
      feed.defaultEnabled,
      `${feed.id} is routable exactly when it is enabled`,
    );
    assert.ok(getRegisteredTransitFeed(feed.id), `${feed.id} stays documented`);
  }
});

test('a mode the route id established is resolved; a feed default is only a guess', () => {
  // TransLink publishes rail in a feed whose default is bus. A consumer that
  // judges physical plausibility must know the difference, or a 140 km/h
  // train is refused as an impossible bus.
  const translink = getTransitFeed('translink-seq');
  assert.equal(transitModeFor(translink, '600'), 'bus');
  assert.equal(transitModeResolved(translink, '600'), false, 'defaulted');
  const mbta = getTransitFeed('mbta');
  assert.equal(transitModeResolved(mbta, 'Red'), true);
  assert.equal(
    transitModeResolved(mbta, '66'),
    true,
    'a numeric MBTA route is a bus by rule, not by default',
  );
  assert.equal(transitModeResolved(mbta, null), false);
  assert.equal(transitModeResolved({ defaultMode: 'bus' }, 'x'), false);
  assert.equal(
    transitModeResolved({ routeMode: () => 'spaceship' }, 'x'),
    false,
    'an unknown hint resolves nothing',
  );
});

test('only MBTA retains proxy history while every other registered feed stays live-enabled', () => {
  assert.deepEqual(
    publicTransitCatalog()
      .filter((feed) => feed.historyRetention)
      .map((feed) => feed.id),
    ['mbta'],
  );
  assert.equal(getTransitFeed('capmetro-austin').defaultEnabled, true);
  assert.equal(getTransitFeed('mbta').attribution, 'MBTA / MassDOT');
});

test('published transit history scope agrees with the catalog capability', () => {
  const retained = publicTransitCatalog().filter(
    (feed) => feed.historyRetention,
  );
  assert.deepEqual(
    retained.map((feed) => feed.id),
    ['mbta'],
  );
  const sources = readFileSync(
    new URL('../../DATA_SOURCES.md', import.meta.url),
    'utf8',
  );
  const row = sources
    .split('\n')
    .find((line) => line.startsWith('| **MBTA / MassDOT**'));
  assert.match(
    row,
    /live vehicles and up to 15 minutes of recently observed positions/,
  );
  assert.match(row, /MBTA \/ MassDOT.*courtesy/);
  assert.match(sources, /other feeds have no proxy retention/);
  const state = readFileSync(
    new URL('../../docs/CURRENT-STATE.md', import.meta.url),
    'utf8',
  );
  const transit = state.slice(
    state.indexOf('Transit is off by default'),
    state.indexOf('`src/data/militaryAwareness.js` remains'),
  );
  assert.match(transit, /Restart clears it/);
  assert.doesNotMatch(
    transit,
    /four fixes|0\.95x|guaranteed lower|one poll interval behind/,
  );
});
