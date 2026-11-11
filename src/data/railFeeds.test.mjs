import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RAIL_CATEGORIES,
  RAIL_ENABLED_FEEDS,
  RAIL_FEED_ID_PATTERN,
  RAIL_FEED_REGISTRY,
  RAIL_MODES,
  RAIL_POSITION_SOURCES,
  classifyTrain,
  getRailFeed,
  getRegisteredRailFeed,
  isRailFeedPollable,
  publicRailCatalog,
  railEnabledFeeds,
  railFeedPositions,
  railFeedsInRange,
} from './railFeeds.js';

const isHttps = (url) => new URL(url).protocol === 'https:';

test('every registered feed is complete, https and uniquely named', () => {
  const ids = new Set();
  for (const feed of RAIL_FEED_REGISTRY) {
    assert.match(feed.id, RAIL_FEED_ID_PATTERN, feed.id);
    assert.ok(!ids.has(feed.id), `duplicate id ${feed.id}`);
    ids.add(feed.id);
    const positions = railFeedPositions(feed);
    assert.ok(RAIL_POSITION_SOURCES.includes(positions), feed.id);
    assert.ok(isHttps(feed.url), feed.id);
    for (const url of [feed.tripUpdatesUrl, feed.staticGtfsUrl])
      if (url !== undefined) assert.ok(isHttps(url), `${feed.id} ${url}`);
    assert.ok(
      ['gtfs-rt', 'irish-rail-xml', 'siri-vm'].includes(feed.format),
      feed.id,
    );
    if (feed.format === 'irish-rail-xml')
      assert.equal(positions, 'event', `${feed.id} positions are events`);
    for (const key of ['name', 'operator', 'region', 'license', 'attribution'])
      assert.ok(feed[key], `${feed.id} has ${key}`);
    assert.ok(URL.canParse(feed.licenseUrl), `${feed.id} licence url`);
    assert.equal(typeof feed.defaultEnabled, 'boolean', feed.id);
    assert.equal(typeof feed.terms?.quote, 'string', feed.id);
    assert.equal(typeof feed.classify, 'function', feed.id);
    assert.ok(
      Number.isFinite(feed.center.lat) && Number.isFinite(feed.center.lon),
    );
    assert.ok(feed.loadRadiusKm > 0 && feed.loadRadiusKm <= 1000, feed.id);
    for (const ms of [feed.pollIntervalMs, feed.tripUpdatesIntervalMs])
      if (ms !== undefined) assert.ok(ms >= 5_000 && ms <= 300_000, feed.id);
  }
});

// The fields the registry documents (railFeeds.js, RAIL_FEED_REGISTRY):
// an entry carries nothing else, so no feed asks for a key, a sign-in or a
// timetable to place its trains.
const REGISTRY_FIELDS = new Set([
  'id',
  'name',
  'operator',
  'region',
  'center',
  'loadRadiusKm',
  'format',
  'url',
  'positions',
  'headers',
  'headerClock',
  'speedUnit',
  'pollIntervalMs',
  'tripUpdatesUrl',
  'tripUpdatesIntervalMs',
  'maxBodyBytes',
  'limits',
  'routesFrom',
  'positionsByTrainNumber',
  'staticGtfsUrl',
  'staticGtfsEntry',
  'staticHeaders',
  'staticRouteTypes',
  'staticTripEnds',
  'staticSimplifyM',
  'staticRouteRename',
  'staticTripRename',
  'license',
  'licenseUrl',
  'attribution',
  'defaultEnabled',
  'terms',
  'classify',
]);

test('every feed reports live positions: GPS or signalling events', () => {
  for (const feed of RAIL_FEED_REGISTRY) {
    assert.notEqual(feed.positions, 'schedule', feed.id);
    assert.ok(
      ['gps', 'event'].includes(railFeedPositions(feed)),
      `${feed.id} positions`,
    );
    assert.equal(typeof feed.url, 'string', `${feed.id} has a live feed`);
  }
  for (const entry of publicRailCatalog())
    assert.ok(['gps', 'event'].includes(entry.positions), entry.id);
});

/** Query parameter names that carry a key, a token or a signature. */
const ACCESS_PARAM =
  /^(api[-_]?key|appid|app[-_]?key|key|token|access[-_]?token|auth|sig|signature|subscription[-_]?key)$/i;

/** `name=value` of each access parameter in a URL (values decoded). */
function accessParams(url) {
  if (!url) return [];
  return [...new URL(url).searchParams]
    .filter(([name]) => ACCESS_PARAM.test(name))
    .map(([name, value]) => `${name}=${value}`);
}

// The only access parameter allowed, a fixed public value the publisher
// prints in the published link for everyone, the same for every user and not
// a credential of the deployer's: Bordeaux Métropole's TBM `apiKey` (on the
// dataset page).
const PUBLISHED_ACCESS_VALUES = new Set([
  'tbm-bordeaux apiKey=opendata-bordeaux-metropole-flux-gtfs-rt',
]);

test('an access parameter in a feed URL is found, whatever its spelling', () => {
  for (const url of [
    'https://x.test/a?apiKey=1',
    'https://x.test/a?api_key=1',
    'https://x.test/a?APIKEY=1',
    'https://x.test/a?f=pb&key=1',
    'https://x.test/a?token=1',
    'https://x.test/a?access_token=1',
    'https://x.test/a?sr=b&sig=abc%3D',
    'https://x.test/a?signature=1',
    'https://x.test/a?subscription-key=1',
  ])
    assert.equal(accessParams(url).length, 1, url);
  assert.deepEqual(accessParams('https://x.test/a?format=pb&route=key'), []);
  assert.deepEqual(accessParams(null), []);
  // Each published value is still in use, so the allow-list cannot go stale.
  const used = new Set();
  for (const feed of RAIL_FEED_REGISTRY)
    for (const url of [feed.url, feed.tripUpdatesUrl, feed.staticGtfsUrl])
      for (const param of accessParams(url)) used.add(`${feed.id} ${param}`);
  assert.deepEqual([...used].sort(), [...PUBLISHED_ACCESS_VALUES].sort());
});

test('every feed is on, credited with its licence and terms, and fetched as published', () => {
  const ids = new Set();
  for (const feed of RAIL_FEED_REGISTRY) {
    assert.ok(!ids.has(feed.id), `duplicate id ${feed.id}`);
    ids.add(feed.id);
    assert.equal(feed.defaultEnabled, true, `${feed.id} is on`);
    for (const field of Object.keys(feed))
      assert.ok(REGISTRY_FIELDS.has(field), `${feed.id}: ${field}`);
    assert.ok(typeof feed.license === 'string' && feed.license, feed.id);
    assert.ok(isHttps(feed.licenseUrl), `${feed.id} licence url`);
    assert.ok(
      typeof feed.attribution === 'string' && feed.attribution,
      feed.id,
    );
    assert.equal(typeof feed.terms?.quote, 'string', `${feed.id} terms`);
    assert.ok(feed.terms.quote || feed.terms.note, `${feed.id} terms basis`);
    // No URL carries an access parameter, but for the fixed public values
    // their publishers print for everyone (PUBLISHED_ACCESS_VALUES).
    for (const url of [feed.url, feed.tripUpdatesUrl, feed.staticGtfsUrl])
      for (const param of accessParams(url))
        assert.ok(
          PUBLISHED_ACCESS_VALUES.has(`${feed.id} ${param}`),
          `${feed.id} ${url}`,
        );
  }
  assert.equal(ids.size, RAIL_FEED_REGISTRY.length);
  assert.deepEqual(
    RAIL_ENABLED_FEEDS.map((feed) => feed.id),
    RAIL_FEED_REGISTRY.map((feed) => feed.id),
  );
});

test('a feed is switched on only when its terms were read and quoted', () => {
  for (const feed of RAIL_ENABLED_FEEDS) {
    assert.ok(
      feed.terms.quote || feed.terms.note,
      `${feed.id} is enabled without a recorded basis`,
    );
  }
  // Tri-Rail states no licence; it is used without one by project owner
  // decision, and the terms say so.
  const triRail = getRailFeed('tri-rail');
  assert.ok(triRail, 'tri-rail is pollable');
  assert.ok(
    triRail.terms.note.startsWith(
      'Used without a published licence (project owner decision, 2026-11-10)',
    ),
  );
  assert.match(triRail.license, /^No licence stated/);
});

test('only enabled, well-formed ids resolve to a pollable feed', () => {
  assert.equal(getRailFeed('mta-metro-north')?.id, 'mta-metro-north');
  for (const id of ['', 'Nope', '../x', 'a', null, 42, 'unknown-feed'])
    assert.equal(getRailFeed(id), null, String(id));
  const mbta = getRegisteredRailFeed('mbta-rail');
  assert.equal(isRailFeedPollable(mbta), true);
  assert.equal(isRailFeedPollable({ ...mbta, defaultEnabled: false }), false);
  assert.deepEqual(
    railEnabledFeeds().map((entry) => entry.id),
    RAIL_ENABLED_FEEDS.map((entry) => entry.id),
  );
});

test('classifiers keep trains and drop buses in mixed feeds', () => {
  const kind = (id, route) => classifyTrain(getRegisteredRailFeed(id), route);
  assert.deepEqual(kind('mbta-rail', 'CR-Worcester'), {
    category: 'local',
    mode: 'rail',
  });
  assert.equal(kind('mbta-rail', 'Red').mode, 'metro');
  assert.equal(kind('mbta-rail', 'Green-E').mode, 'tram');
  assert.equal(kind('mbta-rail', 'Mattapan').category, 'transit');
  assert.equal(kind('mbta-rail', '1'), null);
  assert.equal(kind('mbta-rail', 'Boat-F1'), null);
  assert.equal(kind('mbta-rail', 'Shuttle-Generic'), null);
  assert.equal(kind('mbta-rail', null), null);

  assert.equal(kind('rtd-denver-rail', 'A').category, 'local');
  assert.equal(kind('rtd-denver-rail', '113G').category, 'local');
  assert.equal(kind('rtd-denver-rail', '117N').category, 'local');
  assert.equal(kind('rtd-denver-rail', '101E').category, 'transit');
  assert.equal(kind('rtd-denver-rail', '107R').category, 'transit');
  assert.equal(kind('rtd-denver-rail', '15'), null);
  assert.equal(kind('rtd-denver-rail', '15L'), null);

  assert.equal(kind('capmetro-rail', '550').category, 'local');
  assert.equal(kind('capmetro-rail', '801'), null);
  // Northstar's old route id is a bus now and must not come back as a train.
  assert.equal(kind('metrotransit-rail', '888'), null);
  assert.equal(kind('metrotransit-rail', '902').mode, 'tram');
  assert.equal(kind('septa-trolley', 'M1').mode, 'metro');
  assert.equal(kind('septa-trolley', '17'), null);
  assert.equal(kind('translink-seq-rail', 'BRCA-5').category, 'local');
  assert.equal(kind('translink-seq-rail', '61-3'), null);
  assert.equal(kind('adelaide-metro', 'SEAFRD').category, 'local');
  assert.equal(kind('adelaide-metro', 'GLNELG').mode, 'tram');
  assert.equal(kind('adelaide-metro', 'J1A'), null);
  assert.equal(kind('mta-metro-north', null).category, 'local');
});

test('Irish Rail: DART and Commuter local, InterCity by province, Enterprise international', () => {
  const kind = (code, route) =>
    classifyTrain(getRegisteredRailFeed('irish-rail'), route, {
      tripId: code,
    })?.category ?? null;
  assert.equal(kind('E244', 'Howth - Bray'), 'local');
  assert.equal(kind('D822', 'Grand Canal Dock - Drogheda'), 'local');
  assert.equal(kind('P571', 'Midleton - Cork'), 'local');
  assert.equal(kind('A216', 'Dublin Heuston - Cork'), 'national');
  assert.equal(kind('A720', 'Dublin Heuston - Galway'), 'national');
  assert.equal(kind('B701', 'Galway - Dublin Heuston'), 'national');
  assert.equal(kind('A308', 'Mallow - Tralee'), 'regional', 'both Munster');
  assert.equal(kind('A606', 'Dublin Connolly - Rosslare Europort'), 'regional');
  assert.equal(kind('A118', 'Dublin Connolly - Belfast'), 'international');
  assert.equal(kind('A131', 'Belfast - Dublin Connolly'), 'international');
  assert.equal(kind('A999', 'Nowhere - Elsewhere'), 'national');
  assert.equal(kind('A999', null), 'national');
  assert.equal(kind('not a code', 'Howth - Bray'), null);
  assert.equal(kind(null, 'Howth - Bray'), null);
});

test('a classifier answer outside the known lists is treated as not a train', () => {
  const feed = (answer) => ({ classify: () => answer });
  assert.equal(
    classifyTrain(feed({ category: 'express', mode: 'rail' })),
    null,
  );
  assert.equal(classifyTrain(feed({ category: 'local', mode: 'bus' })), null);
  assert.equal(classifyTrain(feed(null)), null);
  assert.equal(classifyTrain({}), null);
  assert.equal(classifyTrain(null), null);
  for (const feed of RAIL_FEED_REGISTRY) {
    for (const route of [
      'CR-Lowell',
      'A',
      '550',
      '901',
      'T1',
      'BRCA-5',
      'GAW',
      null,
    ]) {
      const kind = feed.classify(route);
      if (!kind) continue;
      assert.ok(RAIL_CATEGORIES.includes(kind.category), `${feed.id} ${route}`);
      assert.ok(RAIL_MODES.includes(kind.mode), `${feed.id} ${route}`);
    }
  }
});

test('coverage selection returns enabled feeds near the point, nearest first', () => {
  const nyc = railFeedsInRange(40.75, -73.99).map((feed) => feed.id);
  assert.ok(nyc.includes('mta-metro-north') && nyc.includes('mta-lirr'));
  assert.deepEqual(railFeedsInRange(0, -150), []);
  assert.deepEqual(railFeedsInRange(Number.NaN, 0), []);
  const brisbane = railFeedsInRange(-27.47, 153.02);
  assert.equal(brisbane[0].id, 'translink-seq-rail');
  // The browser passes the server's catalog, which lists a feed that reads
  // its routes from a schedule pack only once that pack is built.
  const madrid = (built) =>
    railFeedsInRange(
      40.42,
      -3.7,
      0,
      publicRailCatalog({ schedulePackBuilt: () => built }),
    ).map((feed) => feed.id);
  assert.ok(
    !madrid(false).includes('renfe-larga-distancia'),
    'no pack: not offered',
  );
  assert.ok(madrid(false).includes('renfe-cercanias'), 'needs no pack');
  assert.ok(madrid(true).includes('renfe-larga-distancia'));
  assert.deepEqual(railFeedsInRange(-27.47, 153.02, 0, null), []);
  assert.deepEqual(railFeedsInRange(-27.47, 153.02, 0, [{ id: 'x' }]), []);
});

test('the public catalog exposes coverage and credit but never upstream URLs', () => {
  const catalog = publicRailCatalog();
  assert.equal(catalog.length, RAIL_ENABLED_FEEDS.length);
  for (const entry of catalog) {
    assert.equal(entry.url, undefined);
    assert.equal(entry.tripUpdatesUrl, undefined);
    assert.equal(entry.headers, undefined);
    assert.equal(entry.classify, undefined);
    assert.ok(entry.attribution && entry.licenseUrl);
    assert.ok(RAIL_POSITION_SOURCES.includes(entry.positions));
    assert.equal(typeof entry.tripUpdates, 'boolean');
  }
  const byId = new Map(catalog.map((entry) => [entry.id, entry]));
  assert.equal(byId.get('irish-rail').positions, 'event');
  assert.equal(byId.get('irish-rail').tripUpdates, false);
  assert.equal(byId.get('mbta-rail').positions, 'gps');
  assert.equal(byId.get('mbta-rail').tripUpdates, true);
  // No upstream URL reaches the browser, by any field but the licence link
  // (an access point's page can be both the licence and the download).
  const text = JSON.stringify(
    catalog.map((entry) => ({ ...entry, licenseUrl: null })),
  );
  for (const feed of RAIL_FEED_REGISTRY)
    for (const url of [feed.url, feed.tripUpdatesUrl, feed.staticGtfsUrl])
      if (url) assert.ok(!text.includes(url), `${feed.id} ${url}`);
});

test('Finland: commuter local, H/HDM regional, long distance national, Haaparanta international', () => {
  const kind = (route) =>
    classifyTrain(getRegisteredRailFeed('fintraffic-vr'), route)?.category ??
    null;
  assert.equal(kind('EPO_HKI_E_HL_10'), 'local');
  assert.equal(kind('SK_ÄHT_480_HDM_10'), 'regional');
  assert.equal(kind('TPE_PRI_1_H_10'), 'regional');
  for (const route of [
    'HKI_ROI_23_IC_10',
    'HKI_OL_45_S_10',
    'HKI_KOK_101_P_10',
    'HKI_KLI_265_PYO_10',
  ])
    assert.equal(kind(route), 'national', route);
  assert.equal(kind('OL_HPA_407_IC_10'), 'international');
  assert.equal(kind('HPA_OL_408_IC_10'), 'international');
  for (const route of ['HKI_TKU_1_T_10', 'IC 23', null])
    assert.equal(kind(route), null, String(route));
});

test('Renfe: products and the autonomous-community rule', () => {
  const feed = getRegisteredRailFeed('renfe-larga-distancia');
  const kind = (route) => classifyTrain(feed, route)?.category ?? null;
  for (const product of ['AVE', 'AVLO', 'ALVIA', 'EUROMED', 'Intercity'])
    for (const scope of ['S', 'X'])
      assert.equal(kind(`${product}~${scope}~1`), 'national', product);
  for (const product of ['MD', 'REGIONAL', 'REG.EXP.', 'PROXIMDAD', 'AVANT']) {
    assert.equal(kind(`${product}~S~1`), 'regional', product);
    assert.equal(kind(`${product}~X~1`), 'national', product);
  }
  assert.equal(kind('AVE INT~X~1'), 'international');
  assert.equal(kind('TRENCELTA~X~1'), 'international');
  assert.equal(kind('MD~B~1'), 'international', 'an end abroad');
  assert.equal(kind('BUS~S~1'), null);
  assert.equal(kind('1700037606GL023'), null, 'an unscoped operator id');
  assert.equal(kind(null), null);
  // The rename the path build applies to routes.txt rows.
  const places = {
    17000: { lat: 40.47, lon: -3.68 },
    37606: { lat: 38.89, lon: -6.98 },
    18000: { lat: 40.41, lon: -3.7 },
    87089: { lat: 43.3, lon: 5.38 },
  };
  const helpers = {
    stop: (id) => places[id] ?? null,
    stateAt: (lat) =>
      lat > 43
        ? { country: 'FR', state: 'FR-13' }
        : lat < 39.5
          ? { country: 'ES', state: 'ES-EX' }
          : { country: 'ES', state: 'ES-MD' },
  };
  const rename = (id, product) =>
    feed.staticRouteRename(
      { route_id: id, route_short_name: product },
      helpers,
    );
  assert.equal(rename('1700037606GL023', 'MD'), 'MD~X~1700037606GL023');
  assert.equal(
    rename('1700018000GL001', 'REGIONAL'),
    'REGIONAL~S~1700018000GL001',
  );
  assert.equal(rename('1700087089AV016', 'AVE'), 'AVE~B~1700087089AV016');
  assert.equal(
    rename('1700099999GL001', 'MD'),
    'MD~X~1700099999GL001',
    'unplaced',
  );
  assert.equal(rename('short', 'MD'), null);
  assert.equal(
    classifyTrain(getRegisteredRailFeed('renfe-cercanias'), null)?.category,
    'local',
  );
});

test('Norway: by line and county, replacement buses dropped, Flåmsbana a tourist line', () => {
  const kind = (id, route, tripId = 'VYG:ServiceJourney:536_906310-R') =>
    classifyTrain(getRegisteredRailFeed(id), route, { tripId });
  assert.equal(kind('entur-vy', 'VYG:Line:F4')?.category, 'national');
  assert.equal(kind('entur-vy', 'VYG:Line:RE11')?.category, 'national');
  assert.equal(kind('entur-vy', 'VYG:Line:L1')?.category, 'local');
  assert.equal(kind('entur-vy', 'VYG:Line:RE20')?.category, 'international');
  assert.equal(kind('entur-vy', 'VYG:Line:F1')?.category, 'international');
  assert.equal(kind('entur-vy', 'VYG:Line:R55')?.category, 'regional');
  const flam = kind('entur-vy', 'VYG:Line:R45');
  assert.equal(flam.category, 'regional');
  assert.equal(flam.tourist, true);
  assert.equal(kind('entur-go-ahead', 'GOA:Line:50')?.category, 'national');
  assert.equal(kind('entur-go-ahead', 'GOA:Line:59')?.category, 'local');
  assert.equal(kind('entur-flytoget', 'FLT:Line:FLY1')?.category, 'local');
  assert.equal(kind('entur-sj-nord', 'SJN:Line:21')?.category, 'national');
  assert.equal(kind('entur-sj-nord', 'SJN:Line:72')?.category, 'international');
  assert.equal(kind('entur-sj-nord', 'SJN:Line:26')?.category, 'regional');
  assert.equal(
    kind('entur-vy', 'VYG:Line:RE11', 'VYG:ServiceJourney:BUS-836_761763-R'),
    null,
    'a replacement bus on a train line',
  );
  assert.equal(kind('entur-vy', 'VYG:Line:X99'), null);
  assert.match(getRegisteredRailFeed('entur-sj-nord').terms.note, /missing/);
  // Its positions come from SIRI VM, the timetable still gives its stops.
  assert.equal(
    railFeedPositions(getRegisteredRailFeed('entur-sj-nord')),
    'gps',
  );
  assert.equal(getRegisteredRailFeed('entur-sj-nord').format, 'siri-vm');
});

test('feeds that read routes from their schedule pack can build one', () => {
  for (const feed of RAIL_FEED_REGISTRY.filter((entry) => entry.routesFrom)) {
    assert.equal(feed.routesFrom, 'schedule', feed.id);
    assert.ok(isHttps(feed.staticGtfsUrl), feed.id);
  }
  for (const feed of RAIL_FEED_REGISTRY.filter((entry) => entry.headerClock))
    assert.equal(feed.headerClock, 'untrusted', feed.id);
  // Identify-yourself headers never carry a person.
  for (const feed of RAIL_FEED_REGISTRY)
    for (const value of Object.values({
      ...(feed.headers || {}),
      ...(feed.staticHeaders || {}),
    }))
      assert.ok(!/@/.test(value), feed.id);
});

test('a feed Transit also reads declares the same speed unit', async () => {
  const { TRANSIT_FEED_REGISTRY } = await import('./transitFeeds.js');
  const transitByUrl = new Map(
    TRANSIT_FEED_REGISTRY.map((feed) => [feed.url, feed]),
  );
  let shared = 0;
  for (const feed of RAIL_FEED_REGISTRY) {
    const transit = transitByUrl.get(feed.url);
    if (!transit) continue;
    shared += 1;
    assert.equal(feed.speedUnit, transit.speedUnit, feed.id);
  }
  assert.ok(shared > 0);
  assert.equal(getRegisteredRailFeed('tam-montpellier').speedUnit, 'km/h');
});
