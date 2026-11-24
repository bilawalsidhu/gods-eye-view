/**
 * @module railTripUpdates
 * @description Minimal, bounded GTFS-Realtime decoder for TripUpdates feeds,
 * for the Rail layer's live delays.
 *
 * Same approach as the VehiclePositions decoder (src/data/gtfsRealtime.js):
 * `pbf` straight off the wire, field numbers as the contract, no generated
 * code. Only what a delay readout needs is read; vehicle positions, alerts and
 * every extension are skipped by pbf.
 *
 * Field numbers (gtfs-realtime.proto, v2.0):
 *   FeedEntity         3 trip_update
 *   TripUpdate         1 trip, 2 stop_time_update[], 3 vehicle, 4 timestamp,
 *                      5 delay
 *   StopTimeUpdate     1 stop_sequence, 2 arrival, 3 departure, 4 stop_id,
 *                      5 schedule_relationship
 *   StopTimeEvent      1 delay (int32), 2 time (int64), 3 uncertainty
 *   TripDescriptor     1 trip_id, 2 start_time, 3 start_date,
 *                      4 schedule_relationship, 5 route_id, 6 direction_id
 *
 * Decoding is bounded the way the vehicle decoder is: entities past the cap
 * are left unread, stop updates past the per-trip cap are left unread, and an
 * over-long string drops the record it belongs to instead of truncating it.
 *
 * Pure: safe to import from the browser layer, the Vite proxy, and node:test.
 */

import { PbfReader } from 'pbf';
import {
  GTFS_INCREMENTALITY_FULL_DATASET,
  GTFS_MAX_ENTITIES,
  GTFS_MAX_STRING_CHARS,
} from './gtfsRealtime.js';

/** Stop updates kept per trip. The longest rail trips call at ~100 stops. */
export const RAIL_TRIP_UPDATE_MAX_STOPS = 200;
/** Trips kept per decode, before the rail filter. */
export const RAIL_TRIP_UPDATE_MAX_TRIPS = 20_000;
/**
 * Plausible delay range (seconds). A day either way covers every honest
 * report; a value outside it is a unit error, not a late train.
 */
export const RAIL_TRIP_UPDATE_MAX_DELAY_S = 86_400;

/** TripDescriptor.ScheduleRelationship enum → label. */
const TRIP_RELATIONSHIP = Object.freeze({
  0: 'SCHEDULED',
  1: 'ADDED',
  2: 'UNSCHEDULED',
  3: 'CANCELED',
  5: 'REPLACEMENT',
  6: 'DUPLICATED',
  7: 'DELETED',
  8: 'NEW',
});

/** StopTimeUpdate.ScheduleRelationship enum → label. */
const STOP_RELATIONSHIP = Object.freeze({
  0: 'SCHEDULED',
  1: 'SKIPPED',
  2: 'NO_DATA',
  3: 'UNSCHEDULED',
});

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

function readVehicleDescriptor(tag, descriptor, pbf) {
  if (tag === 1) descriptor.id = readBoundedString(pbf, descriptor);
  else if (tag === 2) descriptor.label = readBoundedString(pbf, descriptor);
}

function readStopTimeEvent(tag, event, pbf) {
  // int32 and int64 are plain (not zig-zag) varints: negatives arrive as
  // ten-byte two's complement, which the signed read restores.
  if (tag === 1) event.delay = pbf.readVarint(true);
  else if (tag === 2) event.time = pbf.readVarint(true);
}

function readStopTimeUpdate(tag, update, pbf) {
  if (tag === 1) update.stopSequence = pbf.readVarint();
  else if (tag === 2) update.arrival = pbf.readMessage(readStopTimeEvent, {});
  else if (tag === 3) update.departure = pbf.readMessage(readStopTimeEvent, {});
  else if (tag === 4) update.stopId = readBoundedString(pbf, update);
  else if (tag === 5) update.scheduleRelationship = pbf.readVarint();
}

function readTripUpdate(tag, tripUpdate, pbf) {
  if (tag === 1) tripUpdate.trip = pbf.readMessage(readTripDescriptor, {});
  else if (tag === 2) {
    // Past the cap the stop is left unread; pbf skips it whole.
    if (tripUpdate.stops.length >= RAIL_TRIP_UPDATE_MAX_STOPS) {
      tripUpdate.stopsTruncated = true;
      return;
    }
    tripUpdate.stops.push(pbf.readMessage(readStopTimeUpdate, {}));
  } else if (tag === 3)
    tripUpdate.vehicle = pbf.readMessage(readVehicleDescriptor, {});
  else if (tag === 4) tripUpdate.timestamp = pbf.readVarint();
  else if (tag === 5) tripUpdate.delay = pbf.readVarint(true);
}

function readFeedEntity(tag, entity, pbf) {
  if (tag === 1) entity.id = readBoundedString(pbf, entity);
  else if (tag === 2) entity.isDeleted = pbf.readBoolean();
  else if (tag === 3)
    entity.tripUpdate = pbf.readMessage(readTripUpdate, { stops: [] });
  // 4 (vehicle) and 5 (alert) are skipped: a combined feed (the MTA's) costs
  // one length varint per vehicle here.
}

function readFeedMessage(tag, message, pbf) {
  if (tag === 1) message.header = pbf.readMessage(readFeedHeader, {});
  else if (tag === 2) {
    if (message.entityCount >= GTFS_MAX_ENTITIES) {
      message.truncated = true;
      return;
    }
    message.entityCount += 1;
    const entity = pbf.readMessage(readFeedEntity, {});
    if (!entity.tripUpdate) return;
    if (message.tripUpdates.length >= RAIL_TRIP_UPDATE_MAX_TRIPS) {
      message.truncated = true;
      return;
    }
    message.tripUpdates.push(entity);
  }
}

function nonEmptyString(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  return text ? text : null;
}

function plausibleDelay(value) {
  return Number.isInteger(value) &&
    Math.abs(value) <= RAIL_TRIP_UPDATE_MAX_DELAY_S
    ? value
    : null;
}

/** Epoch seconds between 2000 and 2100, else null. */
function plausibleTime(value) {
  return Number.isInteger(value) && value > 946_684_800 && value < 4_102_444_800
    ? value
    : null;
}

function normalizeEvent(event) {
  if (!event) return null;
  const time = plausibleTime(event.time);
  const delay = plausibleDelay(event.delay);
  if (time === null && delay === null) return null;
  return { time, delay };
}

/**
 * Flatten one decoded FeedEntity into the trip record `/api/rail/updates`
 * serves, or null when it carries no usable trip.
 *
 * `delaySec` is the trip's own delay when the operator states one, else the
 * delay at the first stop update that carries one (feeds list the stops still
 * ahead, so that is the delay the train is running with now). Feeds that only
 * publish predicted times (MBTA) have no delay to report: null, not zero.
 * @param {object} entity Decoded FeedEntity.
 * @returns {object|null}
 */
export function normalizeTripUpdateEntity(entity) {
  if (!entity || entity.isDeleted === true) return null;
  const update = entity.tripUpdate;
  if (!update || entity.oversize || update.trip?.oversize) return null;
  if (update.vehicle?.oversize) return null;
  const tripId = nonEmptyString(update.trip?.tripId);
  const routeId = nonEmptyString(update.trip?.routeId);
  if (!tripId && !routeId) return null;
  const stops = [];
  for (const stop of update.stops) {
    if (stop.oversize) continue;
    const arrival = normalizeEvent(stop.arrival);
    const departure = normalizeEvent(stop.departure);
    const relationship = STOP_RELATIONSHIP[stop.scheduleRelationship] || null;
    const stopId = nonEmptyString(stop.stopId);
    const stopSequence = Number.isInteger(stop.stopSequence)
      ? stop.stopSequence
      : null;
    if (stopId === null && stopSequence === null) continue;
    const record = { stopId, stopSequence, arrival, departure };
    if (relationship && relationship !== 'SCHEDULED')
      record.relationship = relationship;
    stops.push(record);
  }
  let delaySec = plausibleDelay(update.delay);
  if (delaySec === null) {
    for (const stop of stops) {
      const delay = stop.arrival?.delay ?? stop.departure?.delay ?? null;
      if (delay !== null) {
        delaySec = delay;
        break;
      }
    }
  }
  const relationship =
    TRIP_RELATIONSHIP[update.trip?.scheduleRelationship] || 'SCHEDULED';
  const timestamp =
    Number.isFinite(update.timestamp) && update.timestamp > 0
      ? update.timestamp
      : null;
  return {
    tripId,
    routeId,
    startDate: nonEmptyString(update.trip?.startDate),
    startTime: nonEmptyString(update.trip?.startTime),
    directionId: Number.isInteger(update.trip?.directionId)
      ? update.trip.directionId
      : null,
    vehicleId: nonEmptyString(update.vehicle?.id),
    relationship,
    timestamp,
    delaySec,
    stopsTruncated: update.stopsTruncated === true,
    stops,
  };
}

/**
 * Decode a TripUpdates FeedMessage, at most GTFS_MAX_ENTITIES entities.
 * @param {Uint8Array|ArrayBuffer} bytes Protobuf wire bytes.
 * @returns {{ version: string|null, timestamp: number|null,
 *   incrementality: number, entityCount: number, truncated: boolean,
 *   trips: object[] }}
 */
export function decodeTripUpdates(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const message = new PbfReader(view).readFields(readFeedMessage, {
    header: {},
    tripUpdates: [],
    entityCount: 0,
    truncated: false,
  });
  const trips = [];
  for (const entity of message.tripUpdates) {
    const trip = normalizeTripUpdateEntity(entity);
    if (trip) trips.push(trip);
  }
  const header = message.header || {};
  return {
    version: header.oversize ? null : nonEmptyString(header.version),
    timestamp:
      Number.isFinite(header.timestamp) && header.timestamp > 0
        ? header.timestamp
        : null,
    incrementality: Number.isFinite(header.incrementality)
      ? header.incrementality
      : GTFS_INCREMENTALITY_FULL_DATASET,
    entityCount: message.entityCount,
    truncated: message.truncated === true,
    trips,
  };
}
