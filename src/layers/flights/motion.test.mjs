import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { createMotion } from './motion.js';
import { arcOffsetEnu } from '../../data/motionModel.js';

function fixture() {
  const flightState = {
    records: { data: new Map() },
    _positionHistory: new Map(),
    _focusEvidenceIds: new Set(),
    _scratchArc: {},
    _scratchOffset: new Cesium.Cartesian3(),
    _scratchRenderTime: new Cesium.JulianDate(),
  };
  const motion = createMotion({
    flightState,
    services: { groundFloor: {}, camera: {}, focus: {} },
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

test('extrapolation reuses fixed frames and invalidates corrected coordinates', (t) => {
  const { motion } = fixture();
  const transform = Cesium.Transforms.eastNorthUpToFixedFrame;
  const spy = t.mock.method(
    Cesium.Transforms,
    'eastNorthUpToFixedFrame',
    transform,
  );
  const fix = {
    position: Cesium.Cartesian3.fromDegrees(-97, 30, 200),
    velocity: 90,
    track: 70,
  };
  const out = new Cesium.Cartesian3();
  for (const dt of [-30, 5, 30, 60]) {
    motion._extrapolateFix(fix, {}, dt, out, 1.5);
    close(out, expectedPosition(fix, dt, 1.5, transform));
  }
  assert.equal(spy.mock.callCount(), 1);

  // Ground reflooring mutates an existing fix's Cartesian in place.
  Cesium.Cartesian3.fromDegrees(-97, 30, 350, undefined, fix.position);
  motion._extrapolateFix(fix, {}, 30, out, 1.5);
  close(out, expectedPosition(fix, 30, 1.5, transform));
  assert.equal(spy.mock.callCount(), 2);

  fix.position = Cesium.Cartesian3.fromDegrees(140, 80, 1000);
  motion._extrapolateFix(fix, {}, 30, out, -2);
  close(out, expectedPosition(fix, 30, -2, transform));
  assert.equal(spy.mock.callCount(), 3);

  fix.velocity = 210;
  fix.track = 359;
  motion._extrapolateFix(fix, {}, 15, out, -1);
  close(out, expectedPosition(fix, 15, -1, transform));
  assert.equal(spy.mock.callCount(), 3);

  const replacement = { ...fix };
  motion._extrapolateFix(replacement, {}, 15, out, -1);
  close(out, expectedPosition(replacement, 15, -1, transform));
  assert.equal(spy.mock.callCount(), 4);
});

test('stationary fixes do not build a frame until motion needs it', (t) => {
  const { motion } = fixture();
  const spy = t.mock.method(Cesium.Transforms, 'eastNorthUpToFixedFrame');
  const fix = {
    position: Cesium.Cartesian3.fromDegrees(0, 0, 0),
    velocity: 0,
    track: 90,
  };
  const out = new Cesium.Cartesian3();
  close(motion._extrapolateFix(fix, {}, 30, out), fix.position);
  fix.velocity = 10;
  close(motion._extrapolateFix(fix, {}, 0, out), fix.position);
  assert.equal(spy.mock.callCount(), 0);
  motion._extrapolateFix(fix, {}, 30, out);
  assert.equal(spy.mock.callCount(), 1);
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
  t.mock.method(Cesium.JulianDate, 'now', () => {
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

test('tracked callers still sample a fresh delayed time without a fleet epoch', (t) => {
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
  const spy = t.mock.method(Cesium.JulianDate, 'now', (result) => {
    assert.equal(result, flightState._scratchRenderTime);
    return Cesium.JulianDate.addSeconds(start, elapsed, result);
  });
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
  assert.equal(spy.mock.callCount(), 2);
});
