import test from 'node:test';
import assert from 'node:assert/strict';
import { bearingDeg, legAt, placeTrains } from './trainPositions.js';

const stops = new Map([
  ['A', { lat: 52.0, lon: 4.0, name: 'Delft' }],
  ['B', { lat: 52.0, lon: 4.2, name: 'Rotterdam Centraal' }],
  ['C', { lat: 52.0, lon: 4.4, name: 'Gouda' }],
]);
const trip = (times) => ({
  tripId: 't1', routeId: 'r1', startDate: '20260911',
  stops: [
    { stopId: 'A', arrival: times[0], departure: times[1], delay: 30 },
    { stopId: 'B', arrival: times[2], departure: times[3], delay: 60 },
    { stopId: 'C', arrival: times[4], departure: times[5], delay: 0 },
  ],
});
// depart A at 100, reach B at 200, wait to 260, reach C at 360.
const T = trip([90, 100, 200, 260, 360, 370]);

test('a train halfway through a leg is placed halfway along it', () => {
  const leg = legAt(T.stops, 150);
  assert.deepEqual({ ...leg }, { fromIndex: 0, toIndex: 1, fraction: 0.5, dwelling: false });
});

test('a train standing at a platform stays at the platform', () => {
  // Between arriving at B (200) and leaving it (260) the fraction of the NEXT
  // leg is zero — not 100% of the previous one, which parks it short of B.
  const leg = legAt(T.stops, 230);
  assert.equal(leg.dwelling, true);
  assert.equal(leg.fraction, 0);
  assert.equal(leg.fromIndex, 1);
});

test('a trip that has not departed or has terminated is not running', () => {
  assert.equal(legAt(T.stops, 50), null, 'before the first departure');
  assert.equal(legAt(T.stops, 400), null, 'after the last arrival');
});

test('the boundaries themselves count as running', () => {
  assert.equal(legAt(T.stops, 100).fraction, 0);
  assert.equal(legAt(T.stops, 360).dwelling, false);
});

test('a prediction that arrives before it departs pins rather than divides by zero', () => {
  const broken = trip([90, 200, 100, 260, 360, 370]);
  const leg = legAt(broken.stops, 150);
  assert.ok(leg === null || Number.isFinite(leg.fraction), 'fraction must never be NaN or Infinity');
});

test('a run of fewer than two stops cannot place anything', () => {
  assert.equal(legAt([{ stopId: 'A', departure: 100 }], 150), null);
  assert.equal(legAt([], 150), null);
  assert.equal(legAt(T.stops, NaN), null);
});

test('the position is interpolated between the two stops, with a bearing', () => {
  const [train] = placeTrains([T], stops, 150);
  assert.equal(train.lat, 52.0);
  assert.ok(Math.abs(train.lon - 4.1) < 1e-9, `got ${train.lon}`);
  assert.equal(Math.round(train.bearing), 90, 'due east from Delft to Rotterdam');
  assert.equal(train.fromName, 'Delft');
  assert.equal(train.toName, 'Rotterdam Centraal');
  assert.equal(train.estimated, true, 'the straight-line result must declare itself modelled');
});

test('stops with no coordinate are left out of the run, not stretched across', () => {
  // B unknown: the train must run A -> C as its own leg, never A -> (gap) -> C
  // with B's timings still deciding the fraction.
  const partial = new Map([['A', stops.get('A')], ['C', stops.get('C')]]);
  const [train] = placeTrains([T], partial, 300);
  assert.ok(train, 'a trip with two placeable stops still runs');
  assert.equal(train.fromName, 'Delft');
  assert.equal(train.toName, 'Gouda');
});

test('a trip nothing can be placed from yields no train rather than a null island', () => {
  assert.equal(placeTrains([T], new Map(), 150).length, 0);
  assert.equal(placeTrains([], stops, 150).length, 0);
  assert.equal(placeTrains(null, stops, 150).length, 0);
});

test('bearings point the way the train is going, in both directions', () => {
  assert.equal(Math.round(bearingDeg(52, 4, 52, 4.2)), 90);
  assert.equal(Math.round(bearingDeg(52, 4.2, 52, 4)), 270);
  assert.equal(Math.round(bearingDeg(52, 4, 52.2, 4)), 0);
  assert.equal(Math.round(bearingDeg(52.2, 4, 52, 4)), 180);
});

test('the delay reported is the one for the stop the train last left', () => {
  const [onFirstLeg] = placeTrains([T], stops, 150);
  assert.equal(onFirstLeg.delaySec, 30);
  const [onSecondLeg] = placeTrains([T], stops, 300);
  assert.equal(onSecondLeg.delaySec, 60);
});
