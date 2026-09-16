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
  transitRouteLabel,
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

test('the TTC feed is registered, routable, and covers Toronto', () => {
  const ttc = getTransitFeed('ttc-toronto');
  assert.equal(ttc?.url, 'https://bustime.ttc.ca/gtfsrt/vehicles');
  assert.equal(ttc.defaultEnabled, true);
  assert.match(ttc.attribution, /Toronto Transit Commission/);
  assert.equal(ttc.historyRetention, undefined, 'no proxy retention');
  assert.ok(
    transitFeedsInRange(43.6532, -79.3832).some(
      (feed) => feed.id === 'ttc-toronto',
    ),
    'downtown Toronto is inside the load radius',
  );
});

test('TTC route numbers tell a streetcar from a bus', () => {
  // BusTime is the surface feed: 500-series are streetcar routes and the
  // streetcar-operated Blue Night routes keep their own numbers. Everything
  // else on this feed is a bus, so the mode is established, not defaulted.
  const ttc = getTransitFeed('ttc-toronto');
  assert.equal(transitModeFor(ttc, '501'), 'tram');
  assert.equal(transitModeFor(ttc, '512'), 'tram');
  assert.equal(transitModeFor(ttc, '304'), 'tram');
  assert.equal(transitModeFor(ttc, '36'), 'bus');
  // 52 Lawrence West is a bus. Only the three-digit 500-series is streetcar,
  // so the rule must not match on a leading 5 alone.
  assert.equal(transitModeFor(ttc, '52'), 'bus');
  assert.equal(transitModeFor(ttc, '59'), 'bus');
  assert.equal(transitModeFor(ttc, '900'), 'bus');
  assert.equal(transitModeFor(ttc, '352'), 'bus');
  assert.equal(transitModeResolved(ttc, '501'), true);
  assert.equal(transitModeResolved(ttc, null), false);
  assert.equal(
    transitModeFor(ttc, null),
    'bus',
    'an unrouted vehicle falls back to the feed default, unresolved',
  );
});

test('the TTC row records that BusTime carries no subway', () => {
  const sources = readFileSync(
    new URL('../../DATA_SOURCES.md', import.meta.url),
    'utf8',
  );
  const row = sources.split('\n').find((line) => line.startsWith('| **TTC**'));
  assert.ok(row, 'TTC has a DATA_SOURCES row');
  assert.match(row, /Toronto/);
  assert.match(sources, /surface vehicles \(buses and streetcars\) only/);
  assert.match(sources, /Open Government Licence – Toronto/);
});

test('the Golden Horseshoe neighbours are registered, keyless and routable', () => {
  const expected = {
    'miway-mississauga':
      'https://www.miapp.ca/GTFS_RT/Vehicle/VehiclePositions.pb',
    'hsr-hamilton':
      'https://opendata.hamilton.ca/GTFS-RT/GTFS_VehiclePositions.pb',
    'durham-region':
      'https://drtonline.durhamregiontransit.com/gtfsrealtime/VehiclePositions',
  };
  for (const [id, url] of Object.entries(expected)) {
    const feed = getTransitFeed(id);
    assert.ok(feed, `${id} is routable`);
    assert.equal(feed.url, url);
    assert.equal(feed.defaultEnabled, true);
    assert.equal(feed.defaultMode, 'bus');
    assert.equal(feed.historyRetention, undefined, `${id} retains nothing`);
    assert.ok(feed.terms?.quote, `${id} records the terms it ships on`);
  }
});

test('each Golden Horseshoe feed covers its own city and not its neighbours', () => {
  const near = (lat, lon) => transitFeedsInRange(lat, lon).map((f) => f.id);
  // Mississauga City Centre, downtown Hamilton, Oshawa.
  assert.ok(near(43.589, -79.6441).includes('miway-mississauga'));
  assert.ok(near(43.2557, -79.8711).includes('hsr-hamilton'));
  assert.ok(near(43.8971, -78.8658).includes('durham-region'));
  // Hamilton is 60 km from Toronto: far enough that the TTC feed is not polled
  // for it, which is the whole point of a per-feed radius.
  assert.equal(near(43.2557, -79.8711).includes('ttc-toronto'), false);
});

test('a bus-only feed never claims a mode its route ids cannot establish', () => {
  for (const id of ['miway-mississauga', 'hsr-hamilton', 'durham-region']) {
    const feed = getTransitFeed(id);
    assert.equal(transitModeFor(feed, '1'), 'bus');
    assert.equal(
      transitModeResolved(feed, '1'),
      false,
      `${id} defaults rather than resolves`,
    );
  }
});

test('every Golden Horseshoe feed is documented with its licence', () => {
  const sources = readFileSync(
    new URL('../../DATA_SOURCES.md', import.meta.url),
    'utf8',
  );
  for (const name of ['MiWay', 'Hamilton HSR', 'Durham Region Transit']) {
    assert.ok(
      sources.split('\n').some((line) => line.startsWith(`| **${name}`)),
      `${name} has a DATA_SOURCES row`,
    );
  }
  assert.match(sources, /Durham Region Transit publishes no bearing/);
});

test('a feed whose route ids are internal database keys can name its routes', () => {
  // Guelph's realtime feed emits `2991` where the rider sees route `1`. A feed
  // that knows the difference translates it; every other feed is unaffected.
  const guelph = getTransitFeed('guelph-transit');
  assert.equal(transitRouteLabel(guelph, '2991'), '1');
  assert.equal(transitRouteLabel(guelph, '3016'), '99');
  assert.equal(transitRouteLabel(guelph, '3007'), '50 U');
  assert.equal(transitRouteLabel(guelph, '3017'), '99Lite');
});

test('an unknown or absent route id survives translation unchanged', () => {
  const guelph = getTransitFeed('guelph-transit');
  // A route added after this table was built must still render its raw id
  // rather than vanish or read as "undefined".
  assert.equal(transitRouteLabel(guelph, '4242'), '4242');
  assert.equal(transitRouteLabel(guelph, null), null);
  assert.equal(transitRouteLabel(guelph, ''), '');
});

test('a feed with rider-facing route ids is left alone', () => {
  // TTC and Kingston publish the route a rider would say, so translation is
  // identity for them and no table is carried.
  assert.equal(transitRouteLabel(getTransitFeed('ttc-toronto'), '501'), '501');
  assert.equal(transitRouteLabel(getTransitFeed('mbta'), 'Red'), 'Red');
  assert.equal(transitRouteLabel(null, '7'), '7');
});

test('Barrie is registered but unpolled until its licence is accepted', () => {
  // The City offers these terms for acceptance behind a click-through gate.
  // Registered-but-off is how that decision stays visible and one line from
  // reversible, rather than being made silently by a poller.
  assert.equal(
    getRegisteredTransitFeed('barrie-transit')?.name,
    'Barrie Transit',
  );
  assert.equal(getTransitFeed('barrie-transit'), null, 'not routable');
  assert.equal(
    publicTransitCatalog().some((feed) => feed.id === 'barrie-transit'),
    false,
    'never offered to the browser',
  );
});

test('YRT is registered but unpolled until its licence form is answered', () => {
  assert.equal(getRegisteredTransitFeed('yrt-york')?.name, 'YRT/Viva');
  assert.equal(getTransitFeed('yrt-york'), null, 'not routable');
});

test('Viva bus rapid transit is named by its colour, not its route number', () => {
  // YRT publishes `601` where every rider, map and station sign says
  // "Viva Blue". The numeric local routes already read correctly and are
  // left alone.
  const yrt = getRegisteredTransitFeed('yrt-york');
  assert.equal(transitRouteLabel(yrt, '601'), 'Viva Blue');
  assert.equal(transitRouteLabel(yrt, '60301'), 'Viva Purple A');
  assert.equal(transitRouteLabel(yrt, '607'), 'Viva Yellow');
  assert.equal(transitRouteLabel(yrt, '105'), '105', 'a local bus is a number');
  assert.equal(transitRouteLabel(yrt, '9899'), '9899');
});
