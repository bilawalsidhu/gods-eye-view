/**
 * GTFS-Realtime TripUpdate reader.
 *
 * `gtfsRealtime.js` deliberately skips trip_update (FeedEntity field 3): it
 * exists to read VehiclePositions. The Dutch train feed publishes the other
 * half — 3,002 trip updates and not one coordinate — so trains need this
 * reader and a stop table to be placed at all.
 *
 * Pure decode: no network, no Cesium.
 */
import { PbfReader } from 'pbf';

/** GTFS-RT ScheduleRelationship values a consumer must act on. */
export const SCHEDULE_RELATIONSHIP = Object.freeze({
  SCHEDULED: 0, ADDED: 1, UNSCHEDULED: 2, CANCELED: 3,
});

function readTrip(tag, trip, pbf) {
  if (tag === 1) trip.tripId = pbf.readString();
  else if (tag === 2) trip.startTime = pbf.readString();
  else if (tag === 3) trip.startDate = pbf.readString();
  else if (tag === 4) trip.scheduleRelationship = pbf.readVarint();
  else if (tag === 5) trip.routeId = pbf.readString();
}

/**
 * `delay`, `time` and `uncertainty` are int32/int64 in the GTFS-RT schema, NOT
 * sint. Reading them as zigzag halves every positive value: a departure of
 * 1789180200 decodes as 894590100, which is May 1998, and the train is then
 * placed by a clock nearly thirty years out. `readVarint(true)` is the signed,
 * non-zigzag read these fields actually need.
 */
function readStopTimeEvent(tag, event, pbf) {
  if (tag === 1) event.delay = pbf.readVarint(true);
  else if (tag === 2) event.time = pbf.readVarint(true);
  else if (tag === 3) event.uncertainty = pbf.readVarint(true);
}

function readStopTimeUpdate(tag, update, pbf) {
  if (tag === 1) update.stopSequence = pbf.readVarint();
  else if (tag === 2) update.arrival = pbf.readMessage(readStopTimeEvent, {});
  else if (tag === 3) update.departure = pbf.readMessage(readStopTimeEvent, {});
  else if (tag === 4) update.stopId = pbf.readString();
  else if (tag === 5) update.scheduleRelationship = pbf.readVarint();
}

function readTripUpdate(tag, tripUpdate, pbf) {
  if (tag === 1) tripUpdate.trip = pbf.readMessage(readTrip, {});
  else if (tag === 2) tripUpdate.stopTimeUpdates.push(pbf.readMessage(readStopTimeUpdate, {}));
  else if (tag === 4) tripUpdate.timestamp = pbf.readVarint();
}

function readEntity(tag, entity, pbf) {
  if (tag === 1) entity.id = pbf.readString();
  else if (tag === 3) entity.tripUpdate = pbf.readMessage(readTripUpdate, { stopTimeUpdates: [] });
}

function readHeader(tag, header, pbf) {
  if (tag === 1) header.version = pbf.readString();
  else if (tag === 3) header.timestamp = pbf.readVarint();
}

function readMessage(tag, message, pbf) {
  if (tag === 1) message.header = pbf.readMessage(readHeader, {});
  else if (tag === 2) message.entities.push(pbf.readMessage(readEntity, {}));
}

/**
 * Decode a FeedMessage into its trip updates.
 *
 * Cancelled trips are dropped here rather than by the caller: a cancelled
 * train has stop times in the feed but is not running, and drawing it would
 * put a phantom on the map.
 * @param {Uint8Array|ArrayBuffer} bytes
 * @returns {{timestamp:?number, trips:Array<{tripId:string, routeId:string,
 *   startDate:string, stops:Array<{stopId:string, sequence:?number,
 *   arrival:?number, departure:?number, delay:?number}>}>}}
 */
export function decodeTripUpdates(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let message;
  try {
    message = new PbfReader(view).readFields(readMessage, { header: {}, entities: [] });
  } catch {
    // Not protobuf. This is not hypothetical: OVapi answers a rate-limited
    // request with an HTML page and HTTP 200-shaped bytes, and pbf then walks
    // `<htm` as wire types until it hits a group tag and throws. A feed reader
    // that dies on a throttle page takes the whole layer with it.
    return { timestamp: null, trips: [] };
  }

  const trips = [];
  for (const entity of message.entities) {
    const update = entity?.tripUpdate;
    if (!update?.trip?.tripId) continue;
    if (update.trip.scheduleRelationship === SCHEDULE_RELATIONSHIP.CANCELED) continue;

    const stops = [];
    for (const stop of update.stopTimeUpdates) {
      if (!stop?.stopId) continue;
      if (stop.scheduleRelationship === 1) continue; // SKIPPED
      const arrival = Number.isFinite(stop.arrival?.time) ? stop.arrival.time : null;
      const departure = Number.isFinite(stop.departure?.time) ? stop.departure.time : null;
      if (arrival === null && departure === null) continue;
      stops.push({
        stopId: stop.stopId,
        sequence: Number.isFinite(stop.stopSequence) ? stop.stopSequence : null,
        arrival,
        departure,
        delay: Number.isFinite(stop.departure?.delay) ? stop.departure.delay
          : (Number.isFinite(stop.arrival?.delay) ? stop.arrival.delay : null),
      });
    }
    if (stops.length < 2) continue; // one stop cannot place a moving train
    trips.push({
      tripId: update.trip.tripId,
      routeId: update.trip.routeId || '',
      startDate: update.trip.startDate || '',
      stops,
    });
  }
  return { timestamp: message.header?.timestamp ?? null, trips };
}
