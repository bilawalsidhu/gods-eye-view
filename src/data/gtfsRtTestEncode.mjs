// src/data/gtfsRtTestEncode.mjs — minimal GTFS-RT protobuf ENCODER for tests.
//
// Just enough wire-format writing to express the GTFS-RT subset the decoder
// (`gtfsRtDecode.js`) reads. Hand-built so round-trip tests never depend on
// the same library the system under test was prototyped against, and shared
// by every test that needs to synthesize a feed (decoder round-trip,
// transitVehicles multi-feed lifecycle). Deliberately NOT named `*.test.mjs`
// so the unit runner never executes it as a suite.

function utf8(s) { return [...new TextEncoder().encode(s)]; }
function varint(n) {
  const out = [];
  // GTFS-RT uses uint64 fields; clamp JS numbers via BigInt-safe path.
  const big = BigInt(n);
  let v = big;
  while (v >= 0x80n) { out.push(Number((v & 0x7fn) | 0x80n)); v >>= 7n; }
  out.push(Number(v));
  return out;
}
function tag(fieldNum, wireType) { return varint((fieldNum << 3) | wireType); }
function lenDelim(fieldNum, bytes) { return [...tag(fieldNum, 2), ...varint(bytes.length), ...bytes]; }
function varintField(fieldNum, n) { return [...tag(fieldNum, 0), ...varint(n)]; }
function stringField(fieldNum, s) { return lenDelim(fieldNum, utf8(s)); }
function float32Field(fieldNum, n) {
  const out = [...tag(fieldNum, 5)];
  const buf = new ArrayBuffer(4);
  new DataView(buf).setFloat32(0, n, true);
  return [...out, ...new Uint8Array(buf)];
}
function buildPosition({ lat, lon, bearing, speed }) {
  const bytes = [];
  if (lat !== undefined) bytes.push(...float32Field(1, lat));
  if (lon !== undefined) bytes.push(...float32Field(2, lon));
  if (bearing !== undefined) bytes.push(...float32Field(3, bearing));
  if (speed !== undefined) bytes.push(...float32Field(5, speed));
  return bytes;
}
function buildTrip({ routeId, tripId }) {
  const bytes = [];
  if (tripId !== undefined) bytes.push(...stringField(1, tripId));
  if (routeId !== undefined) bytes.push(...stringField(5, routeId));
  return bytes;
}
function buildVehicle({ trip, position }) {
  const bytes = [];
  if (trip !== undefined) bytes.push(...lenDelim(1, buildTrip(trip)));
  if (position !== undefined) bytes.push(...lenDelim(2, buildPosition(position)));
  return bytes;
}
function buildEntity({ id, vehicle }) {
  const bytes = [];
  if (id !== undefined) bytes.push(...stringField(1, id));
  if (vehicle !== undefined) bytes.push(...lenDelim(4, buildVehicle(vehicle))); // field 4 = vehicle
  return bytes;
}
/**
 * Encode a minimal single- or multi-entity GTFS-RT FeedMessage.
 * @param {{header?: {version?: string, timestamp?: number},
 *          entity?: object|Array<object>}} feed
 *   - `entity` may be one entity or an array of `{id, vehicle}` shapes.
 * @returns {Uint8Array} Encoded protobuf bytes.
 */
export function encodeFeed({ header, entity }) {
  const bytes = [];
  const headerBytes = [];
  if (header?.version) headerBytes.push(...stringField(1, header.version));
  if (header?.timestamp !== undefined) headerBytes.push(...varintField(3, header.timestamp));
  bytes.push(...lenDelim(1, headerBytes));
  const entities = Array.isArray(entity) ? entity : (entity ? [entity] : []);
  for (const e of entities) bytes.push(...lenDelim(2, buildEntity(e)));
  return new Uint8Array(bytes);
}
