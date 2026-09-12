import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeTripUpdates } from './gtfsTripUpdates.js';

/** Minimal protobuf writer: enough to build a FeedMessage by hand. */
const varint = (n) => { const o = []; let v = n; do { let b = v & 0x7f; v >>>= 7; if (v) b |= 0x80; o.push(b); } while (v); return o; };
const key = (field, wire) => varint((field << 3) | wire);
const bytesField = (field, payload) => [...key(field, 2), ...varint(payload.length), ...payload];
const varintField = (field, n) => [...key(field, 0), ...varint(n)];
const str = (field, s) => bytesField(field, [...new TextEncoder().encode(s)]);

const event = (time, delay) => [...varintField(1, delay), ...varintField(2, time)];
const stopUpdate = (stopId, arrival, departure) => bytesField(2, [
  ...(arrival ? bytesField(2, event(arrival, 0)) : []),
  ...(departure ? bytesField(3, event(departure, 0)) : []),
  ...str(4, stopId),
]);
const feed = (tripId, stops, { canceled = false } = {}) => new Uint8Array([
  ...bytesField(1, varintField(3, 1789180000)),
  ...bytesField(2, [
    ...str(1, 'e1'),
    ...bytesField(3, [
      ...bytesField(1, [...str(1, tripId), ...(canceled ? varintField(4, 3) : []), ...str(5, 'route-9')]),
      ...stops.flat(),
    ]),
  ]),
]);

test('a trip update decodes with its stops and unhalved timestamps', () => {
  // GTFS-RT times are int64, not sint64. A zigzag read halves them: 1789180200
  // becomes 894590100, which is 1998, and every train is placed by a clock
  // nearly thirty years wrong.
  const out = decodeTripUpdates(feed('t1', [stopUpdate('A', 0, 1789180200), stopUpdate('B', 1789180680, 0)]));
  assert.equal(out.timestamp, 1789180000);
  assert.equal(out.trips.length, 1);
  assert.equal(out.trips[0].tripId, 't1');
  assert.equal(out.trips[0].routeId, 'route-9');
  assert.equal(out.trips[0].stops[0].departure, 1789180200);
  assert.equal(out.trips[0].stops[1].arrival, 1789180680);
});

test('a cancelled trip is dropped: it has stop times but is not running', () => {
  const out = decodeTripUpdates(feed('t1', [stopUpdate('A', 0, 1789180200), stopUpdate('B', 1789180680, 0)], { canceled: true }));
  assert.equal(out.trips.length, 0);
});

test('a trip with fewer than two placeable stops cannot position anything', () => {
  assert.equal(decodeTripUpdates(feed('t1', [stopUpdate('A', 0, 1789180200)])).trips.length, 0);
});

test('bytes that are not protobuf yield an empty feed rather than throwing', () => {
  // OVapi answers a rate-limited request with an HTML page; pbf walks `<htm`
  // as wire types until it hits a group tag and throws.
  const html = new TextEncoder().encode('<html><body><h1>429 Too Many Requests</h1></body></html>');
  assert.deepEqual(decodeTripUpdates(html), { timestamp: null, trips: [] });
  assert.deepEqual(decodeTripUpdates(new Uint8Array(0)), { timestamp: null, trips: [] });
});
