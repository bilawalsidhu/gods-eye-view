import test from 'node:test';
import assert from 'node:assert/strict';
import { createRailPathPack } from '../../data/railPaths.js';
import {
  PATH_OFF_TRACK_M,
  bindTrainPath,
  followFix,
  pathWindowM,
  placeOnPath,
  rebindTrainPath,
} from './pathBinding.js';

const D = 1 / 111_320;

/**
 * Three shapes on the equator:
 * 0: an L, 2 km east then 2 km north (the full run);
 * 1: the first 1 km of the same line (a short turn);
 * 2: 2 km east then 2 km south (a branch at the same junction).
 */
function pack() {
  return createRailPathPack({
    version: 1,
    feedId: 'test-feed',
    shapes: [
      [0, 0, 0, 2000 * D, 2000 * D, 2000 * D],
      [0, 0, 0, 1000 * D],
      [0, 0, 0, 2000 * D, -2000 * D, 2000 * D],
    ],
    dist: [
      [0, 2000, 4000],
      [0, 1000],
      [0, 2000, 4000],
    ],
    trips: { full: 0, branch: 2 },
    routes: { main: [0, 1, 2], short: [1] },
  });
}

const fix = (t, eastM, northM) => ({ t, lat: northM * D, lon: eastM * D });

test('a trip binds to its own shape, else to the best route shape', () => {
  const p = pack();
  const byTrip = bindTrainPath(
    p,
    { tripId: 'branch', routeId: 'main' },
    fix(0, 500, 10),
  );
  assert.equal(byTrip.shapeIndex, 2);
  assert.equal(byTrip.via, 'trip');
  assert.ok(Math.abs(byTrip.fixS - 500) < 0.5);
  const single = bindTrainPath(
    p,
    { tripId: 'unknown', routeId: 'short' },
    fix(0, 500, 0),
  );
  assert.equal(single.shapeIndex, 1);
  assert.equal(single.via, 'route');
  // Near the shared start every main shape fits; the longest wins the tie.
  const shared = bindTrainPath(p, { routeId: 'main' }, fix(0, 500, 0));
  assert.ok([0, 2].includes(shared.shapeIndex), String(shared.shapeIndex));
  // Up the north leg only the full run fits.
  const north = bindTrainPath(p, { routeId: 'main' }, fix(0, 2010, 1500));
  assert.equal(north.shapeIndex, 0);
  assert.ok(Math.abs(north.fixS - 3500) < 1);
});

test('a trip whose report is off its shape falls back to the route', () => {
  const p = pack();
  const binding = bindTrainPath(
    p,
    { tripId: 'branch', routeId: 'main' },
    fix(0, 2000, 1000),
  );
  assert.equal(binding.shapeIndex, 0);
});

test('nothing binds when no shape lies within the off-track distance', () => {
  const p = pack();
  assert.equal(
    bindTrainPath(p, { routeId: 'main' }, fix(0, 1000, PATH_OFF_TRACK_M + 50)),
    null,
  );
  assert.equal(bindTrainPath(p, { routeId: 'none' }, fix(0, 0, 0)), null);
  assert.equal(bindTrainPath(null, { routeId: 'main' }, fix(0, 0, 0)), null);
  assert.equal(
    bindTrainPath(p, { routeId: 'main' }, { t: 0, lat: Number.NaN, lon: 0 }),
    null,
  );
});

test('reports are followed along the line and an off-line report unbinds', () => {
  const p = pack();
  const binding = bindTrainPath(p, { tripId: 'full' }, fix(0, 100, 0));
  assert.ok(followFix(binding, fix(30_000, 1200, 5)));
  assert.ok(Math.abs(binding.fixS - 1200) < 0.5);
  assert.equal(followFix(binding, fix(60_000, 1500, 400)), false);
  assert.ok(
    Math.abs(binding.fixS - 1200) < 0.5,
    'a rejected report changes nothing',
  );
});

test('an off-line report moves the train to a route shape that holds both reports', () => {
  const p = pack();
  // Bound to the short turn, the train runs past its end and on up the L.
  const short = bindTrainPath(p, { routeId: 'short' }, fix(0, 800, 0));
  assert.ok(followFix(short, fix(20_000, 950, 0)));
  const next = fix(60_000, 2000, 300);
  assert.equal(followFix(short, next), false);
  const moved = rebindTrainPath(p, { routeId: 'main' }, short, next);
  assert.equal(moved.shapeIndex, 0);
  assert.ok(Math.abs(moved.fixS - 2300) < 1);
  assert.equal(rebindTrainPath(p, { routeId: 'short' }, short, next), null);
});

test('the search window grows with the gap and gives up when it is too long', () => {
  assert.equal(pathWindowM(0), 300);
  assert.equal(pathWindowM(-10_000), 1000);
  assert.ok(Number.isNaN(pathWindowM(Number.NaN)));
  assert.ok(Number.isNaN(pathWindowM(3_600_000)));
});

function playback(fromSeq, toSeq, from, to, fraction) {
  return {
    sample: { fromSeq, toSeq, fraction },
    segment: {
      from: { seq: fromSeq, ...from },
      to: { seq: toSeq, ...to },
    },
  };
}

test('between two reports a bound train moves along the line, not the chord', () => {
  const p = pack();
  const binding = bindTrainPath(p, { tripId: 'full' }, fix(0, 1500, 0));
  // A corner cut: 1.5 km east, then 500 m up the north leg.
  const a = fix(0, 1500, 0);
  const b = fix(60_000, 2000, 500);
  const out = {};
  const mid = playback(4, 5, a, b, 0.5);
  assert.ok(placeOnPath(binding, mid.sample, mid.segment, out));
  // Halfway along the 1 km of track is the corner itself.
  assert.ok(Math.abs(out.lat) < 1e-9, String(out.lat));
  assert.ok(Math.abs(out.lon - 2000 * D) < 1e-6, String(out.lon));
  assert.ok(Math.abs(binding.drawS - 2000) < 1);
  const later = playback(4, 5, a, b, 0.75);
  assert.ok(placeOnPath(binding, later.sample, later.segment, out));
  assert.ok(Math.abs(out.lat - 250 * D) < 1e-6);
  assert.ok(
    Math.abs(out.bearingDeg) < 1e-6 || Math.abs(out.bearingDeg - 360) < 1e-6,
  );
});

test('the two projections are computed once per segment and chained', () => {
  const p = pack();
  const binding = bindTrainPath(p, { tripId: 'full' }, fix(0, 100, 0));
  const out = {};
  const first = playback(1, 2, fix(0, 100, 0), fix(30_000, 600, 0), 0.2);
  assert.ok(placeOnPath(binding, first.sample, first.segment, out));
  const cache = binding.segment;
  assert.equal(cache.fromSeq, 1);
  assert.ok(Math.abs(cache.sTo - 600) < 0.5);
  // Same segment, later frame: cached arcs, only the fraction moves.
  cache.sFrom = 100.25; // a sentinel a recompute would overwrite
  const frame = playback(1, 2, fix(0, 100, 0), fix(30_000, 600, 0), 0.4);
  assert.ok(placeOnPath(binding, frame.sample, frame.segment, out));
  assert.equal(cache.sFrom, 100.25);
  // Next segment starts at the old to-report: its arc is reused.
  cache.sTo = 600.5;
  const next = playback(2, 3, fix(30_000, 600, 0), fix(60_000, 1100, 0), 0);
  assert.ok(placeOnPath(binding, next.sample, next.segment, out));
  assert.equal(cache.sFrom, 600.5);
  assert.ok(Math.abs(cache.sTo - 1100) < 0.5);
});

test('a parked train sits on the line at its report', () => {
  const p = pack();
  const binding = bindTrainPath(p, { tripId: 'full' }, fix(0, 700, 20));
  const out = {};
  const parked = playback(3, 3, fix(0, 700, 20), fix(0, 700, 20), 1);
  assert.ok(placeOnPath(binding, parked.sample, parked.segment, out));
  assert.equal(out.lat, 0, 'pulled onto the track');
  assert.ok(Math.abs(out.lon - 700 * D) < 1e-6);
});

test('a segment whose reports do not fit the line keeps the straight line', () => {
  const p = pack();
  const binding = bindTrainPath(p, { tripId: 'full' }, fix(0, 100, 0));
  const out = {};
  const off = playback(1, 2, fix(0, 100, 0), fix(30_000, 800, 600), 0.5);
  assert.equal(placeOnPath(binding, off.sample, off.segment, out), false);
  assert.equal(binding.segment.ok, false);
  // No playback position yet, or stale report samples: nothing to place.
  assert.equal(
    placeOnPath(binding, { fromSeq: -1, toSeq: -1 }, off.segment, out),
    false,
  );
  const stale = playback(1, 2, fix(0, 100, 0), fix(30_000, 600, 0), 0.5);
  stale.segment.to.seq = 9;
  assert.equal(placeOnPath(binding, stale.sample, stale.segment, out), false);
  assert.equal(placeOnPath(null, stale.sample, stale.segment, out), false);
});
