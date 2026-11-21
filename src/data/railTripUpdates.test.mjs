import test from 'node:test';
import assert from 'node:assert/strict';
import { PbfWriter } from 'pbf';
import { GTFS_MAX_ENTITIES } from './gtfsRealtime.js';
import {
  RAIL_TRIP_UPDATE_MAX_STOPS,
  RAIL_TRIP_UPDATE_MAX_TRIPS,
  decodeTripUpdates,
  normalizeTripUpdateEntity,
} from './railTripUpdates.js';

const NOW_S = 1_794_000_000;

function event(writer, tag, { delay, time } = {}) {
  const message = new PbfWriter();
  if (delay !== undefined) message.writeVarintField(1, delay);
  if (time !== undefined) message.writeVarintField(2, time);
  writer.writeBytesField(tag, message.finish());
}

/**
 * A FeedMessage with trip updates. Each trip:
 * `{id, tripId, routeId, startDate, delay, relationship, vehicleId, stops}`,
 * each stop `{stopId, sequence, arrival, departure, relationship}`.
 */
function encodeTripUpdates({ incrementality = null, trips = [], extra = [] }) {
  const writer = new PbfWriter();
  const header = new PbfWriter();
  header.writeStringField(1, '2.0');
  if (incrementality !== null) header.writeVarintField(2, incrementality);
  header.writeVarintField(3, NOW_S);
  writer.writeBytesField(1, header.finish());
  for (const trip of trips) {
    const entity = new PbfWriter();
    entity.writeStringField(1, trip.id ?? trip.tripId ?? 'e');
    if (trip.deleted) entity.writeBooleanField(2, true);
    const update = new PbfWriter();
    const descriptor = new PbfWriter();
    if (trip.tripId) descriptor.writeStringField(1, trip.tripId);
    if (trip.startDate) descriptor.writeStringField(3, trip.startDate);
    if (trip.relationship !== undefined)
      descriptor.writeVarintField(4, trip.relationship);
    if (trip.routeId) descriptor.writeStringField(5, trip.routeId);
    update.writeBytesField(1, descriptor.finish());
    for (const stop of trip.stops || []) {
      const stu = new PbfWriter();
      if (stop.sequence !== undefined) stu.writeVarintField(1, stop.sequence);
      if (stop.arrival) event(stu, 2, stop.arrival);
      if (stop.departure) event(stu, 3, stop.departure);
      if (stop.stopId) stu.writeStringField(4, stop.stopId);
      if (stop.relationship !== undefined)
        stu.writeVarintField(5, stop.relationship);
      update.writeBytesField(2, stu.finish());
    }
    if (trip.vehicleId) {
      const vehicle = new PbfWriter();
      vehicle.writeStringField(1, trip.vehicleId);
      update.writeBytesField(3, vehicle.finish());
    }
    update.writeVarintField(4, NOW_S - 5);
    if (trip.delay !== undefined) update.writeVarintField(5, trip.delay);
    entity.writeBytesField(3, update.finish());
    writer.writeBytesField(2, entity.finish());
  }
  for (const bytes of extra) writer.writeBytesField(2, bytes);
  return writer.finish();
}

/** An entity that carries only a vehicle position (a combined feed). */
function vehicleOnlyEntity() {
  const entity = new PbfWriter();
  entity.writeStringField(1, 'veh');
  const vehicle = new PbfWriter();
  const position = new PbfWriter();
  position.writeFloatField(1, 40.7);
  position.writeFloatField(2, -73.9);
  vehicle.writeBytesField(2, position.finish());
  entity.writeBytesField(4, vehicle.finish());
  return entity.finish();
}

test('trip updates decode with stop times, signed delays and the header', () => {
  const decoded = decodeTripUpdates(
    encodeTripUpdates({
      trips: [
        {
          tripId: 'GO202_26_1959',
          routeId: '4',
          startDate: '20261106',
          vehicleId: '7171',
          stops: [
            { stopId: '179', sequence: 1, relationship: 2 },
            {
              stopId: '33',
              sequence: 2,
              arrival: { time: NOW_S + 60, delay: 58 },
              departure: { time: NOW_S + 90, delay: -45 },
            },
          ],
        },
      ],
      extra: [vehicleOnlyEntity()],
    }),
  );
  assert.equal(decoded.version, '2.0');
  assert.equal(decoded.timestamp, NOW_S);
  assert.equal(decoded.incrementality, 0);
  assert.equal(decoded.entityCount, 2, 'the vehicle entity is counted');
  assert.equal(decoded.trips.length, 1, 'but is not a trip');
  const [trip] = decoded.trips;
  assert.equal(trip.tripId, 'GO202_26_1959');
  assert.equal(trip.routeId, '4');
  assert.equal(trip.startDate, '20261106');
  assert.equal(trip.vehicleId, '7171');
  assert.equal(trip.relationship, 'SCHEDULED');
  assert.equal(trip.delaySec, 58, 'first stated stop delay');
  assert.deepEqual(trip.stops, [
    {
      stopId: '179',
      stopSequence: 1,
      arrival: null,
      departure: null,
      relationship: 'NO_DATA',
    },
    {
      stopId: '33',
      stopSequence: 2,
      arrival: { time: NOW_S + 60, delay: 58 },
      departure: { time: NOW_S + 90, delay: -45 },
    },
  ]);
});

test('a trip-level delay wins; a times-only feed reports no delay, not zero', () => {
  const decoded = decodeTripUpdates(
    encodeTripUpdates({
      trips: [
        {
          tripId: 'a',
          routeId: 'CR-Lowell',
          delay: -120,
          stops: [{ stopId: 's', arrival: { delay: 30 } }],
        },
        {
          tripId: 'b',
          routeId: 'CR-Lowell',
          stops: [{ stopId: 's', arrival: { time: NOW_S + 300 } }],
        },
        { tripId: 'c', routeId: 'CR-Lowell', relationship: 3 },
      ],
    }),
  );
  const byId = new Map(decoded.trips.map((trip) => [trip.tripId, trip]));
  assert.equal(byId.get('a').delaySec, -120);
  assert.equal(byId.get('b').delaySec, null);
  assert.deepEqual(byId.get('b').stops[0].arrival, {
    time: NOW_S + 300,
    delay: null,
  });
  assert.equal(byId.get('c').relationship, 'CANCELED');
  assert.deepEqual(byId.get('c').stops, []);
});

test('implausible values are dropped instead of carried', () => {
  const decoded = decodeTripUpdates(
    encodeTripUpdates({
      trips: [
        {
          tripId: 'x',
          routeId: 'r',
          delay: 999_999,
          stops: [
            { stopId: 'a', arrival: { time: 12, delay: 10 } },
            { stopId: 'b', arrival: { time: 9_999_999_999 } },
            { sequence: 4 },
            {},
          ],
        },
      ],
    }),
  );
  const [trip] = decoded.trips;
  assert.equal(trip.delaySec, 10, 'a delay of eleven days is not a delay');
  assert.deepEqual(trip.stops[0].arrival, { time: null, delay: 10 });
  assert.equal(trip.stops[1].arrival, null, 'a time past 2100 is no time');
  assert.equal(
    trip.stops.length,
    3,
    'a stop with no id or sequence is dropped',
  );
});

test('stops past the per-trip cap are left unread and the trip says so', () => {
  const stops = Array.from(
    { length: RAIL_TRIP_UPDATE_MAX_STOPS + 5 },
    (_, i) => ({ stopId: `s${i}`, sequence: i, arrival: { delay: 0 } }),
  );
  const [trip] = decodeTripUpdates(
    encodeTripUpdates({ trips: [{ tripId: 'long', routeId: 'r', stops }] }),
  ).trips;
  assert.equal(trip.stops.length, RAIL_TRIP_UPDATE_MAX_STOPS);
  assert.equal(trip.stopsTruncated, true);
});

test('over-long strings drop the record, deleted and empty entities are skipped', () => {
  const long = 'x'.repeat(300);
  const decoded = decodeTripUpdates(
    encodeTripUpdates({
      trips: [
        { tripId: long, routeId: 'r' },
        { tripId: 'gone', routeId: 'r', deleted: true },
        { id: 'empty' },
        {
          tripId: 'ok',
          routeId: 'r',
          stops: [{ stopId: long, sequence: 1 }, { stopId: 'fine' }],
        },
      ],
    }),
  );
  assert.deepEqual(
    decoded.trips.map((trip) => trip.tripId),
    ['ok'],
  );
  assert.deepEqual(
    decoded.trips[0].stops.map((stop) => stop.stopId),
    ['fine'],
  );
  assert.equal(normalizeTripUpdateEntity(null), null);
  assert.equal(normalizeTripUpdateEntity({ id: 'v' }), null);
});

test('every trip is decoded, up to the shared entity cap, whatever the caller asks', () => {
  // The decoder takes no per-caller filter (`keep`) or entity cap
  // (`maxEntities`): options like these change nothing.
  const trips = Array.from({ length: GTFS_MAX_ENTITIES + 1 }, (_, i) => ({
    tripId: `t${i}`,
  }));
  const decoded = decodeTripUpdates(encodeTripUpdates({ trips }), {
    keep: () => false,
    maxEntities: GTFS_MAX_ENTITIES * 2,
  });
  assert.equal(decoded.entityCount, GTFS_MAX_ENTITIES);
  assert.equal(decoded.truncated, true);
  assert.equal(
    decoded.trips.length,
    Math.min(GTFS_MAX_ENTITIES, RAIL_TRIP_UPDATE_MAX_TRIPS),
  );
  assert.equal(decoded.skipped, undefined);
  assert.equal(decoded.feedVersion, undefined);
});

test('incrementality is reported so the proxy can refuse differential feeds', () => {
  assert.equal(
    decodeTripUpdates(encodeTripUpdates({ incrementality: 1 })).incrementality,
    1,
  );
  const empty = decodeTripUpdates(new Uint8Array(0));
  assert.equal(empty.incrementality, 0);
  assert.equal(empty.timestamp, null);
  assert.deepEqual(empty.trips, []);
});
