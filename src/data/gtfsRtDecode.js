/**
 * GTFS-Realtime protobuf decoder (subset — docs.gtfs.org/realtime/reference/).
 *
 * Just enough of the spec to read `FeedMessage → entity[] → vehicleUpdate →
 * { trip, position, currentStatus, timestamp, occupancyStatus }`. Wire types:
 * 0 = varint, 1 = 64-bit, 2 = length-delimited, 5 = 32-bit.
 *
 * Why hand-rolled (not `gtfs-realtime-bindings`): the full binding is ~80 KB
 * of generated JS plus a `pbf` peer-dep. The app reads exactly four fields per
 * entity from this schema, so a 200-line decoder is the honest choice and
 * keeps the bundle surface unchanged.
 *
 * @param {ArrayBuffer|Uint8Array} buf - Raw protobuf bytes.
 * @returns {{
 *   header: { gtfsRealtimeVersion: string|null, incrementality: number|null, timestamp: number|null },
 *   entities: Array<{ id: string|null, vehicle: {
 *     trip: { routeId: string|null, tripId: string|null, directionId: number|null } | null,
 *     position: { latitude: number|null, longitude: number|null, bearing: number|null, speed: number|null } | null,
 *     currentStopSequence: number|null,
 *     stopId: string|null,
 *     currentStatus: number|null,
 *     timestamp: number|null,
 *     occupancyStatus: number|null,
 *   } | null }>
 * }} Decoded feed. Missing optional fields resolve to null.
 */
export function decodeGtfsRtFeed(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const reader = new ProtoReader(bytes);
  const feed = {
    header: { gtfsRealtimeVersion: null, incrementality: null, timestamp: null },
    entities: [],
  };
  while (reader.pos < bytes.length) {
    const { fieldNum, wireType } = reader.readTag();
    if (fieldNum === 1 && wireType === 2) {
      // header: nested FeedHeader
      const len = reader.readVarint();
      const end = reader.pos + len;
      feed.header = decodeHeader(reader, end);
      reader.pos = end;
    } else if (fieldNum === 2 && wireType === 2) {
      // entity: nested FeedEntity
      const len = reader.readVarint();
      const end = reader.pos + len;
      feed.entities.push(decodeEntity(reader, end));
      reader.pos = end;
    } else {
      reader.skipField(wireType);
    }
  }
  return feed;
}

/**
 * Decode the `FeedHeader` submessage (GTFS-RT fields 1-3).
 * @param {ProtoReader} reader - Cursor positioned at the header's first byte.
 * @param {number} end - Exclusive byte offset of the header's end.
 * @returns {{ gtfsRealtimeVersion: string|null, incrementality: number|null, timestamp: number|null }} Decoded header.
 */
function decodeHeader(reader, end) {
  const header = { gtfsRealtimeVersion: null, incrementality: null, timestamp: null };
  while (reader.pos < end) {
    const { fieldNum, wireType } = reader.readTag();
    if (fieldNum === 1 && wireType === 2) {
      header.gtfsRealtimeVersion = reader.readString();
    } else if (fieldNum === 2 && wireType === 0) {
      header.incrementality = reader.readVarint();
    } else if (fieldNum === 3 && wireType === 0) {
      header.timestamp = reader.readVarint();
    } else {
      reader.skipField(wireType);
    }
  }
  return header;
}

/**
 * Decode a `FeedEntity`. Captures vehicle (field 4) for tracking; ignores
 * trip_update / alert / shape because vehicle tracking never reads them.
 * @param {ProtoReader} reader - Reader positioned at the entity's first byte.
 * @param {number} end - Exclusive byte offset of the entity's end.
 * @returns {{ id: string|null, vehicle: object|null, tripUpdate: null, alert: null }} Decoded entity.
 */
function decodeEntity(reader, end) {
  const entity = { id: null, vehicle: null, tripUpdate: null, alert: null };
  while (reader.pos < end) {
    const { fieldNum, wireType } = reader.readTag();
    if (fieldNum === 1 && wireType === 2) {
      entity.id = reader.readString();
    } else if (fieldNum === 4 && wireType === 2) {
      // FeedEntity.vehicle (VehiclePosition)
      const len = reader.readVarint();
      const vehEnd = reader.pos + len;
      entity.vehicle = decodeVehiclePosition(reader, vehEnd);
      reader.pos = vehEnd;
    } else if ((fieldNum === 3 || fieldNum === 5) && wireType === 2) {
      // FeedEntity.trip_update (TripUpdate) and FeedEntity.alert — both are
      // length-delimited blobs this decoder skips wholesale: vehicle tracking
      // only consumes the VehiclePosition half of each FeedEntity.
      const len = reader.readVarint();
      reader.pos += len;
    } else {
      reader.skipField(wireType);
    }
  }
  return entity;
}

/**
 * Decode a `VehiclePosition` submessage.
 * @param {ProtoReader} reader - Reader positioned at the vehicle's first byte.
 * @param {number} end - Exclusive byte offset of the vehicle's end.
 * @returns {{
 *   trip: object|null,
 *   position: object|null,
 *   currentStopSequence: number|null,
 *   stopId: string|null,
 *   currentStatus: number|null,
 *   timestamp: number|null,
 *   occupancyStatus: number|null,
 * }} Decoded vehicle position.
 */
function decodeVehiclePosition(reader, end) {
  const v = {
    trip: null,
    position: null,
    currentStopSequence: null,
    stopId: null,
    currentStatus: null,
    timestamp: null,
    occupancyStatus: null,
  };
  while (reader.pos < end) {
    const { fieldNum, wireType } = reader.readTag();
    if (fieldNum === 1 && wireType === 2) {
      const len = reader.readVarint();
      const tripEnd = reader.pos + len;
      v.trip = decodeTripDescriptor(reader, tripEnd);
      reader.pos = tripEnd;
    } else if (fieldNum === 2 && wireType === 2) {
      const len = reader.readVarint();
      const posEnd = reader.pos + len;
      v.position = decodePosition(reader, posEnd);
      reader.pos = posEnd;
    } else if (fieldNum === 3 && wireType === 0) {
      v.currentStopSequence = reader.readVarint();
    } else if (fieldNum === 4 && wireType === 2) {
      v.stopId = reader.readString();
    } else if (fieldNum === 5 && wireType === 0) {
      v.currentStatus = reader.readVarint();
    } else if (fieldNum === 6 && wireType === 0) {
      v.timestamp = reader.readVarint();
    } else if (fieldNum === 7 && wireType === 0) {
      v.occupancyStatus = reader.readVarint();
    } else {
      reader.skipField(wireType);
    }
  }
  return v;
}

/**
 * Decode a `TripDescriptor` submessage.
 * @param {ProtoReader} reader - Reader positioned at the trip's first byte.
 * @param {number} end - Exclusive byte offset of the trip's end.
 * @returns {{ routeId: string|null, tripId: string|null, directionId: number|null }} Decoded trip descriptor.
 */
function decodeTripDescriptor(reader, end) {
  const t = { routeId: null, tripId: null, directionId: null };
  while (reader.pos < end) {
    const { fieldNum, wireType } = reader.readTag();
    if (fieldNum === 1 && wireType === 2) {
      t.tripId = reader.readString();
    } else if (fieldNum === 5 && wireType === 2) {
      t.routeId = reader.readString();
    } else if (fieldNum === 6 && wireType === 0) {
      t.directionId = reader.readVarint();
    } else {
      reader.skipField(wireType);
    }
  }
  return t;
}

/**
 * Decode a `Position` submessage. lat/lon are wire type 5 (32-bit fixed) per
 * the GTFS-RT spec — plain little-endian IEEE-754 floats, not zigzag.
 * @param {ProtoReader} reader - Reader positioned at the position's first byte.
 * @param {number} end - Exclusive byte offset of the position's end.
 * @returns {{ latitude: number|null, longitude: number|null, bearing: number|null, speed: number|null }} Decoded position.
 */
function decodePosition(reader, end) {
  const p = { latitude: null, longitude: null, bearing: null, speed: null };
  while (reader.pos < end) {
    const { fieldNum, wireType } = reader.readTag();
    if (fieldNum === 1 && wireType === 5) {
      // float (Degrees North, WGS-84) — wire type 5, plain little-endian.
      p.latitude = reader.readFloat32();
    } else if (fieldNum === 2 && wireType === 5) {
      // float (Degrees East, WGS-84) — wire type 5, plain little-endian.
      p.longitude = reader.readFloat32();
    } else if (fieldNum === 3 && wireType === 5) {
      // bearing (degrees clockwise from North) — optional float.
      p.bearing = reader.readFloat32();
    } else if (fieldNum === 5 && wireType === 5) {
      // speed (meters per second) — optional float.
      p.speed = reader.readFloat32();
    } else if (fieldNum === 4 && wireType === 1) {
      // odometer (meters) — optional double; skip the 8 bytes.
      reader.pos += 8;
    } else {
      reader.skipField(wireType);
    }
  }
  return p;
}

/**
 * Minimal protobuf wire-format reader. Handles the four wire types GTFS-RT
 * actually uses: 0 (varint), 1 (64-bit), 2 (length-delimited), 5 (32-bit).
 * @class
 */
class ProtoReader {
  constructor(bytes) {
    this.bytes = bytes;
    this.pos = 0;
  }
  readTag() {
    const v = this.readVarint();
    return { fieldNum: v >>> 3, wireType: v & 7 };
  }
  readVarint() {
    let result = 0;
    let shift = 0;
    for (;;) {
      if (this.pos >= this.bytes.length) throw new Error('truncated varint');
      const b = this.bytes[this.pos++];
      result |= (b & 0x7f) << shift;
      if ((b & 0x80) === 0) return result;
      shift += 7;
      if (shift >= 64) throw new Error('varint too long');
    }
  }
  readFloat32() {
    // GTFS-RT Position.latitude / longitude / bearing / speed all encode as
    // wire type 5 (32-bit fixed) with plain IEEE-754 little-endian floats —
    // not zigzag-decoded signed-int. Verified against the captured MBTA feed.
    if (this.pos + 4 > this.bytes.length) throw new Error('truncated float32');
    const view = new DataView(this.bytes.buffer, this.bytes.byteOffset + this.pos, 4);
    const value = view.getFloat32(0, true);
    this.pos += 4;
    return value;
  }
  readString() {
    const len = this.readVarint();
    if (this.pos + len > this.bytes.length) throw new Error('truncated string');
    const out = new TextDecoder('utf-8').decode(this.bytes.subarray(this.pos, this.pos + len));
    this.pos += len;
    return out;
  }
  skipField(wireType) {
    switch (wireType) {
      case 0: this.readVarint(); return;
      case 1: this.pos += 8; return;
      case 2: {
        const len = this.readVarint();
        this.pos += len;
        return;
      }
      case 5: this.pos += 4; return;
      default: throw new Error(`unsupported wire type ${wireType}`);
    }
  }
}
