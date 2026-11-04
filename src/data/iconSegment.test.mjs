import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import {
  SEGMENT_STRIDE,
  segmentCourse,
  segmentPosition,
  writeArcSegment,
  writeCourseGlide,
  writeHoldSegment,
  writeLerpSegment,
} from './iconSegment.js';
import {
  arcOffsetEnu,
  lerpAngleDeg,
  limitCourseStep,
  norm180,
} from './motionModel.js';

const fix = Cesium.Cartesian3.fromDegrees(-97.04, 32.9, 10_500);

/** What the flights layer's _extrapolateFix draws for the same fix and dt. */
function productionArc(position, speed, trackDeg, turnRateDps, dt) {
  const arc = arcOffsetEnu(speed, trackDeg, turnRateDps, dt, {});
  const enu = Cesium.Transforms.eastNorthUpToFixedFrame(position);
  const offset = new Cesium.Cartesian3(arc.east, arc.north, 0);
  return {
    position: Cesium.Matrix4.multiplyByPoint(
      enu,
      offset,
      new Cesium.Cartesian3(),
    ),
    course: arc.endCourseDeg,
  };
}

function courseGap(a, b) {
  return Math.abs(norm180(a - b));
}

test('a hold stays put to float32 encoding precision', () => {
  const seg = new Float32Array(SEGMENT_STRIDE * 2);
  writeHoldSegment(seg, 1, fix, 271);
  const at = segmentPosition(seg, 1, 1234);
  assert.ok(Cesium.Cartesian3.distance(at, fix) < 0.005);
  assert.equal(segmentCourse(seg, 1, 99), 271);
});

test('a lerp matches Cesium.Cartesian3.lerp between two fixes and holds at both ends', () => {
  const seg = new Float32Array(SEGMENT_STRIDE);
  const to = Cesium.Cartesian3.fromDegrees(-97.0, 32.93, 10_650);
  writeLerpSegment(seg, 0, {
    from: fix,
    to,
    t0: 100,
    t1: 110,
    course0Deg: 40,
    courseSlopeDeg: 6,
  });
  for (const tau of [100, 102.5, 107, 110]) {
    const want = Cesium.Cartesian3.lerp(
      fix,
      to,
      (tau - 100) / 10,
      new Cesium.Cartesian3(),
    );
    assert.ok(
      Cesium.Cartesian3.distance(segmentPosition(seg, 0, tau), want) < 0.01,
      `τ=${tau}`,
    );
  }
  assert.ok(
    Cesium.Cartesian3.distance(segmentPosition(seg, 0, 50), fix) < 0.01,
  );
  assert.ok(
    Cesium.Cartesian3.distance(segmentPosition(seg, 0, 500), to) < 0.01,
  );
  assert.ok(courseGap(segmentCourse(seg, 0, 105), 43) < 1e-4);
});

test('a lerp course reproduces the blended track-and-chord course across the segment', () => {
  // _deadReckon: lerpAngle(lerpAngle(trackFrom, trackTo, t), chord, w).
  const trackFrom = 350;
  const trackTo = 20;
  const chord = 10;
  const w = 0.6;
  const at = (t) => lerpAngleDeg(lerpAngleDeg(trackFrom, trackTo, t), chord, w);
  const course0 = at(0);
  const slope = norm180(trackTo - trackFrom) * (1 - w);
  const seg = new Float32Array(SEGMENT_STRIDE);
  const to = Cesium.Cartesian3.fromDegrees(-97.0, 32.93, 10_650);
  writeLerpSegment(seg, 0, {
    from: fix,
    to,
    t0: 0,
    t1: 10,
    course0Deg: course0,
    courseSlopeDeg: slope,
  });
  for (const t of [0, 0.25, 0.5, 0.9, 1])
    assert.ok(courseGap(segmentCourse(seg, 0, t * 10), at(t)) < 1e-3, `t=${t}`);
});

test('an arc matches the production turn for straight, slow, standard and tight turns', () => {
  const seg = new Float32Array(SEGMENT_STRIDE);
  for (const turnRateDps of [0, 0.004, 0.01, 0.5, 3, -3, 12]) {
    for (const dt of [0.08, 1, 30, 120, 300]) {
      writeArcSegment(seg, 0, {
        fix,
        t0: 1000,
        minDt: -60,
        maxDt: 300,
        speedMps: 240,
        trackDeg: 305,
        turnRateDps,
      });
      const want = productionArc(fix, 240, 305, turnRateDps, dt);
      const got = segmentPosition(seg, 0, 1000 + dt);
      assert.ok(
        Cesium.Cartesian3.distance(got, want.position) < 0.05,
        `ω=${turnRateDps}°/s dt=${dt}s off by ${Cesium.Cartesian3.distance(got, want.position)} m`,
      );
      assert.ok(
        courseGap(segmentCourse(seg, 0, 1000 + dt), want.course) < 1e-3,
      );
    }
  }
});

test('an arc extrapolates backward for warm-up and clamps both ends', () => {
  const seg = new Float32Array(SEGMENT_STRIDE);
  writeArcSegment(seg, 0, {
    fix,
    t0: 500,
    minDt: -60,
    maxDt: 0,
    speedMps: 200,
    trackDeg: 90,
    turnRateDps: 1.5,
  });
  const back = productionArc(fix, 200, 90, 1.5, -20);
  assert.ok(
    Cesium.Cartesian3.distance(segmentPosition(seg, 0, 480), back.position) <
      0.05,
  );
  const earliest = productionArc(fix, 200, 90, 1.5, -60);
  assert.ok(
    Cesium.Cartesian3.distance(segmentPosition(seg, 0, 0), earliest.position) <
      0.05,
  );
  assert.ok(
    Cesium.Cartesian3.distance(segmentPosition(seg, 0, 900), fix) < 0.01,
  );
});

test('the course glide follows limitCourseStep onto a steady target', () => {
  const seg = new Float32Array(SEGMENT_STRIDE);
  writeHoldSegment(seg, 0, fix, 10);
  writeCourseGlide(seg, 0, 300, 50, 24);
  let prev = 300;
  for (let tau = 50; tau <= 56; tau += 0.08) {
    assert.ok(courseGap(segmentCourse(seg, 0, tau), prev) < 1e-3, `τ=${tau}`);
    prev = limitCourseStep(prev, 10, 24, 0.08);
  }
  assert.equal(segmentCourse(seg, 0, 80), 10);
});

test('writing a segment clears the previous one', () => {
  const seg = new Float32Array(SEGMENT_STRIDE);
  writeArcSegment(seg, 0, {
    fix,
    t0: 0,
    minDt: 0,
    maxDt: 300,
    speedMps: 250,
    trackDeg: 0,
    turnRateDps: 3,
  });
  writeCourseGlide(seg, 0, 90, 0, 30);
  writeHoldSegment(seg, 0, fix, 5);
  assert.ok(
    Cesium.Cartesian3.distance(segmentPosition(seg, 0, 100), fix) < 0.005,
  );
  assert.equal(segmentCourse(seg, 0, 0), 5);
});

test('the course glide never outruns the rate while its target turns', () => {
  const seg = new Float32Array(SEGMENT_STRIDE);
  writeArcSegment(seg, 0, {
    fix,
    t0: 0,
    minDt: 0,
    maxDt: 300,
    speedMps: 200,
    trackDeg: 90,
    turnRateDps: 3,
  });
  writeCourseGlide(seg, 0, 60, 0, 24);
  let prev = 60;
  for (let tau = 0; tau <= 4; tau += 0.01) {
    assert.ok(
      courseGap(segmentCourse(seg, 0, tau), prev) < 0.05,
      `τ=${tau.toFixed(2)}`,
    );
    prev = limitCourseStep(prev, 90 + 3 * (tau + 0.01), 24, 0.01);
  }
  assert.ok(
    courseGap(segmentCourse(seg, 0, 1), 84) < 0.05,
    '24° in the first second, not 27°',
  );
  assert.ok(
    courseGap(segmentCourse(seg, 0, 10), 120) < 1e-3,
    'then it follows the turn',
  );
});
