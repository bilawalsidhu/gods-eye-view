import test from 'node:test';
import assert from 'node:assert/strict';
import { PbfWriter } from 'pbf';
import {
  RAIL_UPDATES_MAX_TRIPS,
  RailFeedShapeError,
  buildRailSnapshot,
  buildRailTripUpdatesSnapshot,
  railAdmissionGlobalMax,
  railNaturalRequestsPerMinute,
  railCacheStateFor,
  railFeedTtlMs,
  railMaxBodyBytes,
  railResponseHeaders,
  railUpstreamHeaders,
  resolveRailRoute,
} from './railProxy.js';
import {
  RAIL_FEED_REGISTRY,
  getRailFeed,
  getRegisteredRailFeed,
  railFeedPositions,
} from './railFeeds.js';

/** A minimal TripUpdates FeedMessage: `[tripId, routeId, delay]` rows. */
function encodeTripUpdates(rows, { incrementality = null } = {}) {
  const writer = new PbfWriter();
  const header = new PbfWriter();
  header.writeStringField(1, '2.0');
  if (incrementality !== null) header.writeVarintField(2, incrementality);
  header.writeVarintField(3, 1_794_000_000);
  writer.writeBytesField(1, header.finish());
  for (const [tripId, routeId, delay, stopCount = 1] of rows) {
    const entity = new PbfWriter();
    entity.writeStringField(1, tripId);
    const update = new PbfWriter();
    const trip = new PbfWriter();
    trip.writeStringField(1, tripId);
    if (routeId) trip.writeStringField(5, routeId);
    update.writeBytesField(1, trip.finish());
    for (let i = 0; i < stopCount; i += 1) {
      const stop = new PbfWriter();
      stop.writeVarintField(1, i + 1);
      const arrival = new PbfWriter();
      arrival.writeVarintField(1, delay);
      stop.writeBytesField(2, arrival.finish());
      stop.writeStringField(4, `s${i}`);
      update.writeBytesField(2, stop.finish());
    }
    entity.writeBytesField(3, update.finish());
    writer.writeBytesField(2, entity.finish());
  }
  return writer.finish();
}

const IRISH_XML = `<?xml version="1.0" encoding="utf-8"?>
<ArrayOfObjTrainPositions xmlns="http://api.irishrail.ie/realtime/">
  <objTrainPositions>
    <TrainStatus>R</TrainStatus>
    <TrainLatitude>54.0</TrainLatitude>
    <TrainLongitude>-6.4</TrainLongitude>
    <TrainCode>A118</TrainCode>
    <TrainDate>06 Nov 2026</TrainDate>
    <PublicMessage>A118\\n14:50 - Dublin Connolly to Belfast (0 mins late)\\nDeparted Dundalk next stop Newry</PublicMessage>
    <Direction>Northbound</Direction>
  </objTrainPositions>
  <objTrainPositions>
    <TrainStatus>R</TrainStatus>
    <TrainLatitude>53.29</TrainLatitude>
    <TrainLongitude>-6.13</TrainLongitude>
    <TrainCode>E931</TrainCode>
    <TrainDate>06 Nov 2026</TrainDate>
    <PublicMessage>E931\\n15:03 - Greystones to Howth (16 mins late)\\nDeparted Sutton next stop Howth</PublicMessage>
    <Direction>Northbound</Direction>
  </objTrainPositions>
</ArrayOfObjTrainPositions>`;

/** A minimal FeedMessage whose vehicles carry a trip route id. */
function encodeFeed({ incrementality = null, entities = [] }) {
  const writer = new PbfWriter();
  const header = new PbfWriter();
  header.writeStringField(1, '2.0');
  if (incrementality !== null) header.writeVarintField(2, incrementality);
  header.writeVarintField(3, 1_700_000_000);
  writer.writeBytesField(1, header.finish());
  for (const entity of entities) {
    const feedEntity = new PbfWriter();
    feedEntity.writeStringField(1, entity.id);
    const vehicle = new PbfWriter();
    if (entity.route) {
      const trip = new PbfWriter();
      trip.writeStringField(1, `trip-${entity.id}`);
      trip.writeStringField(5, entity.route);
      vehicle.writeBytesField(1, trip.finish());
    }
    const position = new PbfWriter();
    position.writeFloatField(1, entity.lat ?? 42.35);
    position.writeFloatField(2, entity.lon ?? -71.06);
    vehicle.writeBytesField(2, position.finish());
    vehicle.writeVarintField(5, 1_699_999_990);
    const descriptor = new PbfWriter();
    descriptor.writeStringField(1, entity.id);
    // A vendor extension (field 1999), as Adelaide Metro sends: it must be
    // skipped, not fail the snapshot.
    const extension = new PbfWriter();
    extension.writeVarintField(1, 1);
    descriptor.writeBytesField(1999, extension.finish());
    vehicle.writeBytesField(8, descriptor.finish());
    feedEntity.writeBytesField(4, vehicle.finish());
    writer.writeBytesField(2, feedEntity.finish());
  }
  return writer.finish();
}

test('route resolution admits only the catalog and enabled rail feeds', () => {
  assert.deepEqual(resolveRailRoute('/feeds'), { route: 'feeds' });
  assert.deepEqual(resolveRailRoute('/feeds/?x=1'), { route: 'feeds' });
  assert.equal(resolveRailRoute('/trains/mbta-rail')?.feed?.id, 'mbta-rail');
  assert.equal(resolveRailRoute('/trains/mbta-rail/')?.feed?.id, 'mbta-rail');
  assert.equal(resolveRailRoute('/trains/vre'), null, 'not registered');
  assert.equal(
    resolveRailRoute('/trains/mbta'),
    null,
    'a transit id is not a rail id',
  );
  assert.equal(resolveRailRoute('/vehicles/mbta-rail'), null);
  assert.equal(resolveRailRoute('/trains/mbta-rail/extra'), null);
  assert.equal(resolveRailRoute('/trains/..%2F..%2Fetc'), null);
  assert.equal(resolveRailRoute('/trains/%E0%A4%A'), null);
  assert.equal(resolveRailRoute(''), null);
  assert.equal(resolveRailRoute(undefined), null);
});

test('path packs resolve for enabled rail feeds only', () => {
  const route = resolveRailRoute('/paths/mta-lirr');
  assert.equal(route?.route, 'paths');
  assert.equal(route?.feed?.id, 'mta-lirr');
  assert.equal(resolveRailRoute('/paths/mta-lirr/?v=1')?.route, 'paths');
  assert.equal(resolveRailRoute('/trains/mta-lirr')?.route, 'trains');
  assert.equal(resolveRailRoute('/paths/vre'), null, 'not registered');
  assert.equal(resolveRailRoute('/paths/unknown'), null);
  assert.equal(resolveRailRoute('/paths/'), null);
  assert.equal(resolveRailRoute('/paths/mta-lirr/extra'), null);
  assert.equal(resolveRailRoute('/paths/..%2F..%2Fetc%2Fpasswd'), null);
  assert.equal(resolveRailRoute('/paths/mta-lirr.json'), null);
  assert.equal(resolveRailRoute('/paths/%E0%A4%A'), null);
});

test('snapshots keep classified trains only and count what was dropped', () => {
  const feed = getRailFeed('mbta-rail');
  const snapshot = buildRailSnapshot(
    feed,
    encodeFeed({
      entities: [
        { id: 'cr1', route: 'CR-Lowell' },
        { id: 'red1', route: 'Red' },
        { id: 'grn1', route: 'Green-D' },
        { id: 'bus1', route: '39' },
        { id: 'none' },
      ],
    }),
    1_700_000_000_000,
  );
  assert.equal(snapshot.feedId, 'mbta-rail');
  assert.equal(snapshot.entityCount, 5);
  assert.equal(snapshot.count, 3);
  assert.equal(snapshot.dropped, 2);
  assert.deepEqual(
    snapshot.trains.map(({ id, category, mode }) => [id, category, mode]),
    [
      ['cr1', 'local', 'rail'],
      ['red1', 'transit', 'metro'],
      ['grn1', 'transit', 'tram'],
    ],
  );
  assert.equal(snapshot.trains[0].timestampSource, 'vehicle');
  assert.equal(snapshot.vehicles, undefined, 'buses never leave the server');
});

test('a rail-only feed keeps vehicles that carry no route', () => {
  const snapshot = buildRailSnapshot(
    getRailFeed('mta-metro-north'),
    encodeFeed({ entities: [{ id: 'mnr1' }] }),
  );
  assert.equal(snapshot.count, 1);
  assert.equal(snapshot.trains[0].category, 'local');
});

test('a differential feed is refused, as in the Transit proxy', () => {
  assert.throws(
    () =>
      buildRailSnapshot(
        getRailFeed('mbta-rail'),
        encodeFeed({ incrementality: 1, entities: [] }),
      ),
    RailFeedShapeError,
  );
});

test('a body that is no FeedMessage is unreadable, not an empty snapshot', () => {
  const feed = getRailFeed('mbta-rail');
  const headerless = new PbfWriter();
  const entity = new PbfWriter();
  entity.writeStringField(1, 'x');
  headerless.writeBytesField(2, entity.finish());
  const versionless = new PbfWriter();
  const header = new PbfWriter();
  header.writeVarintField(3, 1_700_000_000);
  versionless.writeBytesField(1, header.finish());
  for (const [label, bytes] of [
    ['empty', new Uint8Array(0)],
    ['no header', headerless.finish()],
    ['no version', versionless.finish()],
    ['html', new TextEncoder().encode('<!DOCTYPE html><html></html>')],
    ['json', new TextEncoder().encode('{"error":"quota"}')],
  ]) {
    for (const build of [buildRailSnapshot, buildRailTripUpdatesSnapshot])
      assert.throws(
        () => build(feed, bytes, 1_700_000_000_000),
        (error) =>
          error.code === 'UPSTREAM_UNREADABLE' &&
          !(error instanceof RailFeedShapeError),
        `${build.name}: ${label}`,
      );
  }
  // A FeedMessage with its header and nothing else is a real empty feed.
  const quiet = encodeFeed({ entities: [] });
  assert.equal(buildRailSnapshot(feed, quiet).count, 0);
  assert.equal(buildRailTripUpdatesSnapshot(feed, quiet).count, 0);
});

test('upstream headers identify the rail proxy and let a feed override Accept', () => {
  const plain = railUpstreamHeaders(getRailFeed('mbta-rail'), {
    etag: '"abc"',
    lastModified: 'Thu, 01 Jan 2026 00:00:00 GMT',
  });
  assert.match(plain['User-Agent'], /gods-eye-view-rail-proxy/);
  assert.equal(plain['If-None-Match'], '"abc"');
  assert.equal(plain['If-Modified-Since'], 'Thu, 01 Jan 2026 00:00:00 GMT');
  const adelaide = railUpstreamHeaders(getRegisteredRailFeed('adelaide-metro'));
  assert.equal(adelaide.Accept, 'application/x-google-protobuf');
  assert.equal(
    railUpstreamHeaders(getRailFeed('irish-rail')).Accept,
    'text/xml, application/xml;q=0.9',
  );
});

test('response headers report cache state and operator contact', () => {
  const fresh = railResponseHeaders('MISS', 'cdn.mbta.com', 1_700_000_000_123);
  assert.equal(fresh['X-GEV-Cache'], 'MISS');
  assert.equal(fresh['X-Rail-Upstream'], 'cdn.mbta.com');
  assert.equal(fresh['X-Rail-Contact'], '1700000000123');
  assert.match(fresh['Cache-Control'], /max-age=15/);
  assert.equal(railResponseHeaders('STALE-ERROR')['Cache-Control'], 'no-store');
  assert.equal(railResponseHeaders('HIT')['X-Rail-Contact'], undefined);
});

test('GTFS trains say their positions are GPS', () => {
  const snapshot = buildRailSnapshot(
    getRailFeed('mbta-rail'),
    encodeFeed({ entities: [{ id: 'cr1', route: 'CR-Lowell' }] }),
  );
  assert.equal(snapshot.positions, 'gps');
  assert.equal(snapshot.trains[0].positionSource, 'gps');
});

test('Irish Rail XML becomes classified, event-positioned trains', () => {
  const now = 1_794_000_000_000;
  const snapshot = buildRailSnapshot(
    getRailFeed('irish-rail'),
    new TextEncoder().encode(IRISH_XML),
    now,
  );
  assert.equal(snapshot.feedId, 'irish-rail');
  assert.equal(snapshot.positions, 'event');
  assert.equal(snapshot.entityCount, 2);
  assert.equal(snapshot.count, 2);
  assert.equal(snapshot.feedTimestamp, null);
  const byId = new Map(snapshot.trains.map((t) => [t.id, t]));
  assert.equal(byId.get('A118').category, 'international');
  assert.equal(byId.get('A118').positionSource, 'event');
  assert.equal(byId.get('A118').timestampSource, 'fetch');
  assert.equal(byId.get('A118').timestamp, now / 1000);
  assert.equal(byId.get('E931').category, 'local');
  assert.equal(byId.get('E931').delaySec, 960);
  assert.throws(
    () =>
      buildRailSnapshot(
        getRailFeed('irish-rail'),
        new TextEncoder().encode('<html>Service Unavailable</html>'),
      ),
    (error) =>
      error.code === 'UPSTREAM_UNREADABLE' &&
      !(error instanceof RailFeedShapeError),
  );
});

test('no enabled feed is placed from its timetable', () => {
  // Every train is where its operator reports it: no feed answers `/trains`
  // with a timetable-only list.
  for (const feed of RAIL_FEED_REGISTRY.filter((f) => f.defaultEnabled))
    assert.ok(
      ['gps', 'event'].includes(railFeedPositions(feed)) &&
        typeof feed.url === 'string',
      feed.id,
    );
});

test('trip updates keep rail trips only, with category, and refuse differential feeds', () => {
  const feed = getRailFeed('mbta-rail');
  const snapshot = buildRailTripUpdatesSnapshot(
    feed,
    encodeTripUpdates([
      ['cr', 'CR-Worcester', 120],
      ['red', 'Red', -30],
      ['bus', '39', 60],
      ['none', null, 0],
    ]),
    5_000,
  );
  assert.equal(snapshot.feedId, 'mbta-rail');
  assert.equal(snapshot.fetchedAt, 5_000);
  assert.equal(snapshot.feedTimestamp, 1_794_000_000);
  assert.equal(snapshot.count, 2);
  assert.equal(snapshot.dropped, 2);
  assert.deepEqual(
    snapshot.trips.map((t) => [t.tripId, t.routeId, t.delaySec, t.category]),
    [
      ['cr', 'CR-Worcester', 120, 'local'],
      ['red', 'Red', -30, 'transit'],
    ],
  );
  assert.deepEqual(snapshot.trips[0].stops[0], {
    stopId: 's0',
    stopSequence: 1,
    arrival: { time: null, delay: 120 },
    departure: null,
  });
  assert.throws(
    () =>
      buildRailTripUpdatesSnapshot(
        feed,
        encodeTripUpdates([], { incrementality: 1 }),
      ),
    RailFeedShapeError,
  );
});

test('a train named by its number takes its run, never a timetable position', () => {
  const now = 1_794_000_000_000;
  const bytes = new TextEncoder().encode(IRISH_XML);
  const plain = buildRailSnapshot(getRailFeed('irish-rail'), bytes, now);
  const named = buildRailSnapshot(getRailFeed('irish-rail'), bytes, now, {
    tripFor: (code) => (code === 'A118' ? 'pack-trip' : null),
    routeFor: (tripId) =>
      tripId === 'pack-trip' ? 'A~X~DUB-EUROPORT-I' : null,
  });

  const at = (snapshot) =>
    Object.fromEntries(
      snapshot.trains.map((t) => [t.id, [t.lat, t.lon, t.positionSource]]),
    );
  assert.deepEqual(at(named), at(plain), 'positions as reported');
  const train = named.trains.find((t) => t.id === 'A118');
  assert.equal(train.tripId, 'pack-trip');
  assert.equal(train.trainNumber, 'A118');
});

test('trip updates are kept by their own route', () => {
  const feed = getRailFeed('mbta-rail');
  const snapshot = buildRailTripUpdatesSnapshot(
    feed,
    encodeTripUpdates([
      ['cr', 'CR-Worcester', 120],
      ['bus', '39', 60],
    ]),
    5_000,
    { routeFor: () => null },
  );
  assert.deepEqual(
    snapshot.trips.map((t) => [t.tripId, t.routeId]),
    [['cr', 'CR-Worcester']],
  );
  assert.equal(snapshot.dropped, 1);
});

test('trip update answers are capped in trips', () => {
  const rows = Array.from({ length: RAIL_UPDATES_MAX_TRIPS + 2 }, (_, i) => [
    `t${i}`,
    'CR-Lowell',
    0,
  ]);
  const snapshot = buildRailTripUpdatesSnapshot(
    getRailFeed('mbta-rail'),
    encodeTripUpdates(rows),
  );
  assert.equal(snapshot.count, RAIL_UPDATES_MAX_TRIPS);
  assert.equal(snapshot.truncated, true);
  assert.equal(snapshot.dropped, 0, 'capped trips are rail, not dropped');
});

test('/updates resolves only for feeds that publish trip updates', () => {
  assert.equal(resolveRailRoute('/updates/mbta-rail')?.route, 'updates');
  assert.equal(resolveRailRoute('/updates/marc')?.feed?.id, 'marc');
  assert.equal(resolveRailRoute('/updates/irish-rail'), null, 'no updates');
  assert.equal(resolveRailRoute('/updates/capmetro-rail'), null);
  assert.equal(resolveRailRoute('/updates/vre'), null, 'not registered');
  assert.equal(resolveRailRoute('/updates/mbta-rail/x'), null);
});

test('feed windows: own interval when set, a floor, and per-route defaults', () => {
  assert.equal(railFeedTtlMs(getRailFeed('mbta-rail')), 15_000);
  assert.equal(railFeedTtlMs(getRailFeed('mbta-rail'), 'updates'), 30_000);
  assert.equal(railFeedTtlMs(getRailFeed('irish-rail')), 30_000);
  assert.equal(railFeedTtlMs(getRailFeed('adelaide-metro'), 'updates'), 60_000);
  assert.equal(railFeedTtlMs({ pollIntervalMs: 10 }), 5_000);
  assert.equal(railMaxBodyBytes(getRailFeed('irish-rail')), 1024 * 1024);
  assert.equal(railMaxBodyBytes(getRailFeed('mbta-rail')), 8 * 1024 * 1024);
  assert.equal(railCacheStateFor(null, 0), 'none');
  assert.equal(railCacheStateFor({ at: 0 }, 29_000, 30_000), 'fresh');
  assert.equal(railCacheStateFor({ at: 0 }, 31_000, 30_000), 'stale');
  assert.equal(railCacheStateFor({ at: 0 }, 11 * 60_000, 30_000), 'expired');
});

test('response headers follow the feed window', () => {
  assert.match(
    railResponseHeaders('MISS', 'h', null, 60_000)['Cache-Control'],
    /max-age=60/,
  );
  // An older snapshot is kept downstream only for the rest of its window.
  const maxAge = (ageMs) =>
    railResponseHeaders('HIT', 'h', null, 60_000, ageMs)['Cache-Control'];
  assert.equal(maxAge(45_000), 'public, max-age=15');
  assert.equal(maxAge(59_200), 'public, max-age=1');
  assert.equal(maxAge(60_000), 'public, max-age=0');
  assert.equal(maxAge(-5), 'public, max-age=60', 'a clock step is no age');
});

test('/schedule resolves for every pollable feed', () => {
  assert.equal(resolveRailRoute('/schedule/ktmb')?.route, 'schedule');
  assert.equal(
    resolveRailRoute('/schedule/irish-rail')?.feed?.id,
    'irish-rail',
  );
  assert.equal(resolveRailRoute('/schedule/mbta-rail')?.route, 'schedule');
  assert.equal(resolveRailRoute('/schedule/vre'), null, 'not registered');
  assert.equal(resolveRailRoute('/schedule/ktmb/x'), null);
  assert.equal(resolveRailRoute('/schedule/..%2Fktmb'), null);
});

test('the global admission cap scales with the registry', () => {
  const natural = railNaturalRequestsPerMinute();
  const cap = railAdmissionGlobalMax();
  assert.ok(natural > 40, 'the registry outgrew the old fixed cap');
  assert.ok(
    cap >= natural * 1.5,
    'room for retries on top of the natural load',
  );
  assert.equal(railAdmissionGlobalMax([]), 40, 'never below the Transit floor');
  const one = [{ defaultEnabled: true, url: 'https://x.test/vp' }];
  assert.equal(railNaturalRequestsPerMinute(one), 4, 'one feed at 15 s');
  const updatesOnly = [
    { defaultEnabled: true, tripUpdatesUrl: 'https://x.test/tu' },
  ];
  assert.equal(railNaturalRequestsPerMinute(updatesOnly), 2, 'no positions');
  assert.equal(
    railNaturalRequestsPerMinute([{ ...one[0], defaultEnabled: false }]),
    0,
  );
});

/** Vehicles with a trip id and no route or time, as Renfe sends them. */
function encodeRenfeLike(headerTime, trips) {
  const writer = new PbfWriter();
  const header = new PbfWriter();
  header.writeStringField(1, '2.0');
  header.writeVarintField(3, headerTime);
  writer.writeBytesField(1, header.finish());
  for (const [id, tripId, route] of trips) {
    const entity = new PbfWriter();
    entity.writeStringField(1, id);
    const vehicle = new PbfWriter();
    const trip = new PbfWriter();
    trip.writeStringField(1, tripId);
    if (route) trip.writeStringField(5, route);
    vehicle.writeBytesField(1, trip.finish());
    const position = new PbfWriter();
    position.writeFloatField(1, 40.4);
    position.writeFloatField(2, -3.7);
    vehicle.writeBytesField(2, position.finish());
    const descriptor = new PbfWriter();
    descriptor.writeStringField(1, id);
    vehicle.writeBytesField(8, descriptor.finish());
    entity.writeBytesField(4, vehicle.finish());
    writer.writeBytesField(2, entity.finish());
  }
  return writer.finish();
}

test('a feed with an untrusted header clock stamps its trains with the fetch time', () => {
  const now = 1_794_000_000_000;
  // Renfe writes local time as UTC: the header reads an hour behind.
  const bytes = encodeRenfeLike(now / 1000 - 3600, [
    ['04192', '0419212026-11-06'],
  ]);
  const routes = new Map([['0419212026-11-06', 'ALVIA~X~1700037606GL023']]);
  const snapshot = buildRailSnapshot(
    getRailFeed('renfe-larga-distancia'),
    bytes,
    now,
    {
      routeFor: (tripId) => routes.get(tripId) ?? null,
    },
  );
  assert.equal(snapshot.count, 1);
  const [train] = snapshot.trains;
  assert.equal(train.timestampSource, 'fetch');
  assert.equal(train.timestamp, now / 1000, 'not the header time');
  assert.equal(
    snapshot.feedTimestamp,
    null,
    'the header clock is not reported',
  );
  assert.equal(
    train.routeId,
    'ALVIA~X~1700037606GL023',
    'from the schedule pack',
  );
  assert.equal(train.category, 'national');
  // A trusted feed keeps the header ladder.
  const trusted = buildRailSnapshot(
    getRailFeed('mta-metro-north'),
    encodeRenfeLike(now / 1000 - 5, [['mnr1', 't1']]),
    now,
  );
  assert.equal(trusted.trains[0].timestampSource, 'header');
});

test('a trip the schedule pack does not know is dropped, not guessed', () => {
  const snapshot = buildRailSnapshot(
    getRailFeed('renfe-larga-distancia'),
    encodeRenfeLike(1_794_000_000, [
      ['a', 'known'],
      ['b', 'unknown'],
    ]),
    1_794_000_000_000,
    { routeFor: (tripId) => (tripId === 'known' ? 'MD~S~1' : null) },
  );
  assert.deepEqual(
    snapshot.trains.map((t) => [t.id, t.category]),
    [['a', 'regional']],
  );
  assert.equal(snapshot.dropped, 1);
  // Without a lookup nothing in this feed can be classified.
  const blind = buildRailSnapshot(
    getRailFeed('renfe-larga-distancia'),
    encodeRenfeLike(1_794_000_000, [['a', 'known']]),
  );
  assert.equal(blind.count, 0);
});

test('trip updates take their route from the schedule pack too, and carry the tourist flag', () => {
  const snapshot = buildRailTripUpdatesSnapshot(
    getRailFeed('renfe-larga-distancia'),
    encodeTripUpdates([
      ['0419212026-11-06', null, 60],
      ['999', null, 0],
    ]),
    5_000,
    {
      routeFor: (tripId) =>
        tripId === '0419212026-11-06' ? 'ALVIA~X~1700037606GL023' : null,
    },
  );
  assert.deepEqual(
    snapshot.trips.map((t) => [t.tripId, t.routeId, t.category]),
    [['0419212026-11-06', 'ALVIA~X~1700037606GL023', 'national']],
  );
  assert.equal(snapshot.dropped, 1, 'the trip the pack does not know');
  const flam = buildRailSnapshot(
    getRailFeed('entur-vy'),
    encodeFeed({ entities: [{ id: 'flam', route: 'VYG:Line:R45' }] }),
  );
  assert.equal(flam.trains[0].tourist, true);
  assert.equal(flam.trains[0].category, 'regional');
});
