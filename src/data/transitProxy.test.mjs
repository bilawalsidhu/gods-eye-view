import test from 'node:test';
import assert from 'node:assert/strict';
import { PbfWriter } from 'pbf';
import {
  TRANSIT_BACKOFF_LADDER_MS,
  TRANSIT_PROXY_STALE_MAX_MS,
  TRANSIT_PROXY_TTL_MS,
  TransitFeedShapeError,
  buildTransitSnapshot,
  isAcceptableTransitUpstreamUrl,
  nextTransitBackoffMs,
  repairVehicleTimestamps,
  resolveTransitRoute,
  transitCacheState,
  transitRedirectDecision,
  transitResponseHeaders,
  transitUpstreamHeaders,
} from './transitProxy.js';
import {
  getTransitFeed,
  transitModeFor,
  transitModeResolved,
} from './transitFeeds.js';

test('route resolution admits only the catalog and registered feed ids', () => {
  assert.deepEqual(resolveTransitRoute('/feeds'), { route: 'feeds' });
  assert.deepEqual(resolveTransitRoute('/feeds/?x=1'), { route: 'feeds' });
  assert.equal(resolveTransitRoute('/vehicles/mbta')?.feed?.id, 'mbta');
  assert.equal(resolveTransitRoute('/vehicles/mbta/')?.feed?.id, 'mbta');
  assert.equal(resolveTransitRoute('/vehicles/mbta?trip=1')?.feed?.id, 'mbta');
  assert.equal(resolveTransitRoute('/vehicles/nope'), null);
  assert.equal(resolveTransitRoute('/vehicles/'), null);
  assert.equal(resolveTransitRoute('/vehicles/mbta/extra'), null);
  assert.equal(resolveTransitRoute('/vehicles/..%2F..%2Fetc'), null);
  assert.equal(resolveTransitRoute('/vehicles/%E0%A4%A'), null); // malformed escape never throws
  assert.equal(resolveTransitRoute('/'), null);
  assert.equal(resolveTransitRoute(''), null);
  assert.equal(resolveTransitRoute(undefined), null);
});

test('upstream headers identify the proxy and carry feed-specific identification', () => {
  const plain = transitUpstreamHeaders(getTransitFeed('mbta'));
  assert.match(plain['User-Agent'], /gods-eye-view-transit-proxy/);
  assert.match(plain.Accept, /x-protobuf/);
  const entur = transitUpstreamHeaders(getTransitFeed('entur-norway'));
  assert.equal(entur['ET-Client-Name'], 'gods-eye-view-transit');
  assert.ok(transitUpstreamHeaders(null)['User-Agent']);
});

test('only https upstreams are acceptable, including after a redirect', () => {
  assert.equal(
    isAcceptableTransitUpstreamUrl('https://cdn.mbta.com/x.pb'),
    true,
  );
  assert.equal(
    isAcceptableTransitUpstreamUrl(
      'http://gtfs.ovapi.nl/nl/vehiclePositions.pb',
    ),
    false,
  );
  assert.equal(isAcceptableTransitUpstreamUrl('ftp://x'), false);
  assert.equal(isAcceptableTransitUpstreamUrl('not a url'), false);
});

test('snapshot shape carries provenance the layer displays', () => {
  const writer = new PbfWriter();
  const header = new PbfWriter();
  header.writeStringField(1, '2.0');
  header.writeVarintField(3, 1_700_000_000);
  writer.writeBytesField(1, header.finish());
  const snapshot = buildTransitSnapshot(
    getTransitFeed('mbta'),
    writer.finish(),
    12345,
  );
  assert.equal(snapshot.feedId, 'mbta');
  assert.equal(snapshot.name, 'MBTA');
  assert.equal(snapshot.fetchedAt, 12345);
  assert.equal(snapshot.feedTimestamp, 1_700_000_000);
  assert.equal(snapshot.version, '2.0');
  assert.equal(snapshot.count, 0);
  assert.deepEqual(snapshot.vehicles, []);
});

test('cache policy: fresh within TTL, stale until the serve-stale window, expired after', () => {
  const now = 1_000_000;
  assert.equal(transitCacheState(null, now), 'none');
  assert.equal(transitCacheState({ at: Number.NaN }, now), 'none');
  assert.equal(transitCacheState({ at: now }, now), 'fresh');
  assert.equal(
    transitCacheState({ at: now - TRANSIT_PROXY_TTL_MS + 1 }, now),
    'fresh',
  );
  assert.equal(
    transitCacheState({ at: now - TRANSIT_PROXY_TTL_MS }, now),
    'stale',
  );
  assert.equal(
    transitCacheState({ at: now - TRANSIT_PROXY_STALE_MAX_MS + 1 }, now),
    'stale',
  );
  assert.equal(
    transitCacheState({ at: now - TRANSIT_PROXY_STALE_MAX_MS }, now),
    'expired',
  );
  assert.equal(transitCacheState({ at: now + 5000 }, now), 'fresh'); // clock skew never expires a fresh fetch
});

test('response headers mark cache state and never let a stale-error response be cached downstream', () => {
  assert.equal(
    transitResponseHeaders('HIT', 'cdn.mbta.com')['X-Transit-Upstream'],
    'cdn.mbta.com',
  );
  assert.equal(
    transitResponseHeaders('HIT')['Cache-Control'],
    'public, max-age=15',
  );
  assert.equal(
    transitResponseHeaders('STALE-ERROR')['Cache-Control'],
    'no-store',
  );
  assert.equal(transitResponseHeaders('MISS')['X-GEV-Cache'], 'MISS');
});

/** A minimal FeedMessage with the given header fields and vehicle entities. */
function encodeFeed({
  incrementality = null,
  timestamp = 1_700_000_000,
  entities = [],
}) {
  const writer = new PbfWriter();
  const header = new PbfWriter();
  header.writeStringField(1, '2.0');
  if (incrementality !== null) header.writeVarintField(2, incrementality);
  if (timestamp !== null) header.writeVarintField(3, timestamp);
  writer.writeBytesField(1, header.finish());
  for (const entity of entities) {
    const feedEntity = new PbfWriter();
    feedEntity.writeStringField(1, entity.id);
    const vehicle = new PbfWriter();
    if (entity.routeId !== undefined) {
      const trip = new PbfWriter();
      trip.writeStringField(1, `trip-${entity.id}`);
      trip.writeStringField(5, entity.routeId);
      vehicle.writeBytesField(1, trip.finish());
    }
    const position = new PbfWriter();
    position.writeFloatField(1, entity.lat);
    position.writeFloatField(2, entity.lon);
    vehicle.writeBytesField(2, position.finish());
    if (entity.timestamp) vehicle.writeVarintField(5, entity.timestamp);
    const descriptor = new PbfWriter();
    descriptor.writeStringField(1, entity.vehicleId || entity.id);
    vehicle.writeBytesField(8, descriptor.finish());
    feedEntity.writeBytesField(4, vehicle.finish());
    writer.writeBytesField(2, feedEntity.finish());
  }
  return writer.finish();
}

test('MBTA binary snapshots retain default route trimming for mode classification', () => {
  const feed = getTransitFeed('mbta');
  const snapshot = buildTransitSnapshot(
    feed,
    encodeFeed({
      entities: [{ id: 'v1', routeId: ' Green-B ', lat: 42.3, lon: -71.1 }],
    }),
    1_700_000_002_000,
  );
  assert.equal(snapshot.count, 1);
  const [vehicle] = snapshot.vehicles;
  assert.deepEqual(
    [
      vehicle.routeId,
      transitModeFor(feed, vehicle.routeId),
      transitModeResolved(feed, vehicle.routeId),
    ],
    ['Green-B', 'tram', true],
  );
});

test('RTD binary snapshots preserve route identity, mode and individual fix ages', () => {
  const feed = getTransitFeed('rtd-denver');
  const timestamp = 1_700_000_000;
  const entities = [
    { id: 'bus', routeId: 'BOND', timestamp: timestamp - 540 },
    { id: 'tram', routeId: '101T', timestamp: timestamp - 5 },
    { id: 'rail', routeId: 'A', timestamp: timestamp - 7 },
    { id: 'unknown', routeId: '101Z', timestamp: timestamp - 10 },
    { id: 'unassigned' },
  ].map((entity) => ({ lat: 40.015, lon: -105.2705, ...entity }));
  const fetchedAt = (timestamp + 2) * 1000;
  for (const incrementality of [0, null]) {
    const snapshot = buildTransitSnapshot(
      feed,
      encodeFeed({ timestamp, incrementality, entities }),
      fetchedAt,
    );
    assert.equal(snapshot.feedId, 'rtd-denver');
    assert.equal(snapshot.name, 'RTD');
    assert.equal(snapshot.version, '2.0');
    assert.equal(snapshot.feedTimestamp, timestamp);
    assert.equal(snapshot.fetchedAt, fetchedAt);
    assert.equal(snapshot.count, 5);
    assert.equal(snapshot.entityCount, 5);
    assert.equal(snapshot.truncated, false);
    assert.deepEqual(
      snapshot.vehicles.map((vehicle) => [
        vehicle.id,
        vehicle.routeId,
        transitModeFor(feed, vehicle.routeId),
        transitModeResolved(feed, vehicle.routeId),
        vehicle.timestamp,
        vehicle.timestampSource,
      ]),
      [
        ['bus', 'BOND', 'bus', true, timestamp - 540, 'vehicle'],
        ['tram', '101T', 'tram', true, timestamp - 5, 'vehicle'],
        ['rail', 'A', 'rail', true, timestamp - 7, 'vehicle'],
        ['unknown', '101Z', 'unknown', false, timestamp - 10, 'vehicle'],
        ['unassigned', null, 'unknown', false, timestamp, 'header'],
      ],
    );
    assert.equal(snapshot.vehicles[0].tripId, 'trip-bus');
    for (const vehicle of snapshot.vehicles) {
      assert.ok(Math.abs(vehicle.lat - 40.015) < 0.00001);
      assert.ok(Math.abs(vehicle.lon + 105.2705) < 0.00001);
    }
  }
  const noTime = buildTransitSnapshot(
    feed,
    encodeFeed({ timestamp: null, entities: [entities[4]] }),
    fetchedAt,
  );
  assert.equal(noTime.vehicles[0].timestamp, timestamp + 2);
  assert.equal(noTime.vehicles[0].timestampSource, 'fetch');
  assert.throws(
    () =>
      buildTransitSnapshot(
        feed,
        encodeFeed({ incrementality: 1, entities }),
        fetchedAt,
      ),
    (error) =>
      error instanceof TransitFeedShapeError &&
      error.transitReason === 'differential',
  );
});

for (const [feedId, routeId, expectedId, expectedMode, resolved] of [
  ['mbta', 'Red', 'Red', 'subway', true],
  ['mbta', '\tRed\n', 'Red', 'subway', true],
  ['mbta', ' ', null, 'bus', false],
  ['mbta', undefined, null, 'bus', false],
  ['metrotransit-msp', ' 901 ', '901', 'tram', true],
  ['metrotransit-msp', '\t\r\n', null, 'bus', false],
  ['rtd-denver', 'NEW', 'NEW', 'unknown', false],
  ['rtd-denver', ' NEW ', ' NEW ', 'unknown', false],
  ['rtd-denver', 'bond', 'bond', 'unknown', false],
]) {
  test(`${feedId} binary snapshot classifies ${JSON.stringify(routeId)} with its own normalization policy`, () => {
    const feed = getTransitFeed(feedId);
    const snapshot = buildTransitSnapshot(
      feed,
      encodeFeed({
        entities: [{ id: ' v1 ', routeId, lat: 40.015, lon: -105.2705 }],
      }),
      1_700_000_002_000,
    );
    assert.equal(snapshot.count, 1);
    const [vehicle] = snapshot.vehicles;
    assert.equal(vehicle.id, 'v1');
    assert.deepEqual(
      [
        vehicle.routeId,
        transitModeFor(feed, vehicle.routeId),
        transitModeResolved(feed, vehicle.routeId),
      ],
      [expectedId, expectedMode, resolved],
    );
  });
}

for (const routeId of [' BOND ', ' 101T ', ' A ', '', ' ', '\t\r\n']) {
  test(`RTD binary snapshot keeps non-exact route ${JSON.stringify(routeId)} unresolved`, () => {
    const feed = getTransitFeed('rtd-denver');
    const snapshot = buildTransitSnapshot(
      feed,
      encodeFeed({
        entities: [{ id: 'v1', routeId, lat: 40.015, lon: -105.2705 }],
      }),
      1_700_000_002_000,
    );
    assert.equal(snapshot.count, 1);
    const [vehicle] = snapshot.vehicles;
    assert.deepEqual(
      {
        routeId: vehicle.routeId,
        mode: transitModeFor(feed, vehicle.routeId),
        resolved: transitModeResolved(feed, vehicle.routeId),
      },
      {
        routeId: routeId.trim() ? routeId : null,
        mode: 'unknown',
        resolved: false,
      },
    );
  });
}

test('binary snapshots preserve ordinary route IDs and modes for existing feeds', () => {
  for (const [feedId, routeId, mode] of [
    ['mbta', 'Red', 'subway'],
    ['mbta', 'Green-B', 'tram'],
    ['mbta', 'CR-Fitchburg', 'rail'],
    ['mbta', 'Boat-F1', 'ferry'],
    ['mbta', '66', 'bus'],
    ['hsl-helsinki', '31M1', 'subway'],
    ['hsl-helsinki', '1006', 'tram'],
    ['hsl-helsinki', '9982', 'bus'],
    ['metrotransit-msp', '901', 'tram'],
    ['metrotransit-msp', '17', 'bus'],
    ['entur-norway', 'VYG:Line:R10', 'rail'],
    ['entur-norway', 'TRO:Line:1_310', 'bus'],
  ]) {
    const feed = getTransitFeed(feedId);
    const snapshot = buildTransitSnapshot(
      feed,
      encodeFeed({
        entities: [
          { id: 'v1', routeId, lat: feed.center.lat, lon: feed.center.lon },
        ],
      }),
      1_700_000_002_000,
    );
    assert.equal(snapshot.count, 1);
    assert.equal(snapshot.vehicles[0].routeId, routeId, feedId);
    assert.equal(transitModeFor(feed, snapshot.vehicles[0].routeId), mode);
    assert.equal(transitModeResolved(feed, snapshot.vehicles[0].routeId), true);
  }
});

test('a redirect is judged before it is followed, not after it has been answered', () => {
  const feed = { url: 'https://data.example.gov/download/feed.pb' };
  // Same origin, absolute and relative, is the only case that may proceed.
  assert.deepEqual(
    transitRedirectDecision(
      feed.url,
      feed.url,
      'https://data.example.gov/files/a.pb',
    ),
    { ok: true, url: 'https://data.example.gov/files/a.pb' },
  );
  assert.deepEqual(transitRedirectDecision(feed.url, feed.url, '/files/b.pb'), {
    ok: true,
    url: 'https://data.example.gov/files/b.pb',
  });
  // Another host is refused even though it is https — this is the hop that used
  // to be contacted first and inspected afterwards.
  const offOrigin = transitRedirectDecision(
    feed.url,
    feed.url,
    'https://cdn.elsewhere.test/a.pb',
  );
  assert.equal(offOrigin.ok, false);
  assert.match(offOrigin.reason, /left https:\/\/data\.example\.gov/);
  // A downgrade to http, a missing Location, and a malformed target all refuse.
  assert.equal(
    transitRedirectDecision(feed.url, feed.url, 'http://data.example.gov/a.pb')
      .ok,
    false,
  );
  assert.equal(transitRedirectDecision(feed.url, feed.url, null).ok, false);
  assert.equal(
    transitRedirectDecision(feed.url, feed.url, 'javascript:alert(1)').ok,
    false,
  );
  assert.equal(
    transitRedirectDecision(feed.url, feed.url, 'data:text/plain,x').ok,
    false,
  );
  assert.equal(
    transitRedirectDecision('not-a-url', 'not-a-url', '/a.pb').ok,
    false,
  );
  // A sibling port is a different origin.
  assert.equal(
    transitRedirectDecision(
      feed.url,
      feed.url,
      'https://data.example.gov:8443/a.pb',
    ).ok,
    false,
  );
});

test('failure cooldown climbs and stops climbing, and a healthy feed waits for nothing', () => {
  assert.equal(nextTransitBackoffMs(0), 0);
  assert.equal(nextTransitBackoffMs(-3), 0);
  assert.deepEqual([1, 2, 3, 4].map(nextTransitBackoffMs), [
    ...TRANSIT_BACKOFF_LADDER_MS,
  ]);
  // Past the ladder the wait stays at its last rung rather than growing forever.
  assert.equal(nextTransitBackoffMs(9), TRANSIT_BACKOFF_LADDER_MS.at(-1));
  assert.equal(nextTransitBackoffMs(500), TRANSIT_BACKOFF_LADDER_MS.at(-1));
});

test('a differential feed is refused rather than read as a full snapshot', () => {
  const feed = getTransitFeed('mbta');
  const differential = encodeFeed({
    incrementality: 1,
    entities: [{ id: 'v1', lat: 42.36, lon: -71.05, timestamp: 1_700_000_000 }],
  });
  assert.throws(
    () => buildTransitSnapshot(feed, differential, 1_700_000_000_000),
    (error) =>
      error instanceof TransitFeedShapeError &&
      error.transitReason === 'differential',
  );
  // The same bytes with FULL_DATASET decode normally, so the refusal is about
  // the header and not about the payload.
  const full = encodeFeed({
    incrementality: 0,
    entities: [{ id: 'v1', lat: 42.36, lon: -71.05, timestamp: 1_700_000_000 }],
  });
  assert.equal(buildTransitSnapshot(feed, full, 1_700_000_000_000).count, 1);
  // An absent incrementality field means FULL_DATASET by the spec's default.
  assert.equal(
    buildTransitSnapshot(feed, encodeFeed({ entities: [] }), 1).count,
    0,
  );
});

test('a vehicle with no time of its own borrows the feed header time and says so', () => {
  const fetchedAtS = 1_700_000_500;
  const repaired = repairVehicleTimestamps(
    [
      { id: 'own', timestamp: 1_700_000_400 },
      { id: 'none' },
      { id: 'zero', timestamp: 0 },
    ],
    1_700_000_450,
    fetchedAtS,
  );
  assert.deepEqual(
    repaired.map((vehicle) => [
      vehicle.id,
      vehicle.timestamp,
      vehicle.timestampSource,
    ]),
    [
      ['own', 1_700_000_400, 'vehicle'],
      ['none', 1_700_000_450, 'header'],
      ['zero', 1_700_000_450, 'header'],
    ],
  );
  // With no header either, fetch time is used and is labelled as such — never
  // presented as the vehicle's own report.
  const noHeader = repairVehicleTimestamps([{ id: 'none' }], null, fetchedAtS);
  assert.deepEqual(
    [noHeader[0].timestamp, noHeader[0].timestampSource],
    [fetchedAtS, 'fetch'],
  );
  assert.deepEqual(repairVehicleTimestamps(null, null, fetchedAtS), []);
});

test('the snapshot builder fills timestamps from the header it decoded', () => {
  const feed = getTransitFeed('mbta');
  const bytes = encodeFeed({
    timestamp: 1_700_000_000,
    entities: [{ id: 'unstamped', lat: 42.36, lon: -71.05 }],
  });
  const snapshot = buildTransitSnapshot(feed, bytes, 1_700_000_900_000);
  assert.equal(snapshot.vehicles[0].timestamp, 1_700_000_000);
  assert.equal(snapshot.vehicles[0].timestampSource, 'header');
  assert.equal(snapshot.feedTimestamp, 1_700_000_000);
});

test('conditional-request validators and gzip ride along with feed identification', () => {
  const entur = getTransitFeed('entur-norway');
  const plain = transitUpstreamHeaders(entur);
  assert.equal(plain['Accept-Encoding'], 'gzip');
  assert.equal(plain['ET-Client-Name'], 'gods-eye-view-transit');
  assert.equal('If-None-Match' in plain, false);
  const conditional = transitUpstreamHeaders(entur, {
    etag: 'W/"abc"',
    lastModified: 'Wed, 10 Sep 2026 12:00:00 GMT',
  });
  assert.equal(conditional['If-None-Match'], 'W/"abc"');
  assert.equal(
    conditional['If-Modified-Since'],
    'Wed, 10 Sep 2026 12:00:00 GMT',
  );
  assert.match(conditional['User-Agent'], /gods-eye-view/);
});

test('retained routes validate the entire identifier and only MBTA is opted in', () => {
  assert.equal(resolveTransitRoute('/trail/mbta/bus%201').vehicleId, 'bus 1');
  for (const path of [
    '/trail/mbta/a%2Fb',
    '/trail/mbta/%00',
    '/trail/mbta/%5C',
    '/trail/mbta/%2E%2E',
    '/trail/mbta/%E0%A4%A',
    `/trail/mbta/${encodeURIComponent('é'.repeat(129))}`,
    '/trail/capmetro-austin/b',
  ])
    assert.equal(resolveTransitRoute(path), null);
});
test('client history validates response bounds, epochs and cancellation through parsing', async () => {
  const { fetchTransitHistory } = await import('./transitProxy.js');
  const payload = {
    version: 1,
    feedId: 'mbta',
    vehicleId: 'b',
    epochs: [{ id: 1, trip: '', route: '1', mode: 'bus' }],
    fixes: [[1000, 42, -71, 1, 1]],
  };
  assert.deepEqual(
    await fetchTransitHistory(
      'mbta',
      'b',
      new AbortController().signal,
      async () => new Response(JSON.stringify(payload)),
    ),
    payload,
  );
  for (const value of [
    { ...payload, vehicleId: 'wrong' },
    { ...payload, fixes: [[1000, 91, -71, 1, 1]] },
    { ...payload, fixes: Array(129).fill(payload.fixes[0]) },
    { ...payload, epochs: [] },
  ])
    await assert.rejects(
      fetchTransitHistory(
        'mbta',
        'b',
        undefined,
        async () => new Response(JSON.stringify(value)),
      ),
    );
  await assert.rejects(
    fetchTransitHistory(
      'mbta',
      'b',
      undefined,
      async () => new Response('x'.repeat(32769)),
    ),
    /limit/,
  );
  const controller = new AbortController();
  await assert.rejects(
    fetchTransitHistory('mbta', 'b', controller.signal, async () => {
      controller.abort();
      return new Response(JSON.stringify(payload));
    }),
    { name: 'AbortError' },
  );
});
