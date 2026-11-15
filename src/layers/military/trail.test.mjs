import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { createFlightState } from './state.js';
import { createTracking } from './tracking.js';
import { TRAIL_MAX_POINTS } from './policy.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

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
        Number.isFinite(alt) && Number.isFinite(ground)
          ? Math.max(alt, ground + 1)
          : Number.isFinite(alt)
            ? alt
            : Number.isFinite(ground)
              ? ground + 1
              : null,
    },
  };
}

/** A fake trail that records what draws: segments of two or more points. */
function recordingTrail() {
  const calls = [];
  return {
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

function trackedHarness({ liveFixes = [], trace = null, nowMs, floor, head }) {
  const trail = recordingTrail();
  const svc = services({ trails: trail, floor });
  const flightState = createFlightState({
    services: svc,
    source: {
      label: 'Fixture military aircraft',
      async getTrack() {
        if (!trace) throw new Error('404');
        return { records: trace };
      },
    },
  });
  const added = [];
  flightState._viewer = {
    isDestroyed: () => false,
    entities: {
      add(definition) {
        added.push(definition);
        return definition;
      },
      remove() {},
    },
  };
  flightState._trackedIcao = 'ae0001';
  flightState.now = () => nowMs;
  flightState._positionHistory.set(
    'ae0001',
    liveFixes.map((fix) => ({
      time: Cesium.JulianDate.fromDate(new Date(fix.timeMs)),
      epochMs: fix.timeMs,
      position: Cesium.Cartesian3.fromDegrees(fix.lon, fix.lat, 9_000),
    })),
  );
  const tracking = createTracking({
    flightState,
    services: svc,
    parts: {
      motion: {
        _isTrackWarmingUp: () => false,
        _trackedTrailCached: () => head ?? null,
        _trackedDisplayPosition: () => head ?? null,
        _trackedModelCenterWorld: () => null,
        _trackedModelEnvelopeM: () => null,
      },
    },
    layer: {},
  });
  const headPositions = () =>
    added
      .find((definition) =>
        String(definition.id).startsWith('gev-trail:mil-head-'),
      )
      .polyline.positions.getValue();
  return { trail, tracking, flightState, headPositions };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** readsb-shaped trace points as the military source parses them. */
function point(timeMs, lat, lon, baroAltitudeM = 9_000, onGround = false) {
  return {
    observedAtMs: timeMs,
    latitude: lat,
    longitude: lon,
    baroAltitudeM,
    onGround,
  };
}

function leg(startMs, lat, lon, count) {
  return Array.from({ length: count }, (_, i) =>
    point(startMs + i * MINUTE, lat, lon + i * 0.12),
  );
}

test('a multi-leg military trace becomes separate segments with no line across a gap', async () => {
  const t0 = Date.UTC(2026, 10, 8, 0, 0);
  const first = leg(t0, 36, -115, 5);
  const second = leg(t0 + 5 * MINUTE + 3 * HOUR, 35, -106, 5);
  const third = leg(t0 + 10 * MINUTE + 5 * HOUR, 38, -77, 5);
  const trace = [...first, ...second, ...third];
  const liveStart = t0 + 15 * MINUTE + 5 * HOUR;
  const liveFixes = [0, 1, 2].map((i) => ({
    timeMs: liveStart + i * MINUTE,
    lat: 38,
    lon: -77 + 0.6 + i * 0.12,
  }));
  const { trail, flightState, tracking } = trackedHarness({
    liveFixes,
    trace,
    nowMs: liveStart + 3 * MINUTE,
  });
  tracking._startTrail('ae0001');
  await settle();
  assert.equal(flightState._trailFixes.length, trace.length + 3);
  assert.deepEqual(
    trail.last().map((segment) => segment.length),
    [5, 5, 8],
  );
});

test('a military trace point with no altitude breaks the line and is never given a made-up height', async () => {
  const t0 = Date.UTC(2026, 10, 8, 0, 0);
  const trace = leg(t0, 35, -106, 7);
  trace[3] = point(trace[3].observedAtMs, 35, -105.64, null);
  const liveFixes = [{ timeMs: t0 + 7 * MINUTE, lat: 35, lon: -105.16 }];
  const { trail, flightState, tracking } = trackedHarness({
    liveFixes,
    trace,
    nowMs: t0 + 9 * MINUTE,
  });
  tracking._startTrail('ae0001');
  await settle();
  // Skipped (no floor known): 3 + 3 + the live fix drawn.
  assert.equal(flightState._trailFixes.length, trace.length - 1 + 1);
  assert.deepEqual(
    trail.last().map((segment) => segment.length),
    [3, 4],
  );
  for (const fix of flightState._trailFixes) {
    const height = Cesium.Cartographic.fromCartesian(fix.position).height;
    assert.ok(Math.abs(height - 9_000) < 1, `no invented height: ${height}`);
  }
});

test('a military ground point is drawn on the ground and stays joined', async () => {
  const t0 = Date.UTC(2026, 10, 8, 0, 0);
  // Taxiing: 'ground' points a few hundred metres apart, one minute apart.
  const trace = Array.from({ length: 4 }, (_, i) =>
    point(t0 + i * MINUTE, 35, -106.6 + i * 0.004, null, true),
  );
  const liveFixes = [{ timeMs: t0 + 4 * MINUTE, lat: 35, lon: -106.584 }];
  const { trail, flightState, tracking } = trackedHarness({
    liveFixes,
    trace,
    nowMs: t0 + 6 * MINUTE,
    floor: () => 1_590,
  });
  tracking._startTrail('ae0001');
  await settle();
  assert.deepEqual(
    trail.last().map((segment) => segment.length),
    [5],
  );
  const height = Cesium.Cartographic.fromCartesian(
    flightState._trailFixes[0].position,
  ).height;
  assert.ok(Math.abs(height - 1_591) < 1);
});

test('the military head is drawn to a nearby aircraft and not to one more than 150 km away', () => {
  const t0 = Date.UTC(2026, 10, 8, 0, 0);
  const liveFixes = [0, 1, 2].map((i) => ({
    timeMs: t0 + i * MINUTE,
    lat: 35,
    lon: -106 + i * 0.12,
  }));
  const near = Cesium.Cartesian3.fromDegrees(-105.7, 35, 9_000);
  const joined = trackedHarness({
    liveFixes,
    nowMs: t0 + 3 * MINUTE,
    head: near,
  });
  joined.tracking._startTrail('ae0001');
  assert.equal(joined.headPositions().length, 2);

  const far = Cesium.Cartesian3.fromDegrees(-103, 35, 9_000);
  const detached = trackedHarness({
    liveFixes,
    nowMs: t0 + 3 * MINUTE,
    head: far,
  });
  detached.tracking._startTrail('ae0001');
  assert.deepEqual(detached.headPositions(), []);
});

test('a full 24 h military trace fits within TRAIL_MAX_POINTS without thinning', async () => {
  const day = 24 * 60;
  const t0 = Date.UTC(2026, 10, 8, 0, 0);
  const trace = leg(t0, 20, -150, day);
  const liveStart = t0 + day * MINUTE;
  const liveFixes = [{ timeMs: liveStart, lat: 20, lon: -150 + day * 0.12 }];
  const { flightState, tracking } = trackedHarness({
    liveFixes,
    trace,
    nowMs: liveStart + MINUTE,
  });
  tracking._startTrail('ae0001');
  await settle();
  assert.ok(TRAIL_MAX_POINTS >= day + 500);
  assert.equal(flightState._trailFixes.length, day + 1);
});
