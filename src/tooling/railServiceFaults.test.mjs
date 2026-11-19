/**
 * The rail service under upstream faults and missing build output: an empty
 * or non-protobuf 200, a pack-routed feed without its pack, and a
 * downstream cache near the end of a window.

 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { PbfWriter } from 'pbf';
import { createRailService } from '../sources/railService.js';
import { RAIL_FEED_REGISTRY, getRailFeed } from '../data/railFeeds.js';

const request = (path) => ({
  url: `https://example.test${path}`,
  method: 'GET',
});

function quietWarnings(t) {
  const warn = console.warn;
  console.warn = () => {};
  t.after(() => {
    console.warn = warn;
  });
}

/** A full-dataset VehiclePositions message: one MBTA commuter train. */
function positionsBytes() {
  const writer = new PbfWriter();
  const header = new PbfWriter();
  header.writeStringField(1, '2.0');
  header.writeVarintField(3, 1_800_000_000);
  writer.writeBytesField(1, header.finish());
  const entity = new PbfWriter();
  entity.writeStringField(1, 'cr');
  const vehicle = new PbfWriter();
  const trip = new PbfWriter();
  trip.writeStringField(5, 'CR-Providence');
  vehicle.writeBytesField(1, trip.finish());
  const position = new PbfWriter();
  position.writeFloatField(1, 42.3);
  position.writeFloatField(2, -71.1);
  vehicle.writeBytesField(2, position.finish());
  const descriptor = new PbfWriter();
  descriptor.writeStringField(1, 'cr');
  vehicle.writeBytesField(8, descriptor.finish());
  entity.writeBytesField(4, vehicle.finish());
  writer.writeBytesField(2, entity.finish());
  return writer.finish();
}

/** A full-dataset TripUpdates message with the given trip ids. */
function tripUpdatesBytes(tripIds) {
  const writer = new PbfWriter();
  const header = new PbfWriter();
  header.writeStringField(1, '2.0');
  header.writeVarintField(3, 1_800_000_000);
  writer.writeBytesField(1, header.finish());
  for (const tripId of tripIds) {
    const descriptor = new PbfWriter();
    descriptor.writeStringField(1, tripId);
    descriptor.writeStringField(3, '20270115');
    const update = new PbfWriter();
    update.writeBytesField(1, descriptor.finish());
    update.writeVarintField(5, 60);
    const entity = new PbfWriter();
    entity.writeStringField(1, tripId);
    entity.writeBytesField(3, update.finish());
    writer.writeBytesField(2, entity.finish());
  }
  return writer.finish();
}

test('an empty 200 or 204 never replaces the last good snapshot', async (t) => {
  quietWarnings(t);
  let now = 1_800_000_000_000;
  let answer = () => new Response(positionsBytes(), { status: 200 });
  let calls = 0;
  const service = createRailService({
    now: () => now,
    fetchImpl: async () => {
      calls += 1;
      return answer();
    },
  });
  t.after(service.close);
  const path = '/api/rail/trains/mbta-rail';
  const good = await service.handle(request(path));
  assert.equal(good.headers.get('X-GEV-Cache'), 'MISS');
  const goodBody = await good.text();
  for (const empty of [
    () => new Response(new Uint8Array(0), { status: 200 }),
    () => new Response(null, { status: 204 }),
  ]) {
    answer = empty;
    now += 16_000;
    const stale = await service.handle(request(path));
    assert.equal(stale.status, 200);
    assert.equal(stale.headers.get('X-GEV-Cache'), 'STALE-ERROR');
    assert.equal(await stale.text(), goodBody, 'the good snapshot, kept');
    // The failure is on the ladder: the next ask does not reach upstream.
    const before = calls;
    const held = await service.handle(request(path));
    assert.equal(held.headers.get('X-GEV-Cache'), 'STALE-ERROR');
    assert.equal(calls, before);
  }
  // A healthy answer takes over again.
  answer = () => new Response(positionsBytes(), { status: 200 });
  now += 61_000;
  const back = await service.handle(request(path));
  assert.equal(back.headers.get('X-GEV-Cache'), 'MISS');
  assert.equal((await back.json()).count, 1);
});

test('an error page served as 200 is an upstream fault (502), not a timeout', async (t) => {
  quietWarnings(t);
  for (const [route, body] of [
    ['trains', '<!DOCTYPE html><html><body>Service Unavailable</body></html>'],
    ['trains', '{"error":"quota exceeded"}'],
    ['updates', '<html>maintenance</html>'],
    ['updates', ''],
  ]) {
    const service = createRailService({
      fetchImpl: async () =>
        new Response(body, {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }),
    });
    const response = await service.handle(
      request(`/api/rail/${route}/mbta-rail`),
    );
    service.close();
    assert.equal(response.status, 502, `${route}: ${body}`);
    assert.equal((await response.json()).error, 'Rail feed unavailable');
  }
});

test('a pack-routed feed names its trip updates from the pack, and is unavailable without it', async (t) => {
  quietWarnings(t);
  // Every pack-routed feed with trip updates (Renfe long distance): its
  // updates carry no route, so they are classified by the pack's trips.
  const feeds = RAIL_FEED_REGISTRY.filter(
    (feed) =>
      feed.routesFrom === 'schedule' && typeof feed.tripUpdatesUrl === 'string',
  );
  assert.ok(feeds.length >= 1, 'Renfe long distance at least');
  for (const registered of feeds) {
    const id = registered.id;
    if (!getRailFeed(id)) continue;
    const service = createRailService({
      fetchImpl: async () =>
        new Response(tripUpdatesBytes(['in-pack', 'elsewhere']), {
          status: 200,
        }),
      readSchedulePack: async (feedId) =>
        feedId === id
          ? JSON.stringify({
              version: 1,
              feedId: id,
              trips: { 'in-pack': { route: 'ALVIA~X~1700037606GL023' } },
            })
          : null,
      hasSchedulePack: async () => true,
    });
    try {
      const response = await service.handle(request(`/api/rail/updates/${id}`));
      assert.equal(response.status, 200, id);
      const body = await response.json();
      assert.deepEqual(
        body.trips.map((trip) => [trip.tripId, trip.routeId]),
        [['in-pack', 'ALVIA~X~1700037606GL023']],
        id,
      );
      assert.equal(body.dropped, 1, `${id}: the trip the pack does not know`);
      assert.equal(body.entityCount, 2, id);
      assert.equal(body.skipped, undefined, 'every trip is decoded');
    } finally {
      service.close();
    }
    // Listed, but the pack is gone when read: unavailable, not empty.
    const bare = createRailService({
      fetchImpl: async () =>
        new Response(tripUpdatesBytes(['in-pack', 'elsewhere']), {
          status: 200,
        }),
      readSchedulePack: async () => null,
      hasSchedulePack: async () => true,
    });
    try {
      const response = await bare.handle(request(`/api/rail/updates/${id}`));
      assert.equal(response.status, 503, id);
      assert.equal((await response.json()).error, 'Rail schedule unavailable');
    } finally {
      bare.close();
    }
  }
});

test('a HIT is cached downstream only for what is left of its window', async (t) => {
  let now = 1_800_000_000_000;
  const service = createRailService({
    now: () => now,
    fetchImpl: async () => new Response(positionsBytes(), { status: 200 }),
  });
  t.after(service.close);
  const path = '/api/rail/trains/mbta-rail';
  const maxAge = async () =>
    (await service.handle(request(path))).headers.get('cache-control');
  assert.equal(await maxAge(), 'public, max-age=15');
  now += 10_000;
  assert.equal(await maxAge(), 'public, max-age=5');
  now += 4_500;
  assert.equal(await maxAge(), 'public, max-age=1');
});
