import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { createFlightState } from './state.js';
import { createTracking } from './tracking.js';
import { TRAIL_MAX_POINTS } from './policy.js';
import {
  insertTrailFix,
  trailHeadJoins,
  trailPairBreaks,
  trailTimeAt,
} from '../../data/trailContinuity.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const NM = 1852;

function services({ trails, floor = () => null } = {}) {
  const names = [
    'picking',
    'sprites',
    'aircraftPresentation',
    'camera',
    'militaryRegistry',
    'labels',
    'meshFloor',
    'focus',
    'readout',
    'context',
    'render',
    'recession',
  ];
  return {
    ...Object.fromEntries(names.map((name) => [name, {}])),
    groundSnap: { createGroundSnap: () => ({ clear() {} }) },
    trails,
    geoid: { ensureGeoidReady: async () => {}, geoidHeight: () => 0 },
    groundFloor: {
      resolveGroundFloorCellsBounded: async () => {},
      cachedGroundFloor: floor,
      floorAltitudeM: (alt, ground) =>
        Number.isFinite(alt)
          ? alt
          : Number.isFinite(ground)
            ? ground + 1
            : null,
    },
  };
}

/** A fake trail that records every segment list it is given. */
function recordingTrail() {
  const calls = [];
  return {
    calls,
    // What draws: a lone point is a segment with no line.
    last: () =>
      (calls[calls.length - 1] ?? []).filter((segment) => segment.length >= 2),
    createTrail: () => ({
      setSegments(segments) {
        calls.push(segments.map((segment) => segment.slice()));
      },
      setPositions(positions) {
        calls.push([positions.slice()]);
      },
      setVisible() {},
      clear() {
        calls.push([]);
      },
      destroy() {},
    }),
  };
}

function viewer() {
  const added = [];
  return {
    added,
    isDestroyed: () => false,
    entities: {
      add(definition) {
        added.push(definition);
        return definition;
      },
      remove() {},
    },
  };
}

/**
 * A tracked aircraft whose live history holds `liveFixes` ({timeMs, lat, lon}),
 * with a track endpoint answering `waypoints`.
 */
function trackedHarness({
  liveFixes = [],
  waypoints = null,
  nowMs,
  floor,
  head = null,
  placed = false,
  warmingUp = false,
} = {}) {
  const trail = recordingTrail();
  const svc = services({ trails: trail, floor });
  const flightState = createFlightState({
    services: svc,
    source: {
      label: 'Fixture aircraft',
      async getTrack() {
        if (!waypoints) throw new Error('404');
        return { records: waypoints };
      },
    },
  });
  const v = viewer();
  flightState._viewer = v;
  flightState._trackedIcao = 'abc123';
  flightState.now = () => nowMs;
  flightState._positionHistory.set(
    'abc123',
    liveFixes.map((fix) => ({
      time: Cesium.JulianDate.fromDate(new Date(fix.timeMs)),
      epochMs: fix.timeMs,
      position: Cesium.Cartesian3.fromDegrees(fix.lon, fix.lat, 10_000),
    })),
  );
  const tracking = createTracking({
    flightState,
    services: svc,
    parts: {
      motion: {
        _isTrackWarmingUp: () => warmingUp,
        _trackedPlaced: () => placed,
        _trackedDisplayCached: () => head,
        _trackedTrailCached: () => head,
        _trackedDisplayPosition: () => head,
        _trackedModelCenterWorld: () => null,
        _trackedModelEnvelopeM: () => null,
      },
    },
    layer: {},
  });
  return { trail, tracking, flightState, viewer: v };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function waypoint(timeMs, lat, lon, baroAltitudeM = 10_000) {
  return { observedAtMs: timeMs, latitude: lat, longitude: lon, baroAltitudeM };
}

/** `count` waypoints one minute apart flying east at ~420 kt from (lat, lon). */
function leg(startMs, lat, lon, count) {
  return Array.from({ length: count }, (_, i) =>
    waypoint(startMs + i * MINUTE, lat, lon + i * 0.12),
  );
}

/** The live head the trail would draw now. */
function headPositions({ tracking }) {
  return tracking._trailHeadPositions();
}

test('a pair 40 minutes and 300 km apart stays joined', () => {
  assert.equal(trailPairBreaks(40 * MINUTE, 300_000), false);
});

test('a pair 1 minute and 200 km apart breaks: faster than 1,500 kt', () => {
  assert.equal(trailPairBreaks(MINUTE, 200_000), true);
});

test('a gap longer than 48 minutes breaks, and time that does not advance breaks', () => {
  assert.equal(trailPairBreaks(49 * MINUTE, 10_000), true);
  assert.equal(trailPairBreaks(48 * MINUTE, 10_000), false);
  assert.equal(trailPairBreaks(0, 0), true);
  assert.equal(trailPairBreaks(-MINUTE, 100), true);
});

test('a parked aircraft two hours apart within 0.1 nm stays joined', () => {
  assert.equal(trailPairBreaks(2 * HOUR, 0.09 * NM), false);
  assert.equal(trailPairBreaks(3 * HOUR + MINUTE, 0.09 * NM), true);
  assert.equal(trailPairBreaks(2 * HOUR, 0.2 * NM), true);
});

test('the head joins within 150 km under the time and speed test', () => {
  assert.equal(trailHeadJoins(30_000, 5_000), true);
  assert.equal(trailHeadJoins(30 * MINUTE, 151_000), false);
  assert.equal(trailHeadJoins(HOUR, 5_000), false);
});

test('a backfill with gaps of 10 h, 2 h, 1.2 h and 6.5 h draws five segments and no line across a gap', async () => {
  const t0 = Date.UTC(2026, 10, 8, 0, 0);
  const legs = [];
  let start = t0;
  const gaps = [10 * HOUR, 2 * HOUR, 1.2 * HOUR, 6.5 * HOUR];
  const anchors = [
    [30, 31],
    [12, 0],
    [14, -15],
    [20, -40],
    [35, -75],
  ];
  for (let i = 0; i < anchors.length; i++) {
    const points = leg(start, anchors[i][0], anchors[i][1], 6);
    legs.push(points);
    start = points[points.length - 1].observedAtMs + (gaps[i] ?? 0);
  }
  const waypoints = legs.flat();
  const lastLeg = legs[legs.length - 1];
  const liveStart = lastLeg[lastLeg.length - 1].observedAtMs + MINUTE;
  const liveFixes = [0, 1, 2].map((i) => ({
    timeMs: liveStart + i * MINUTE,
    lat: 35,
    lon: -75 + 0.72 + i * 0.12,
  }));
  const nowMs = liveStart + 3 * MINUTE;
  const { trail, tracking, flightState } = trackedHarness({
    liveFixes,
    waypoints,
    nowMs,
  });
  tracking._startTrail('abc123');
  await settle();

  assert.equal(flightState._trailFixes.length, waypoints.length + 3);
  const segments = trail.last();
  assert.equal(segments.length, 5);
  const bodyCount = segments.reduce((sum, segment) => sum + segment.length, 0);
  // The body draws every fix at or before the display time: all of them here.
  assert.equal(bodyCount, waypoints.length + 3);
  for (const [index, segment] of segments.entries()) {
    const expected = legs[index].map((point) =>
      Cesium.Cartesian3.fromDegrees(point.longitude, point.latitude, 10_000),
    );
    for (const position of segment.slice(0, expected.length)) {
      assert.ok(
        expected.some((e) => Cesium.Cartesian3.distance(e, position) < 1),
        `segment ${index} holds a point from another leg`,
      );
    }
  }
});

test('a null-altitude waypoint breaks the line, and nothing is drawn at 10 km', async () => {
  const t0 = Date.UTC(2026, 10, 8, 0, 0);
  const waypoints = leg(t0, 40, 10, 6);
  waypoints[3] = waypoint(waypoints[3].observedAtMs, 40, 10.36, null);
  const nowMs = t0 + 8 * MINUTE;
  const liveFixes = [
    { timeMs: t0 + 6 * MINUTE, lat: 40, lon: 10.72 },
    { timeMs: t0 + 7 * MINUTE, lat: 40, lon: 10.84 },
  ];

  // Unknown floor: the null point is skipped, and the line still breaks there.
  const skipped = trackedHarness({ liveFixes, waypoints, nowMs });
  skipped.tracking._startTrail('abc123');
  await settle();
  assert.equal(
    skipped.flightState._trailFixes.length,
    waypoints.length - 1 + 2,
  );
  const segments = skipped.trail.last();
  assert.deepEqual(
    segments.map((segment) => segment.length),
    [3, 4],
  );
  for (const segment of segments) {
    for (const position of segment) {
      const height = Cesium.Cartographic.fromCartesian(position).height;
      assert.ok(Math.abs(height - 10_000) < 1, 'only real altitudes drawn');
    }
  }

  // Known floor: the point is kept on the ground, alone, joined to nothing.
  const grounded = trackedHarness({
    liveFixes,
    waypoints,
    nowMs,
    floor: () => 120,
  });
  grounded.tracking._startTrail('abc123');
  await settle();
  assert.equal(grounded.flightState._trailFixes.length, waypoints.length + 2);
  assert.deepEqual(
    grounded.trail.last().map((segment) => segment.length),
    [3, 4],
  );
  const kept = grounded.flightState._trailFixes[3];
  assert.ok(
    Math.abs(Cesium.Cartographic.fromCartesian(kept.position).height - 121) < 1,
  );
});

test('a history tail far from the first live fix does not connect to it', async () => {
  const t0 = Date.UTC(2026, 10, 8, 0, 0);
  // History ends 20 minutes before the first live fix, 1,400 km away.
  const waypoints = leg(t0, 50, 0, 5);
  const liveStart = t0 + 24 * MINUTE;
  const liveFixes = [0, 1, 2].map((i) => ({
    timeMs: liveStart + i * MINUTE,
    lat: 50,
    lon: 20 + i * 0.12,
  }));
  const { trail, tracking } = trackedHarness({
    liveFixes,
    waypoints,
    nowMs: liveStart + 3 * MINUTE,
  });
  tracking._startTrail('abc123');
  await settle();
  assert.deepEqual(
    trail.last().map((segment) => segment.length),
    [5, 3],
  );
});

test('the head is drawn to a nearby aircraft and not to one more than 150 km away', () => {
  const t0 = Date.UTC(2026, 10, 8, 0, 0);
  const liveFixes = [0, 1, 2].map((i) => ({
    timeMs: t0 + i * MINUTE,
    lat: 50,
    lon: 1 + i * 0.12,
  }));
  const near = Cesium.Cartesian3.fromDegrees(1.3, 50, 10_000);
  const joined = trackedHarness({
    liveFixes,
    nowMs: t0 + 3 * MINUTE,
    head: near,
  });
  joined.tracking._startTrail('abc123');
  const drawn = headPositions(joined);
  assert.equal(drawn.length, 2);
  assert.ok(Cesium.Cartesian3.distance(drawn[1], near) < 1e-6);

  const far = Cesium.Cartesian3.fromDegrees(4, 50, 10_000);
  const detached = trackedHarness({
    liveFixes,
    nowMs: t0 + 3 * MINUTE,
    head: far,
  });
  detached.tracking._startTrail('abc123');
  assert.deepEqual(headPositions(detached), []);

  // An hour without a fix: the head no longer joins the last body point.
  const stale = trackedHarness({ liveFixes, nowMs: t0 + HOUR, head: near });
  stale.tracking._startTrail('abc123');
  assert.deepEqual(headPositions(stale), []);
});

test('a live fix after a one-hour feed gap starts a new segment', () => {
  const t0 = Date.UTC(2026, 10, 8, 0, 0);
  const liveFixes = [0, 1, 2].map((i) => ({
    timeMs: t0 + i * MINUTE,
    lat: 50,
    lon: 1 + i * 0.12,
  }));
  const { trail, tracking, flightState } = trackedHarness({
    liveFixes,
    nowMs: t0 + 3 * MINUTE,
  });
  tracking._startTrail('abc123');
  assert.deepEqual(
    trail.last().map((segment) => segment.length),
    [3],
  );
  const later = t0 + 2 * MINUTE + HOUR;
  // The display time moves past the new fixes.
  flightState.now = () => later + 3 * MINUTE;
  for (const [i, lon] of [3, 3.12, 3.24].entries()) {
    tracking._appendTrailFix(
      Cesium.Cartesian3.fromDegrees(lon, 50, 10_000),
      later + i * MINUTE,
    );
  }
  assert.equal(flightState._trailFixes.length, 6);
  assert.deepEqual(
    trail.last().map((segment) => segment.length),
    [3, 3],
  );
});

test('every waypoint of a 24 h history survives, and the trail stays within TRAIL_MAX_POINTS', async () => {
  // A full day at one fix per minute.
  const day = 24 * 60;
  const t0 = Date.UTC(2026, 10, 8, 0, 0);
  const full = leg(t0, 10, -100, day);
  const liveStart = t0 + day * MINUTE;
  const liveFixes = [{ timeMs: liveStart, lat: 10, lon: -100 + day * 0.12 }];
  const kept = trackedHarness({
    liveFixes,
    waypoints: full,
    nowMs: liveStart + MINUTE,
  });
  kept.tracking._startTrail('abc123');
  await settle();
  assert.ok(TRAIL_MAX_POINTS >= day + 500);
  assert.equal(kept.flightState._trailFixes.length, full.length + 1);
  assert.deepEqual(
    kept.trail.last().map((segment) => segment.length),
    [day + 1],
  );

  const count = TRAIL_MAX_POINTS + 120;
  const large = leg(
    liveStart - count * MINUTE,
    10,
    -100 + (day - count) * 0.12,
    count,
  );
  const capped = trackedHarness({
    liveFixes,
    waypoints: large,
    nowMs: liveStart + MINUTE,
  });
  capped.tracking._startTrail('abc123');
  await settle();
  const fixes = capped.flightState._trailFixes;
  assert.equal(fixes.length, TRAIL_MAX_POINTS);
  // The oldest go first: the newest live fix is still the last point.
  assert.equal(fixes[fixes.length - 1].timeMs, liveStart);
});

/** A trail of `count` reports one minute apart flying east from (50, 1). */
function eastTrail(t0, count) {
  const fixes = [];
  for (let i = 0; i < count; i++)
    insertTrailFix(
      fixes,
      Cesium.Cartesian3.fromDegrees(1 + i * 0.12, 50, 10_000),
      t0 + i * MINUTE,
      TRAIL_MAX_POINTS,
    );
  return fixes;
}

test('the time on the trail is read where the aircraft is drawn', () => {
  const t0 = Date.UTC(2026, 10, 8, 0, 0);
  const fixes = eastTrail(t0, 4);
  const at = (lon) =>
    trailTimeAt(fixes, Cesium.Cartesian3.fromDegrees(lon, 50, 10_000));
  // Halfway between the second and third reports.
  assert.ok(Math.abs(at(1.18) - (t0 + 1.5 * MINUTE)) < 2_000);
  // On a report.
  assert.ok(Math.abs(at(1.24) - (t0 + 2 * MINUTE)) < 2_000);
  // Past the newest report the time runs on; before the oldest it runs back.
  assert.ok(Math.abs(at(1.42) - (t0 + 3.5 * MINUTE)) < 2_000);
  assert.ok(Math.abs(at(0.94) - (t0 - 0.5 * MINUTE)) < 2_000);
  // Nothing to read without a pair of reports, or without a position.
  assert.ok(Number.isNaN(trailTimeAt(fixes.slice(0, 1), fixes[0].position)));
  assert.ok(Number.isNaN(trailTimeAt(fixes, null)));
});

test('the time on the trail is never read across a break', () => {
  const t0 = Date.UTC(2026, 10, 8, 0, 0);
  const fixes = eastTrail(t0, 2);
  // An hour later, far on: a new segment.
  insertTrailFix(
    fixes,
    Cesium.Cartesian3.fromDegrees(20, 50, 10_000),
    t0 + HOUR,
    TRAIL_MAX_POINTS,
  );
  insertTrailFix(
    fixes,
    Cesium.Cartesian3.fromDegrees(20.12, 50, 10_000),
    t0 + HOUR + MINUTE,
    TRAIL_MAX_POINTS,
  );
  assert.equal(fixes[2].breakBefore, true);
  // Halfway along the gap is not on the trail: it is read on the newest pair.
  const at = trailTimeAt(fixes, Cesium.Cartesian3.fromDegrees(10, 50, 10_000));
  assert.ok(at <= t0 + HOUR, `read ${at - t0} ms in, across the break`);
});

test('a placed aircraft drawn ahead of the display delay keeps its trail joined to it', () => {
  const t0 = Date.UTC(2026, 10, 8, 0, 0);
  const liveFixes = [0, 1, 2, 3].map((i) => ({
    timeMs: t0 + i * MINUTE,
    lat: 50,
    lon: 1 + i * 0.12,
  }));
  // The layer's own delay puts the aircraft before its first fix (warming
  // up), but the placement draws it between the third and fourth reports.
  const near = Cesium.Cartesian3.fromDegrees(1.3, 50, 10_000);
  const placed = trackedHarness({
    liveFixes,
    nowMs: t0 + 3.5 * MINUTE,
    head: near,
    placed: true,
    warmingUp: true,
  });
  placed.flightState._displayDelay = { currentMs: 10 * MINUTE };
  placed.tracking._startTrail('abc123');
  // The body runs to the last report behind the aircraft, none ahead of it.
  assert.deepEqual(
    placed.trail.last().map((segment) => segment.length > 0),
    [true],
  );
  const body = placed.trail.last()[0];
  assert.ok(
    Cesium.Cartesian3.distance(
      body[body.length - 1],
      Cesium.Cartesian3.fromDegrees(1.24, 50, 10_000),
    ) < 1,
  );
  // The head joins it to the aircraft.
  const drawn = headPositions(placed);
  assert.ok(drawn.length >= 2);
  assert.ok(Cesium.Cartesian3.distance(drawn[0], body[body.length - 1]) < 1);
  assert.ok(Cesium.Cartesian3.distance(drawn[drawn.length - 1], near) < 1e-6);

  // The layer's own motion, warming up, draws no head and no body.
  const own = trackedHarness({
    liveFixes,
    nowMs: t0 + 3.5 * MINUTE,
    head: near,
    warmingUp: true,
  });
  own.flightState._displayDelay = { currentMs: 10 * MINUTE };
  own.tracking._startTrail('abc123');
  assert.deepEqual(own.trail.last(), []);
  assert.deepEqual(headPositions(own), []);
});

test('a placed aircraft drawn behind the display delay has no trail ahead of it', () => {
  const t0 = Date.UTC(2026, 10, 8, 0, 0);
  const liveFixes = [0, 1, 2, 3].map((i) => ({
    timeMs: t0 + i * MINUTE,
    lat: 50,
    lon: 1 + i * 0.12,
  }));
  // The layer's delay would draw every report; the placement holds the
  // aircraft between the first and second.
  const behind = Cesium.Cartesian3.fromDegrees(1.06, 50, 10_000);
  const { trail, tracking, flightState } = trackedHarness({
    liveFixes,
    nowMs: t0 + 4 * MINUTE,
    head: behind,
    placed: true,
  });
  flightState._displayDelay = { currentMs: 0 };
  tracking._startTrail('abc123');
  // One report behind it: no line yet, and nothing ahead of the aircraft.
  assert.deepEqual(trail.last(), []);
  const drawn = headPositions({ tracking });
  assert.equal(drawn.length, 2);
  assert.ok(
    Cesium.Cartesian3.distance(
      drawn[0],
      Cesium.Cartesian3.fromDegrees(1, 50, 10_000),
    ) < 1,
  );
  assert.ok(Cesium.Cartesian3.distance(drawn[1], behind) < 1e-6);
});
