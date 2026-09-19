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
