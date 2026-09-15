import test from 'node:test';
import assert from 'node:assert/strict';
import { PbfWriter } from 'pbf';
import {
  decodeFeedMessage,
  decodeVehiclePositions,
  isPlausibleVehiclePosition,
  normalizeVehicleEntity,
} from './gtfsRealtime.js';

/** Encode a nested message with a fresh writer and embed it as a bytes field. */
function embed(writer, tag, build) {
  const inner = new PbfWriter();
  build(inner);
  writer.writeBytesField(tag, inner.finish());
}

/**
 * Hand-encode one FeedEntity carrying a VehiclePosition, from the proto field
 * numbers — the same contract the decoder reads, written independently.
 */
function writeVehicleEntity(
  writer,
  {
    entityId,
    vehicleId,
    label,
    lat,
    lon,
    bearing,
    speed,
    timestamp,
    routeId,
    tripId,
    directionId,
    stopId,
    status,
    occupancy,
    isDeleted,
    extraUnknownFields = false,
  },
) {
  embed(writer, 2, (entity) => {
    if (entityId != null) entity.writeStringField(1, entityId);
    if (isDeleted) entity.writeBooleanField(2, true);
    embed(entity, 4, (vehicle) => {
      if (routeId != null || tripId != null || directionId != null) {
        embed(vehicle, 1, (trip) => {
          if (tripId != null) trip.writeStringField(1, tripId);
          if (routeId != null) trip.writeStringField(5, routeId);
          if (directionId != null) trip.writeVarintField(6, directionId);
        });
      }
      if (lat != null) {
        embed(vehicle, 2, (position) => {
          position.writeFloatField(1, lat);
          position.writeFloatField(2, lon);
          if (bearing != null) position.writeFloatField(3, bearing);
          if (speed != null) position.writeFloatField(5, speed);
          if (extraUnknownFields) position.writeDoubleField(4, 123456.5); // odometer
        });
      }
      if (status != null) vehicle.writeVarintField(4, status);
      if (timestamp != null) vehicle.writeVarintField(5, timestamp);
      if (stopId != null) vehicle.writeStringField(7, stopId);
      if (vehicleId != null || label != null) {
        embed(vehicle, 8, (descriptor) => {
          if (vehicleId != null) descriptor.writeStringField(1, vehicleId);
          if (label != null) descriptor.writeStringField(2, label);
        });
      }
      if (occupancy != null) vehicle.writeVarintField(9, occupancy);
      if (extraUnknownFields)
        vehicle.writeStringField(1001, 'operator-extension');
    });
  });
}

function encodeFeed(
  entities,
  { version = '2.0', timestamp = 1_788_936_000 } = {},
) {
  const writer = new PbfWriter();
  embed(writer, 1, (header) => {
    header.writeStringField(1, version);
    header.writeVarintField(2, 0);
    header.writeVarintField(3, timestamp);
  });
  for (const entity of entities) writeVehicleEntity(writer, entity);
  return writer.finish();
}

test('decodes header and every VehiclePosition field the layer renders', () => {
  const bytes = encodeFeed([
    {
      entityId: 'e1',
      vehicleId: 'bus-17',
      label: '1557',
      lat: 44.927551,
      lon: -93.386711,
      bearing: 248,
      speed: 11.2,
      timestamp: 1_788_936_945,
      routeId: '17',
      tripId: '1134773',
      directionId: 0,
      stopId: '57458',
      status: 1,
      occupancy: 2,
    },
  ]);
  const snapshot = decodeVehiclePositions(bytes);
  assert.equal(snapshot.version, '2.0');
  assert.equal(snapshot.timestamp, 1_788_936_000);
  assert.equal(snapshot.entityCount, 1);
  assert.equal(snapshot.vehicles.length, 1);
  const [v] = snapshot.vehicles;
  assert.equal(v.id, 'bus-17');
  assert.equal(v.label, '1557');
  assert.ok(Math.abs(v.lat - 44.927551) < 1e-5);
  assert.ok(Math.abs(v.lon + 93.386711) < 1e-5);
  assert.equal(v.bearing, 248);
  assert.ok(Math.abs(v.speedMps - 11.2) < 1e-5);
  assert.equal(v.timestamp, 1_788_936_945);
  assert.equal(v.routeId, '17');
  assert.equal(v.tripId, '1134773');
  assert.equal(v.directionId, 0);
  assert.equal(v.stopId, '57458');
  assert.equal(v.status, 'STOPPED_AT');
  assert.equal(v.occupancy, 'FEW_SEATS_AVAILABLE');
});

test('unknown and extension fields are skipped, not misread', () => {
  const bytes = encodeFeed([
    { entityId: 'x', lat: 51.3, lon: 5.33, extraUnknownFields: true },
  ]);
  const snapshot = decodeVehiclePositions(bytes);
  assert.equal(snapshot.vehicles.length, 1);
  assert.equal(snapshot.vehicles[0].id, 'x');
  assert.ok(Math.abs(snapshot.vehicles[0].lat - 51.3) < 1e-5);
});

test('entities without a usable position are dropped and never throw', () => {
  const bytes = encodeFeed([
    { entityId: 'no-position' },
    { entityId: 'deleted', lat: 1, lon: 1, isDeleted: true },
    { entityId: 'null-island', lat: 0, lon: 0 },
    { entityId: 'out-of-range', lat: 91, lon: 10 },
    { entityId: 'nan', lat: Number.NaN, lon: 10 },
    { entityId: 'keeper', lat: 60.17, lon: 24.94 },
  ]);
  const snapshot = decodeVehiclePositions(bytes);
  assert.equal(snapshot.entityCount, 6);
  assert.deepEqual(
    snapshot.vehicles.map((v) => v.id),
    ['keeper'],
  );
});

test('vehicle id falls back to the entity id and the vehicle is dropped when neither exists', () => {
  const bytes = encodeFeed([
    { entityId: 'entity-only', lat: 42.3, lon: -71.1 },
    { lat: 42.3, lon: -71.1 },
  ]);
  const snapshot = decodeVehiclePositions(bytes);
  assert.deepEqual(
    snapshot.vehicles.map((v) => v.id),
    ['entity-only'],
  );
});

test('duplicate vehicle ids keep the newest timestamp', () => {
  const bytes = encodeFeed([
    { entityId: 'a', vehicleId: 'v1', lat: 42.3, lon: -71.1, timestamp: 100 },
    { entityId: 'b', vehicleId: 'v1', lat: 42.31, lon: -71.11, timestamp: 200 },
    { entityId: 'c', vehicleId: 'v1', lat: 42.32, lon: -71.12, timestamp: 150 },
  ]);
  const snapshot = decodeVehiclePositions(bytes);
  assert.equal(snapshot.vehicles.length, 1);
  assert.equal(snapshot.vehicles[0].timestamp, 200);
  assert.ok(Math.abs(snapshot.vehicles[0].lat - 42.31) < 1e-5);
});

test('bearing is normalized to [0, 360) and negative speed is treated as unknown', () => {
  const bytes = encodeFeed([
    { entityId: 'neg', lat: 30.2, lon: -97.7, bearing: -90, speed: -1 },
    { entityId: 'wrap', lat: 30.2, lon: -97.7, bearing: 450 },
  ]);
  const [neg, wrap] = decodeVehiclePositions(bytes).vehicles;
  assert.equal(neg.bearing, 270);
  assert.equal(neg.speedMps, null);
  assert.equal(wrap.bearing, 90);
});

test('missing header yields null version/timestamp rather than garbage', () => {
  const writer = new PbfWriter();
  writeVehicleEntity(writer, { entityId: 'solo', lat: 10, lon: 10 });
  const snapshot = decodeVehiclePositions(writer.finish());
  assert.equal(snapshot.version, null);
  assert.equal(snapshot.timestamp, null);
  assert.equal(snapshot.vehicles.length, 1);
});

test('decodeFeedMessage accepts an ArrayBuffer and an empty feed', () => {
  const empty = decodeFeedMessage(new ArrayBuffer(0));
  assert.deepEqual(empty, { header: {}, entities: [] });
  const bytes = encodeFeed([]);
  const asBuffer = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  );
  assert.equal(decodeFeedMessage(asBuffer).header.version, '2.0');
});

test('isPlausibleVehiclePosition and normalizeVehicleEntity guard their inputs', () => {
  assert.equal(isPlausibleVehiclePosition(45, 90), true);
  assert.equal(isPlausibleVehiclePosition(0, 0), false);
  assert.equal(isPlausibleVehiclePosition(-90.0001, 0), false);
  assert.equal(isPlausibleVehiclePosition(1, Infinity), false);
  assert.equal(normalizeVehicleEntity(null), null);
  assert.equal(normalizeVehicleEntity({ id: 'no-vehicle' }), null);
  assert.equal(
    normalizeVehicleEntity({
      id: 'v',
      vehicle: { position: { latitude: 1, longitude: 2 }, currentStatus: 99 },
    })?.status,
    null,
  );
});
