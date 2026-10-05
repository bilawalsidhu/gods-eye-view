/**
 * @module gtfsRealtime
 * @description Minimal GTFS-Realtime decoder for VehiclePosition feeds.
 *
 * Decodes only what the Transit layer needs from a `FeedMessage` — the header
 * and every entity's `VehiclePosition` — straight from the protobuf wire
 * format with `pbf` (already a dependency via the TomTom flow tiles). No
 * `gtfs-realtime-bindings`, no protobufjs, no generated code: the GTFS-RT
 * schema is stable, and field numbers are the contract.
 *
 * Field numbers (gtfs-realtime.proto, v2.0):
 *   FeedMessage        1 header, 2 entity[]
 *   FeedHeader         1 gtfs_realtime_version, 2 incrementality, 3 timestamp
 *   FeedEntity         1 id, 2 is_deleted, 3 trip_update, 4 vehicle, 5 alert
 *   VehiclePosition    1 trip, 2 position, 3 current_stop_sequence,
 *                      4 current_status, 5 timestamp, 6 congestion_level,
 *                      7 stop_id, 8 vehicle, 9 occupancy_status
 *   TripDescriptor     1 trip_id, 2 start_time, 3 start_date,
 *                      4 schedule_relationship, 5 route_id, 6 direction_id
 *   Position           1 latitude, 2 longitude, 3 bearing, 4 odometer, 5 speed
 *   VehicleDescriptor  1 id, 2 label, 3 license_plate
 *
 * Unknown fields (extensions, newer additions) are skipped by pbf, so a feed
 * that carries OVapi/NYCT extensions decodes the same as a plain one.
 *
 * Decoding is bounded, because a byte cap alone does not bound what a decode
 * COSTS: entities past `GTFS_MAX_ENTITIES` are left unread so pbf skips them
 * whole (the result says it truncated), and every string field — the feed
 * header's version included — is refused past `GTFS_MAX_STRING_CHARS` rather
 * than carried into the snapshot.
 *
 * Pure: safe to import from the browser layer, the Vite proxy, and node:test.
 */

import { PbfReader } from 'pbf';

/** VehiclePosition.VehicleStopStatus enum → label. */
export const VEHICLE_STOP_STATUS = Object.freeze({
  0: 'INCOMING_AT',
  1: 'STOPPED_AT',
  2: 'IN_TRANSIT_TO',
});

/** VehiclePosition.OccupancyStatus enum → label. */
export const OCCUPANCY_STATUS = Object.freeze({
  0: 'EMPTY',
  1: 'MANY_SEATS_AVAILABLE',
  2: 'FEW_SEATS_AVAILABLE',
  3: 'STANDING_ROOM_ONLY',
  4: 'CRUSHED_STANDING_ROOM_ONLY',
  5: 'FULL',
  6: 'NOT_ACCEPTING_PASSENGERS',
  7: 'NO_DATA_AVAILABLE',
  8: 'NOT_BOARDABLE',
});

/**
 * Hard ceiling on decoded entities. Every registered feed is a metropolitan or
 * national fleet — the largest observed is a few thousand vehicles — so this is
 * two orders of magnitude above any honest payload.
 */
export const GTFS_MAX_ENTITIES = 50_000;
/** Longest accepted string field. GTFS ids, labels and stop ids are short. */
export const GTFS_MAX_STRING_CHARS = 256;
/** FeedHeader.Incrementality: only FULL_DATASET carries a complete snapshot. */
export const GTFS_INCREMENTALITY_FULL_DATASET = 0;
export const GTFS_INCREMENTALITY_DIFFERENTIAL = 1;

/**
 * Read a length-delimited string, refusing one that is implausibly long.
 * An over-long field marks its containing message `oversize`, and the whole
 * record is then dropped — never truncated. Half an id is a different vehicle,
 * not a shorter name for the same one.
 * @param {object} pbf
 * @param {object} target Message being read, flagged when the field is refused.
 * @returns {string|null}
 */
function readBoundedString(pbf, target) {
  const value = pbf.readString();
  if (value.length <= GTFS_MAX_STRING_CHARS) return value;
  target.oversize = true;
  return null;
}

function readFeedHeader(tag, header, pbf) {
  if (tag === 1) header.version = readBoundedString(pbf, header);
  else if (tag === 2) header.incrementality = pbf.readVarint();
  else if (tag === 3) header.timestamp = pbf.readVarint();
}

function readTripDescriptor(tag, trip, pbf) {
  if (tag === 1) trip.tripId = readBoundedString(pbf, trip);
  else if (tag === 2) trip.startTime = readBoundedString(pbf, trip);
  else if (tag === 3) trip.startDate = readBoundedString(pbf, trip);
  else if (tag === 4) trip.scheduleRelationship = pbf.readVarint();
  else if (tag === 5) trip.routeId = readBoundedString(pbf, trip);
  else if (tag === 6) trip.directionId = pbf.readVarint();
}

function readPosition(tag, position, pbf) {
  if (tag === 1) position.latitude = pbf.readFloat();
  else if (tag === 2) position.longitude = pbf.readFloat();
  else if (tag === 3) position.bearing = pbf.readFloat();
  else if (tag === 4) position.odometer = pbf.readDouble();
  else if (tag === 5) position.speed = pbf.readFloat();
}

function readVehicleDescriptor(tag, descriptor, pbf) {
  if (tag === 1) descriptor.id = readBoundedString(pbf, descriptor);
  else if (tag === 2) descriptor.label = readBoundedString(pbf, descriptor);
  else if (tag === 3)
    descriptor.licensePlate = readBoundedString(pbf, descriptor);
}

function readVehiclePosition(tag, vehicle, pbf) {
  if (tag === 1) vehicle.trip = pbf.readMessage(readTripDescriptor, {});
  else if (tag === 2) vehicle.position = pbf.readMessage(readPosition, {});
  else if (tag === 3) vehicle.currentStopSequence = pbf.readVarint();
  else if (tag === 4) vehicle.currentStatus = pbf.readVarint();
  else if (tag === 5) vehicle.timestamp = pbf.readVarint();
  else if (tag === 6) vehicle.congestionLevel = pbf.readVarint();
  else if (tag === 7) vehicle.stopId = readBoundedString(pbf, vehicle);
  else if (tag === 8)
    vehicle.vehicle = pbf.readMessage(readVehicleDescriptor, {});
  else if (tag === 9) vehicle.occupancyStatus = pbf.readVarint();
}

function readFeedEntity(tag, entity, pbf) {
  if (tag === 1) entity.id = readBoundedString(pbf, entity);
  else if (tag === 2) entity.isDeleted = pbf.readBoolean();
  else if (tag === 4) entity.vehicle = pbf.readMessage(readVehiclePosition, {});
  // 3 (trip_update) and 5 (alert) are skipped: pbf advances past any tag the
  // reader leaves untouched.
}

function readFeedMessage(tag, message, pbf) {
  if (tag === 1) message.header = pbf.readMessage(readFeedHeader, {});
  else if (tag === 2) {
    // Past the cap the field is left UNREAD. pbf skips any field its handler
    // did not consume, so the excess costs one length varint each instead of a
    // full nested decode that is then thrown away.
    if (message.entities.length >= GTFS_MAX_ENTITIES) {
      message.truncated = true;
      return;
    }
    message.entities.push(pbf.readMessage(readFeedEntity, {}));
  }
}

/**
 * Decode a raw GTFS-Realtime FeedMessage.
 * @param {Uint8Array|ArrayBuffer} bytes Protobuf wire bytes.
 * @returns {{ header: {version?: string, incrementality?: number, timestamp?: number},
 *   entities: object[], truncated: boolean }}
 */
export function decodeFeedMessage(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const pbf = new PbfReader(view);
  return pbf.readFields(readFeedMessage, {
    header: {},
    entities: [],
    truncated: false,
  });
}

function finiteOrNull(value) {
  return Number.isFinite(value) ? value : null;
}

function nonEmptyString(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  return text ? text : null;
}

/**
 * True when a lat/lon pair is a usable surface position. Rejects non-finite
 * values, out-of-range degrees, and the (0,0) null island a cold GPS reports.
 * @param {number} lat
 * @param {number} lon
 * @returns {boolean}
 */
export function isPlausibleVehiclePosition(lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return false;
  if (Math.abs(lat) < 1e-6 && Math.abs(lon) < 1e-6) return false;
  return true;
}

/**
 * Flatten one decoded FeedEntity into the record the Transit layer renders,
 * or null when the entity carries no usable vehicle position.
 * @param {object} entity Decoded FeedEntity.
 * @returns {object|null}
 */
export function normalizeVehicleEntity(entity) {
  if (!entity || entity.isDeleted === true) return null;
  const vehicle = entity.vehicle;
  const position = vehicle?.position;
  if (!vehicle || !position) return null;
  // Any refused (over-long) string anywhere in this entity makes the whole
  // record untrustworthy — drop it rather than render a half-identified dot.
  if (
    entity.oversize ||
    vehicle.oversize ||
    vehicle.trip?.oversize ||
    vehicle.vehicle?.oversize
  ) {
    return null;
  }
  const lat = finiteOrNull(position.latitude);
  const lon = finiteOrNull(position.longitude);
  if (!isPlausibleVehiclePosition(lat, lon)) return null;
  const id = nonEmptyString(vehicle.vehicle?.id) || nonEmptyString(entity.id);
  if (!id) return null;
  const bearing = finiteOrNull(position.bearing);
  const speed = finiteOrNull(position.speed);
  const timestamp =
    Number.isFinite(vehicle.timestamp) && vehicle.timestamp > 0
      ? vehicle.timestamp
      : null;
  return {
    id,
    lat: Number(lat.toFixed(6)),
    lon: Number(lon.toFixed(6)),
    bearing: bearing === null ? null : ((bearing % 360) + 360) % 360,
    speedMps: speed === null || speed < 0 ? null : speed,
    timestamp,
    routeId: nonEmptyString(vehicle.trip?.routeId),
    tripId: nonEmptyString(vehicle.trip?.tripId),
    directionId: Number.isInteger(vehicle.trip?.directionId)
      ? vehicle.trip.directionId
      : null,
    label: nonEmptyString(vehicle.vehicle?.label),
    stopId: nonEmptyString(vehicle.stopId),
    status: VEHICLE_STOP_STATUS[vehicle.currentStatus] || null,
    occupancy: OCCUPANCY_STATUS[vehicle.occupancyStatus] || null,
  };
}

/**
 * Decode a VehiclePositions feed into the compact snapshot the proxy serves.
 * Duplicate vehicle ids keep the newest timestamp (feeds occasionally repeat
 * a vehicle across two trip entities during a handover).
 * @param {Uint8Array|ArrayBuffer} bytes Protobuf wire bytes.
 * @returns {{ version: string|null, timestamp: number|null, incrementality: number,
 *   entityCount: number, truncated: boolean, vehicles: object[] }}
 */
export function decodeVehiclePositions(bytes) {
  const message = decodeFeedMessage(bytes);
  const byId = new Map();
  for (const entity of message.entities) {
    const record = normalizeVehicleEntity(entity);
    if (!record) continue;
    const existing = byId.get(record.id);
    if (!existing || (record.timestamp ?? 0) >= (existing.timestamp ?? 0)) {
      byId.set(record.id, record);
    }
  }
  const headerTimestamp = message.header?.timestamp;
  const incrementality = Number.isFinite(message.header?.incrementality)
    ? message.header.incrementality
    : GTFS_INCREMENTALITY_FULL_DATASET;
  return {
    version: nonEmptyString(message.header?.version),
    timestamp:
      Number.isFinite(headerTimestamp) && headerTimestamp > 0
        ? headerTimestamp
        : null,
    incrementality,
    entityCount: message.entities.length,
    truncated: message.truncated === true,
    vehicles: [...byId.values()],
  };
}
