import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { createMotion } from './motion.js';
import { arcOffsetEnu } from '../../data/motionModel.js';

function setup() {
  const flightState = {
    records: { data: new Map() },
    _positionHistory: new Map(),
    _focusEvidenceIds: new Set(),
    _scratchRenderTime: new Cesium.JulianDate(),
    _scratchArc: {},
    _scratchOffset: new Cesium.Cartesian3(),
  };
  const motion = createMotion({
    flightState,
    services: { groundFloor: {}, camera: {}, focus: {} },
    parts: {},
  });
  return { flightState, motion };
}
function expected(fix, dt, turn = 0) {
  const arc = arcOffsetEnu(fix.velocity, fix.track, turn, dt, {});
  const offset = new Cesium.Cartesian3(arc.east, arc.north, 0);
  const matrix = Cesium.Transforms.eastNorthUpToFixedFrame(fix.position);
  return Cesium.Matrix4.multiplyByPoint(
    matrix,
    offset,
    new Cesium.Cartesian3(),
  );
}

test('cached fix axes preserve every moving sample and rebuild after in-place re-flooring', () => {
  const { motion } = setup();
  const fix = {
    position: Cesium.Cartesian3.fromDegrees(12.25, 42.4, 10_000),
    velocity: 230,
    track: 75,
  };
  const expectedSamples = [1, 2, 5, 10].map((dt) => expected(fix, dt, 2));
  const original = Cesium.Transforms.eastNorthUpToFixedFrame;
  let builds = 0;
  Cesium.Transforms.eastNorthUpToFixedFrame = (...args) => {
    builds++;
    return original(...args);
  };
  try {
    for (const [i, dt] of [1, 2, 5, 10].entries()) {
      const result = motion._extrapolateFix(
        fix,
        {},
        dt,
        new Cesium.Cartesian3(),
        2,
      );
      assert.ok(Cesium.Cartesian3.distance(result, expectedSamples[i]) < 1e-8);
    }
    assert.equal(builds, 1);
    Cesium.Cartesian3.fromDegrees(
      12.26,
      42.41,
      10_020,
      Cesium.Ellipsoid.WGS84,
      fix.position,
    );
    const changed = motion._extrapolateFix(
      fix,
      {},
      3,
      new Cesium.Cartesian3(),
      -1,
    );
    assert.equal(builds, 2);
    assert.ok(Cesium.Cartesian3.distance(changed, expected(fix, 3, -1)) < 1e-8);
  } finally {
    Cesium.Transforms.eastNorthUpToFixedFrame = original;
  }
});

test('independent and zero-speed fixes do not reuse another contact local frame', () => {
  const { motion } = setup();
  for (const [lon, lat, speed, dt] of [
    [12, 42, 200, -10],
    [-122, 37, 0, 8],
    [151, -33, 100, 5],
  ]) {
    const fix = Object.freeze({
      position: Cesium.Cartesian3.fromDegrees(lon, lat, 3000),
      velocity: speed,
      track: 130,
    });
    const result = motion._extrapolateFix(fix, {}, dt, new Cesium.Cartesian3());
    assert.ok(Cesium.Cartesian3.distance(result, expected(fix, dt)) < 1e-8);
  }
});

test('fleet-supplied delayed time advances each contact without reading a separate wall clock', () => {
  const { motion, flightState } = setup();
  const time = Cesium.JulianDate.fromIso8601('2026-10-11T04:00:00Z');
  const sampleTime = Cesium.JulianDate.addSeconds(
    time,
    12,
    new Cesium.JulianDate(),
  );
  const fix = {
    position: Cesium.Cartesian3.fromDegrees(12, 42, 3000),
    velocity: 200,
    track: 70,
    time,
    epochMs: 1791691200000,
  };
  flightState.records.data.set('a', { velocity: 200, true_track: 70 });
  flightState._positionHistory.set('a', [fix]);
  const original = Cesium.JulianDate.now;
  Cesium.JulianDate.now = () => {
    throw new Error('Unexpected per-contact clock read');
  };
  try {
    const result = motion._deadReckon('a', new Cesium.Cartesian3(), sampleTime);
    assert.ok(Cesium.Cartesian3.distance(result, expected(fix, 12)) < 1e-8);
    assert.equal(Cesium.JulianDate.secondsDifference(sampleTime, time), 12);
  } finally {
    Cesium.JulianDate.now = original;
  }
});
