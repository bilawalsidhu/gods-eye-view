// src/data/gtfsRtDecode.test.mjs — hand-rolled GTFS-RT protobuf decoder.
//
// Pins against a real captured MBTA VehiclePositions.pb feed (47 KB) so any
// drift from the spec is caught at decode time, not by a missing bus on the
// globe. Also pins synthetic hand-crafted fixtures for varint / float32 /
// nested-message edges the live feed may not exercise (truncated strings,
// missing optional fields).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { decodeGtfsRtFeed } from './gtfsRtDecode.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(__dirname, 'fixtures');

// The tiny hand-rolled protobuf encoder lives in the shared test-support
// module so the transitVehicles lifecycle suite can synthesize multi-feed
// fixtures without duplicating the wire-format writers here.
import { encodeFeed } from './gtfsRtTestEncode.mjs';

test('decodeGtfsRtFeed: live MBTA feed parses to non-empty vehicles with positions', () => {
  const bytes = readFileSync(resolve(FIXTURES, 'mbta-vehicle-positions.pb'));
  const feed = decodeGtfsRtFeed(bytes);
  assert.equal(feed.header.gtfsRealtimeVersion, '2.0');
  assert.ok(feed.entities.length > 100,
    `MBTA feed should expose hundreds of vehicles; got ${feed.entities.length}`);

  const withPos = feed.entities.filter((e) => e.vehicle?.position?.latitude != null);
  assert.ok(withPos.length === feed.entities.length,
    'every MBTA vehicle should expose a position');

  for (const entity of withPos) {
    const { latitude, longitude } = entity.vehicle.position;
    assert.ok(Math.abs(latitude) <= 90, `lat out of range: ${latitude}`);
    assert.ok(Math.abs(longitude) <= 180, `lon out of range: ${longitude}`);
    // Boston-area feed: all positions should be in the greater Boston bbox.
    assert.ok(latitude > 41 && latitude < 43, `lat outside Boston: ${latitude}`);
    assert.ok(longitude > -72 && longitude < -70, `lon outside Boston: ${longitude}`);
  }
});

test('decodeGtfsRtFeed: route distribution shows heavy rail + bus + commuter rail', () => {
  const bytes = readFileSync(resolve(FIXTURES, 'mbta-vehicle-positions.pb'));
  const feed = decodeGtfsRtFeed(bytes);
  const routes = new Set();
  for (const e of feed.entities) {
    if (e.vehicle?.trip?.routeId) routes.add(e.vehicle.trip.routeId);
  }
  // Heavy rail
  for (const line of ['Red', 'Orange', 'Blue']) {
    assert.ok(routes.has(line), `expected heavy-rail line ${line} in feed`);
  }
  // Green line branches
  let greenCount = 0;
  for (const r of routes) if (r.startsWith('Green-')) greenCount++;
  assert.ok(greenCount >= 1, `expected ≥1 Green branch, got ${greenCount}`);
  // Commuter rail
  const crCount = [...routes].filter((r) => r.startsWith('CR-')).length;
  assert.ok(crCount >= 5, `expected ≥5 commuter-rail lines, got ${crCount}`);
});

test('decodeGtfsRtFeed: synthetic feed round-trips a minimal vehicle with float lat/lon', () => {
  const bytes = encodeFeed({
    header: { version: '2.0' },
    entity: {
      id: 'bus-42',
      vehicle: {
        trip: { routeId: 'Red' },
        position: { lat: 42.34957, lon: -71.07914, bearing: 90.0, speed: 12.5 },
      },
    },
  });
  const feed = decodeGtfsRtFeed(bytes);
  assert.equal(feed.header.gtfsRealtimeVersion, '2.0');
  assert.equal(feed.entities.length, 1);
  assert.equal(feed.entities[0].id, 'bus-42');
  assert.equal(feed.entities[0].vehicle.trip.routeId, 'Red');
  // Float32 round-trips with ~6 decimal digits of precision; require close.
  assert.ok(Math.abs(feed.entities[0].vehicle.position.latitude - 42.34957) < 1e-5);
  assert.ok(Math.abs(feed.entities[0].vehicle.position.longitude - -71.07914) < 1e-5);
  assert.equal(feed.entities[0].vehicle.position.bearing, 90.0);
  assert.equal(feed.entities[0].vehicle.position.speed, 12.5);
});

test('decodeGtfsRtFeed: missing optional fields resolve to null, not undefined', () => {
  const bytes = encodeFeed({
    header: { version: '2.0' },
    entity: { id: 'train-1' }, // no vehicle submessage
  });
  const feed = decodeGtfsRtFeed(bytes);
  assert.equal(feed.entities[0].id, 'train-1');
  assert.equal(feed.entities[0].vehicle, null);
});

test('decodeGtfsRtFeed: header.timestamp is read as a varint', () => {
  const bytes = encodeFeed({
    header: { version: '2.0', timestamp: 1789782957 },
  });
  const feed = decodeGtfsRtFeed(bytes);
  assert.equal(feed.header.timestamp, 1789782957);
});

// Raw wire-format builders for the fields gtfsRtTestEncode.mjs deliberately
// cannot express: unknown field numbers and the skip-only submessages
// (TripUpdate / Alert / odometer) the decoder must step over by length.
const wireVarint = (value) => {
  const out = [];
  let rest = value;
  while (rest >= 0x80) { out.push((rest & 0x7f) | 0x80); rest >>>= 7; }
  out.push(rest);
  return out;
};
const wireTag = (fieldNum, wireType) => wireVarint((fieldNum << 3) | wireType);
const wireVarintField = (fieldNum, value) => [...wireTag(fieldNum, 0), ...wireVarint(value)];
const wireLenField = (fieldNum, bytes) => [...wireTag(fieldNum, 2), ...wireVarint(bytes.length), ...bytes];
const wireTextField = (fieldNum, text) => wireLenField(fieldNum, [...new TextEncoder().encode(text)]);
const wireFixed64Field = (fieldNum) => [...wireTag(fieldNum, 1), 1, 2, 3, 4, 5, 6, 7, 8];
const wireFixed32Field = (fieldNum) => [...wireTag(fieldNum, 5), 1, 2, 3, 4];

test('decodeGtfsRtFeed: unknown top-level and header fields are skipped without desyncing the cursor', () => {
  // A spec bump adds fields this decoder has never heard of. Every wire type
  // GTFS-RT uses must be stepped over by its declared length so the entity that
  // follows still decodes — one byte of cursor drift here silently drops buses.
  const bytes = new Uint8Array([
    ...wireVarintField(3, 0x1234),                          // unknown varint
    ...wireFixed64Field(4),                                 // unknown fixed64
    ...wireFixed32Field(5),                                 // unknown fixed32
    ...wireLenField(6, [...wireVarintField(1, 7)]),         // unknown length-delimited
    ...wireLenField(1, [                                    // FeedHeader
      ...wireTextField(1, '2.0'),
      ...wireVarintField(9, 99),                            // unknown header field
      ...wireFixed64Field(10),                              // unknown header fixed64
    ]),
    ...wireLenField(2, [                                    // FeedEntity
      ...wireTextField(1, 'bus-skipped'),
    ]),
  ]);

  const feed = decodeGtfsRtFeed(bytes);
  assert.equal(feed.header.gtfsRealtimeVersion, '2.0', 'the header survived the unknown fields');
  assert.equal(feed.header.timestamp, null, 'no timestamp was invented for an absent field');
  assert.equal(feed.entities.length, 1, 'the entity after the unknown fields still decodes');
  assert.equal(feed.entities[0].id, 'bus-skipped');
});

test('decodeGtfsRtFeed: trip_update and alert blobs are skipped wholesale, vehicle still decodes', () => {
  // Vehicle tracking consumes only the VehiclePosition half of a FeedEntity.
  // The skip is by declared length, so the vehicle submessage placed AFTER the
  // blobs is the proof the skip landed exactly.
  const vehicleBytes = [
    ...wireLenField(1, [...wireTextField(5, 'Green-B')]),   // VehiclePosition.trip
    ...wireLenField(2, [                                    // VehiclePosition.position
      ...wireTag(1, 5), ...float32Bytes(42.35),
      ...wireTag(2, 5), ...float32Bytes(-71.06),
    ]),
  ];
  const bytes = new Uint8Array([
    ...wireLenField(2, [
      ...wireTextField(1, 'train-7'),
      ...wireVarintField(2, 1),                                         // is_deleted (varint)
      ...wireLenField(3, [...wireTextField(1, 'a trip update blob')]),  // TripUpdate
      ...wireLenField(5, [...wireTextField(1, 'an alert blob')]),       // Alert
      ...wireLenField(4, vehicleBytes),                                 // VehiclePosition
    ]),
  ]);

  const feed = decodeGtfsRtFeed(bytes);
  assert.equal(feed.entities.length, 1);
  const [entity] = feed.entities;
  assert.equal(entity.id, 'train-7');
  assert.equal(entity.tripUpdate, null, 'TripUpdate is never materialized');
  assert.equal(entity.alert, null, 'Alert is never materialized');
  assert.equal(entity.vehicle.trip.routeId, 'Green-B', 'the vehicle after the blobs decoded');
  assert.ok(Math.abs(entity.vehicle.position.latitude - 42.35) < 1e-5);
});

/** Little-endian IEEE-754 float32 bytes, matching the wire encoding of lat/lon. */
function float32Bytes(value) {
  const view = new DataView(new ArrayBuffer(4));
  view.setFloat32(0, value, true);
  return [...new Uint8Array(view.buffer)];
}

test('decodeGtfsRtFeed: VehiclePosition exposes stopId, currentStatus, timestamp and occupancyStatus', () => {
  const bytes = new Uint8Array([
    ...wireLenField(2, [
      ...wireTextField(1, 'bus-full'),
      ...wireLenField(4, [
        ...wireTextField(4, 'place-clarel'),                 // stopId
        ...wireVarintField(3, 12),                           // currentStopSequence
        ...wireVarintField(5, 1),                            // currentStatus = STOPPED_AT
        ...wireVarintField(6, 1_789_782_957),                // timestamp
        ...wireVarintField(7, 4),                            // occupancyStatus
        ...wireVarintField(11, 5),                           // unknown vehicle field
      ]),
    ]),
  ]);

  const vehicle = decodeGtfsRtFeed(bytes).entities[0].vehicle;
  assert.equal(vehicle.stopId, 'place-clarel');
  assert.equal(vehicle.currentStopSequence, 12);
  assert.equal(vehicle.currentStatus, 1);
  assert.equal(vehicle.timestamp, 1_789_782_957);
  assert.equal(vehicle.occupancyStatus, 4);
  assert.equal(vehicle.trip, null, 'an absent trip descriptor stays null');
});

test('decodeGtfsRtFeed: position odometer (fixed64) and unknown position fields are skipped', () => {
  const bytes = new Uint8Array([
    ...wireLenField(2, [
      ...wireTextField(1, 'bus-odo'),
      ...wireLenField(4, [
        ...wireLenField(2, [                                 // Position
          ...wireTag(4, 1), 1, 2, 3, 4, 5, 6, 7, 8,          // odometer, wire type 1
          ...wireVarintField(9, 3),                          // unknown position varint
          ...wireTag(1, 5), ...float32Bytes(42.34),
          ...wireTag(2, 5), ...float32Bytes(-71.07),
        ]),
      ]),
    ]),
  ]);

  const position = decodeGtfsRtFeed(bytes).entities[0].vehicle.position;
  assert.ok(Math.abs(position.latitude - 42.34) < 1e-5, 'lat decoded after the 8-byte skip');
  assert.ok(Math.abs(position.longitude - -71.07) < 1e-5, 'lon decoded after the 8-byte skip');
  assert.equal(position.bearing, null);
  assert.equal(position.speed, null);
});

test('decodeGtfsRtFeed: position with only lat/lon leaves bearing/speed null', () => {
  const bytes = encodeFeed({
    entity: {
      id: 'bus-1',
      vehicle: {
        position: { lat: 42.34, lon: -71.07 },
      },
    },
  });
  const feed = decodeGtfsRtFeed(bytes);
  assert.equal(feed.entities[0].vehicle.position.bearing, null);
  assert.equal(feed.entities[0].vehicle.position.speed, null);
  assert.ok(Math.abs(feed.entities[0].vehicle.position.latitude - 42.34) < 1e-5);
  assert.ok(Math.abs(feed.entities[0].vehicle.position.longitude - -71.07) < 1e-5);
});
