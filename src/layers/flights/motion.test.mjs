import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { createMotion } from './motion.js';
import { arcOffsetEnu } from '../../data/motionModel.js';
import { createMotion as createMilitaryMotion } from '../military/motion.js';
import { createQueries } from './queries.js';
import { createQueries as createMilitaryQueries } from '../military/queries.js';
import { layerPlacement } from '../../data/placementProvider.js';
import { observeLiveAircraft } from './placed.js';

function fixture(placement = null) {
  const flightState = {
    records: { data: new Map() },
    _positionHistory: new Map(),
    _focusEvidenceIds: new Set(),
    _scratchArc: {},
    _scratchOffset: { x: 0, y: 0, z: 0 },
    _scratchRenderTime: { dayNumber: 0, secondsOfDay: 0 },
    now: Date.now,
  };
  const motion = createMotion({
    flightState,
    services: { groundFloor: {}, camera: {}, focus: {}, placement },
    parts: {},
  });
  return { flightState, motion };
}

function expectedPosition(fix, dt, turnRate, transform) {
  const arc = {};
  arcOffsetEnu(fix.velocity, fix.track, turnRate, dt, arc);
  return Cesium.Matrix4.multiplyByPoint(
    transform(fix.position, Cesium.Ellipsoid.WGS84, new Cesium.Matrix4()),
    new Cesium.Cartesian3(arc.east, arc.north, 0),
    new Cesium.Cartesian3(),
  );
}

function close(actual, expected) {
  assert.ok(Cesium.Cartesian3.distance(actual, expected) < 1e-8);
}

test('extrapolation follows the fix frame, a corrected or replaced fix included', () => {
  const { motion } = fixture();
  const transform = Cesium.Transforms.eastNorthUpToFixedFrame;
  const fix = {
    position: Cesium.Cartesian3.fromDegrees(-97, 30, 200),
    velocity: 90,
    track: 70,
  };
  const out = { x: 0, y: 0, z: 0 };
  for (const dt of [-30, 5, 30, 60]) {
    motion._extrapolateFix(fix, {}, dt, out, 1.5);
    close(out, expectedPosition(fix, dt, 1.5, transform));
  }

  // Ground reflooring mutates an existing fix's position in place: the
  // frame kept for the fix must not answer for the old coordinates.
  Cesium.Cartesian3.fromDegrees(-97, 30, 350, undefined, fix.position);
  motion._extrapolateFix(fix, {}, 30, out, 1.5);
  close(out, expectedPosition(fix, 30, 1.5, transform));

  fix.position = Cesium.Cartesian3.fromDegrees(140, 80, 1000);
  motion._extrapolateFix(fix, {}, 30, out, -2);
  close(out, expectedPosition(fix, 30, -2, transform));

  fix.velocity = 210;
  fix.track = 359;
  motion._extrapolateFix(fix, {}, 15, out, -1);
  close(out, expectedPosition(fix, 15, -1, transform));

  const replacement = { ...fix };
  motion._extrapolateFix(replacement, {}, 15, out, -1);
  close(out, expectedPosition(replacement, 15, -1, transform));
});

test('stationary fixes stay at the fix', () => {
  const { motion } = fixture();
  const fix = {
    position: Cesium.Cartesian3.fromDegrees(0, 0, 0),
    velocity: 0,
    track: 90,
  };
  const out = { x: 0, y: 0, z: 0 };
  close(motion._extrapolateFix(fix, {}, 30, out), fix.position);
  fix.velocity = 10;
  close(motion._extrapolateFix(fix, {}, 0, out), fix.position);
  close(
    motion._extrapolateFix(fix, {}, 30, out),
    expectedPosition(fix, 30, 0, Cesium.Transforms.eastNorthUpToFixedFrame),
  );
});

test('fleet render time is shared without resampling or mutating the supplied instant', (t) => {
  const { flightState, motion } = fixture();
  const start = Cesium.JulianDate.fromIso8601('2026-10-24T12:00:00Z');
  const end = Cesium.JulianDate.addSeconds(start, 60, new Cesium.JulianDate());
  const renderTime = Cesium.JulianDate.addSeconds(
    start,
    30,
    new Cesium.JulianDate(),
  );
  const savedTime = Cesium.JulianDate.clone(renderTime);
  const history = [
    {
      time: start,
      position: Cesium.Cartesian3.fromDegrees(-97, 30, 1000),
      track: 90,
    },
    {
      time: end,
      position: Cesium.Cartesian3.fromDegrees(-96.99, 30, 1000),
      track: 90,
    },
  ];
  for (const id of ['one', 'two']) {
    flightState.records.data.set(id, { velocity: 100, true_track: 90 });
    flightState._positionHistory.set(id, history);
  }
  t.mock.method(Date, 'now', () => {
    throw new Error('unexpected per-contact clock read');
  });
  const expected = Cesium.Cartesian3.lerp(
    history[0].position,
    history[1].position,
    0.5,
    new Cesium.Cartesian3(),
  );
  for (const id of ['one', 'two'])
    close(
      motion._deadReckon(id, new Cesium.Cartesian3(), renderTime),
      expected,
    );
  assert.ok(Cesium.JulianDate.equals(renderTime, savedTime));
});

test('tracked callers still sample a fresh delayed time without a fleet epoch', () => {
  const { flightState, motion } = fixture();
  const start = Cesium.JulianDate.fromIso8601('2026-10-24T12:00:00Z');
  const history = [
    {
      time: start,
      position: Cesium.Cartesian3.fromDegrees(-97, 30, 1000),
      track: 90,
    },
    {
      time: Cesium.JulianDate.addSeconds(start, 60, new Cesium.JulianDate()),
      position: Cesium.Cartesian3.fromDegrees(-96.99, 30, 1000),
      track: 90,
    },
  ];
  flightState.records.data.set('tracked', { velocity: 100, true_track: 90 });
  flightState._positionHistory.set('tracked', history);
  let elapsed = 60;
  let reads = 0;
  flightState.now = () => {
    reads += 1;
    return Cesium.JulianDate.toDate(start).getTime() + elapsed * 1000;
  };
  const out = new Cesium.Cartesian3();
  close(
    motion._deadReckon('tracked', out),
    Cesium.Cartesian3.lerp(
      history[0].position,
      history[1].position,
      0.5,
      new Cesium.Cartesian3(),
    ),
  );
  elapsed = 75;
  close(
    motion._deadReckon('tracked', out),
    Cesium.Cartesian3.lerp(
      history[0].position,
      history[1].position,
      0.75,
      new Cesium.Cartesian3(),
    ),
  );
  assert.equal(reads, 2);
  // Sampled into the layer's scratch, not a new date.
  assert.ok(
    Cesium.JulianDate.equals(
      flightState._scratchRenderTime,
      Cesium.JulianDate.addSeconds(start, 45, new Cesium.JulianDate()),
    ),
  );
});

/** Two fixes a minute apart, read across the minute from a clock at `start`. */
function placedScenario(create, placement, record) {
  const flightState = {
    records: { data: new Map() },
    _positionHistory: new Map(),
    _focusEvidenceIds: new Set(),
    _scratchArc: {},
    _scratchOffset: new Cesium.Cartesian3(),
    _scratchRenderTime: new Cesium.JulianDate(),
    now: () => 0,
  };
  const motion = create({
    flightState,
    services: { groundFloor: {}, camera: {}, focus: {}, placement },
    parts: {},
  });
  const start = Date.parse('2026-10-24T12:00:00Z');
  const at = (seconds) =>
    Cesium.JulianDate.fromDate(new Date(start + seconds * 1000));
  flightState.records.data.set('abc123', record);
  flightState._positionHistory.set('abc123', [
    {
      time: at(0),
      position: Cesium.Cartesian3.fromDegrees(-97, 30, 1000),
      track: 90,
      velocity: 100,
    },
    {
      time: at(60),
      position: Cesium.Cartesian3.fromDegrees(-96.99, 30, 1000),
      track: 90,
      velocity: 100,
    },
  ]);
  const drawn = [];
  for (let seconds = 0; seconds <= 150; seconds += 7.5) {
    flightState.now = () => start + seconds * 1000;
    const position = motion._deadReckon('abc123', new Cesium.Cartesian3());
    drawn.push({
      position,
      course: flightState._drCourseDeg,
      speed: flightState._drSpeedMps,
      hold: flightState._drCourseHold,
    });
  }
  return { flightState, motion, drawn, start };
}

const declining = (asked) =>
  layerPlacement(
    {
      layer: () => ({
        place: (id, wallMs) => {
          asked.push([id, wallMs]);
          return null;
        },
      }),
    },
    'aircraft',
  );

// Each kind's record carries only its own kinematics fields.
for (const [name, create, record, queriesOf] of [
  [
    'civil',
    createMotion,
    { velocity: 100, true_track: 90, renderAltitudeM: 1234 },
    createQueries,
  ],
  [
    'military',
    createMilitaryMotion,
    { speedMps: 100, track: 90, renderAltitudeM: 1234 },
    createMilitaryQueries,
  ],
]) {
  test(`${name} aircraft waiting where a placement holds them still show their reported speed`, () => {
    // Drawn standing (speed 0) while its fixes catch up: the aircraft has
    // not stopped, and the panels say what it reports.
    const placement = layerPlacement(
      {
        layer: () => ({
          place: () => ({
            lat: 30.5,
            lon: -96.5,
            altitudeM: 2000,
            courseDeg: 90,
            speedMps: 0,
            extrapolating: false,
          }),
        }),
      },
      'aircraft',
    );
    const { flightState, motion, start } = placedScenario(
      create,
      placement,
      record,
    );
    flightState.now = () => start + 2000;
    flightState.feed = {};
    flightState.records.missingPolls = new Map();
    const describe = (kinematics) => {
      flightState.records.data.set('abc123', { ...record, ...kinematics });
      return queriesOf({
        flightState,
        services: {
          aircraftPresentation: {
            tr3bTypeLabel: (_, label) => label,
            tr3bAircraftClass: () => null,
          },
          labels: { formatFlightLevel: String },
          militaryRegistry: {},
          focus: {},
          recession: {},
        },
        parts: {
          motion,
          icons: { _iconPosition: () => null },
          tracking: { _routeIsPlausible: () => false },
          testing: {},
        },
      })._describeFlight('abc123');
    };
    const waiting = describe({});
    assert.equal(flightState._drSpeedMps, 0);
    assert.equal(waiting.velocityMps, 100);
    // Nothing reported: the speed it is drawn at.
    const unreported =
      name === 'civil' ? { velocity: undefined } : { speedMps: undefined };
    assert.equal(describe(unreported).velocityMps, 0);
  });

  test(`${name} aircraft move as before without a placement or with one that places nothing`, () => {
    const own = placedScenario(create, null, record).drawn;
    const asked = [];
    const declined = placedScenario(create, declining(asked), record).drawn;
    assert.equal(asked.length, own.length);
    assert.equal(declined.length, own.length);
    for (let i = 0; i < own.length; i++) {
      assert.ok(
        Cesium.Cartesian3.equals(declined[i].position, own[i].position),
      );
      assert.equal(declined[i].course, own[i].course);
      assert.equal(declined[i].speed, own[i].speed);
      assert.equal(declined[i].hold, own[i].hold);
    }
  });

  test(`${name} aircraft are drawn where a placement places them, live only`, () => {
    const asked = [];
    const placement = layerPlacement(
      {
        layer: () => ({
          place(id, wallMs) {
            asked.push(wallMs);
            return wallMs % 2 === 0
              ? {
                  lat: 30.5,
                  lon: -96.5,
                  altitudeM: 2000,
                  courseDeg: 45,
                  speedMps: 0.5,
                  extrapolating: true,
                }
              : { lat: 30.6, lon: -96.4 };
          },
        }),
      },
      'aircraft',
    );
    const { flightState, motion, start } = placedScenario(
      create,
      placement,
      record,
    );
    flightState.now = () => start + 2000;
    const out = motion._deadReckon('abc123', new Cesium.Cartesian3());
    close(out, Cesium.Cartesian3.fromDegrees(-96.5, 30.5, 2000));
    assert.equal(flightState._drCourseDeg, 45);
    assert.equal(flightState._drSpeedMps, 0.5);
    assert.equal(flightState._drCourseHold, true);
    // No height, course or speed placed: the record's drawn height and kinematics.
    flightState.now = () => start + 2001;
    close(
      motion._deadReckon('abc123', new Cesium.Cartesian3()),
      Cesium.Cartesian3.fromDegrees(-96.4, 30.6, 1234),
    );
    assert.equal(flightState._drCourseDeg, 90);
    assert.equal(flightState._drSpeedMps, 100);
    // Following the world clock the layer's own motion places it, unasked.
    const before = asked.length;
    flightState.timeline = { active: () => true };
    const own = motion._deadReckon('abc123', new Cesium.Cartesian3());
    assert.equal(asked.length, before);
    assert.ok(Cesium.Cartesian3.distance(own, out) > 1000);
  });
}

test('an aircraft fix is told to the placement live, with its drawn height', () => {
  const told = [];
  const placement = layerPlacement(
    {
      layer: () => ({
        place: () => null,
        observe: (id, fix) => told.push([id, fix]),
      }),
    },
    'aircraft',
  );
  const state = { timeline: { active: () => false } };
  const meta = {
    rawLat: 1,
    rawLon: 2,
    renderAltitudeM: 300,
    groundM: 1656,
    onGround: false,
  };
  observeLiveAircraft(state, placement, 'abc123', 5000, meta, 80, 270);
  observeLiveAircraft(
    state,
    placement,
    'abc123',
    6000,
    { ...meta, renderAltitudeInvented: true, groundM: null, onGround: true },
    null,
    undefined,
  );
  observeLiveAircraft(state, null, 'abc123', 7000, meta, 80, 270);
  state.timeline.active = () => true;
  observeLiveAircraft(state, placement, 'abc123', 8000, meta, 80, 270);
  assert.equal(told.length, 2);
  assert.deepEqual(told[0], [
    'abc123',
    {
      timeMs: 5000,
      lat: 1,
      lon: 2,
      altitudeM: 300,
      groundM: 1656,
      speedMps: 80,
      courseDeg: 270,
      headingDeg: NaN,
      onGround: false,
    },
  ]);
  // Where the layer does not know the ground, it says so.
  assert.ok(Number.isNaN(told[1][1].groundM));
  assert.ok(Number.isNaN(told[1][1].altitudeM));
  assert.ok(Number.isNaN(told[1][1].speedMps));
  assert.ok(Number.isNaN(told[1][1].courseDeg));
  assert.equal(told[1][1].onGround, true);
});

test('the trail head reads the tracked position only from the frame it is drawn in', () => {
  for (const create of [createMotion, createMilitaryMotion]) {
    const position = { x: 1, y: 2, z: 3 };
    const flightState = {
      records: { data: new Map() },
      _positionHistory: new Map(),
      _focusEvidenceIds: new Set(),
      _trackedIcao: 'abc123',
      // No viewer: the drawn-frame count reads -1.
      _viewer: null,
      _drReconcileValid: true,
      _drReconcileIcao: 'abc123',
      _cachedDRPosition: position,
      _cachedDRFrame: -1,
      now: Date.now,
    };
    const motion = create({
      flightState,
      services: { groundFloor: {}, camera: {}, focus: {}, placement: null },
      parts: { rendering: { _modelOwnsVisual: () => false } },
    });
    assert.equal(motion._trackedTrailCached(), position, 'this frame');
    // Kept from a frame before: the head works it out for its own frame.
    flightState._cachedDRFrame = -2;
    assert.equal(motion._trackedTrailCached(), null, 'a frame before');
  }
});
