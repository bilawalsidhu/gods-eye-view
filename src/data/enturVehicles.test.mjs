import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  decodeEnturVehicles,
  enturVehicleMode,
  normalizeEnturVehicle,
} from './enturVehicles.js';
import {
  buildTransitSnapshot,
  transitUpstreamHeaders,
} from './transitProxy.js';
import {
  getTransitFeed,
  transitFeedsInRange,
  transitModeFor,
  transitModeResolved,
} from './transitFeeds.js';

const encode = (value) => new TextEncoder().encode(JSON.stringify(value));

const vehicle = (overrides = {}) => ({
  vehicleId: '3350447613',
  mode: 'BUS',
  lastUpdatedEpochSecond: 1_791_145_000,
  bearing: 355.6,
  location: { latitude: 60.4073417466134, longitude: 5.3245 },
  line: { lineRef: 'SKY:Line:465' },
  serviceJourney: { id: 'SKY:ServiceJourney:465-202895-20955837' },
  monitoredCall: { stopPointRef: 'NSR:Quay:52078' },
  ...overrides,
});

test('an Entur vehicle flattens into the record the Transit layer renders', () => {
  assert.deepEqual(normalizeEnturVehicle(vehicle()), {
    id: '3350447613',
    lat: 60.407342,
    lon: 5.3245,
    bearing: 355.6,
    speedMps: null,
    timestamp: 1_791_145_000,
    routeId: 'SKY:Line:465',
    tripId: 'SKY:ServiceJourney:465-202895-20955837',
    directionId: null,
    label: null,
    stopId: 'NSR:Quay:52078',
    status: null,
    occupancy: null,
    mode: 'bus',
  });
});

test('vehicles without a usable position or id are dropped', () => {
  assert.equal(normalizeEnturVehicle(vehicle({ location: null })), null);
  assert.equal(
    normalizeEnturVehicle(vehicle({ location: { latitude: 0, longitude: 0 } })),
    null,
  );
  assert.equal(
    normalizeEnturVehicle(
      vehicle({ location: { latitude: 'x', longitude: 5 } }),
    ),
    null,
  );
  assert.equal(normalizeEnturVehicle(vehicle({ vehicleId: '' })), null);
  assert.equal(normalizeEnturVehicle(null), null);
});

test('Entur modes map onto the layer modes', () => {
  assert.equal(enturVehicleMode('BUS'), 'bus');
  assert.equal(enturVehicleMode('COACH'), 'bus');
  assert.equal(enturVehicleMode('TRAM'), 'tram');
  assert.equal(enturVehicleMode('METRO'), 'subway');
  assert.equal(enturVehicleMode('RAIL'), 'rail');
  assert.equal(enturVehicleMode('FERRY'), 'ferry');
  assert.equal(enturVehicleMode('AIR'), null);
  assert.equal(enturVehicleMode(undefined), null);
});

test('a response decodes to a full snapshot that keeps the newest report per vehicle', () => {
  const decoded = decodeEnturVehicles(
    encode({
      data: {
        vehicles: [
          vehicle({ lastUpdatedEpochSecond: 100 }),
          vehicle({
            lastUpdatedEpochSecond: 200,
            location: { latitude: 60.5, longitude: 5.4 },
          }),
          vehicle({ vehicleId: 'other', mode: 'FERRY' }),
          vehicle({ vehicleId: 'nowhere', location: null }),
        ],
      },
    }),
  );
  assert.equal(decoded.entityCount, 4);
  assert.equal(decoded.truncated, false);
  assert.equal(decoded.vehicles.length, 2);
  const bus = decoded.vehicles.find((v) => v.id === '3350447613');
  assert.equal(bus.timestamp, 200);
  assert.equal(bus.lat, 60.5);
  assert.equal(decoded.vehicles.find((v) => v.id === 'other').mode, 'ferry');
});

test('a GraphQL error answer fails the refresh instead of emptying the map', () => {
  assert.throws(
    () =>
      decodeEnturVehicles(encode({ errors: [{ message: 'rate limited' }] })),
    /no vehicle list: rate limited/,
  );
  assert.throws(() => decodeEnturVehicles(new TextEncoder().encode('<html>')));
});

test('the Entur feed is fetched from the v2 Vehicles API as a JSON POST', () => {
  const entur = getTransitFeed('entur-norway');
  assert.equal(entur.url, 'https://api.entur.io/realtime/v2/vehicles/graphql');
  assert.equal(entur.request.method, 'POST');
  assert.ok(JSON.parse(entur.request.body).query.includes('vehicles'));
  const headers = transitUpstreamHeaders(entur);
  assert.equal(headers.Accept, 'application/json');
  assert.equal(headers['Content-Type'], 'application/json');
  assert.equal(headers['ET-Client-Name'], 'gods-eye-view-transit');
  const mbtaHeaders = transitUpstreamHeaders(getTransitFeed('mbta'));
  assert.match(mbtaHeaders.Accept, /protobuf/);
  assert.equal('Content-Type' in mbtaHeaders, false);
});

test('the proxy snapshot for Entur carries the reported mode through', () => {
  const entur = getTransitFeed('entur-norway');
  const snapshot = buildTransitSnapshot(
    entur,
    encode({ data: { vehicles: [vehicle({ mode: 'FERRY' })] } }),
    1_791_145_010_000,
  );
  assert.equal(snapshot.count, 1);
  assert.equal(snapshot.vehicles[0].timestampSource, 'vehicle');
  const record = snapshot.vehicles[0];
  assert.equal(transitModeFor(entur, record.routeId, record.mode), 'ferry');
  assert.equal(transitModeResolved(entur, record.routeId, record.mode), true);
  // Without a reported mode the route hint still applies.
  assert.equal(transitModeFor(entur, 'VYG:Line:R10', null), 'rail');
  assert.equal(transitModeFor(entur, 'SKY:Line:465', 'unknown'), 'bus');
});

test('Entur covers the whole country, from Kristiansand to Kirkenes', () => {
  for (const [city, lat, lon] of [
    ['Kristiansand', 58.15, 8.0],
    ['Stavanger', 58.97, 5.73],
    ['Bodø', 67.28, 14.4],
    ['Hammerfest', 70.66, 23.68],
    ['Kirkenes', 69.73, 30.05],
  ]) {
    assert.ok(
      transitFeedsInRange(lat, lon).some((f) => f.id === 'entur-norway'),
      `${city} is covered by Entur`,
    );
  }
});
