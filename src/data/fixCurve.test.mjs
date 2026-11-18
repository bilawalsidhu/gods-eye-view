import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import {
  CURVE_RUN_ON_S,
  curvePieceAt,
  curvePoints,
  curvePositionAt,
  fixCurve,
  straightSegment,
} from './fixCurve.js';
import { motionPosition } from '../render/motion/iconMotion.js';

// Between two reports an aircraft is drawn along a curve through both that
// leaves each along its reported track, made of contract `arc` segments.

const SEC = 1000;
const T0 = Date.UTC(2026, 10, 9, 12);
const enu = Cesium.Transforms.eastNorthUpToFixedFrame(
  Cesium.Cartesian3.fromDegrees(-122.4, 37.6, 0),
);
const at = (e, n, u = 3_000) =>
  Cesium.Matrix4.multiplyByPoint(
    enu,
    new Cesium.Cartesian3(e, n, u),
    new Cesium.Cartesian3(),
  );
const near = (a, b, m, label) => {
  const d = Cesium.Cartesian3.distance(a, b);
  assert.ok(d < m, `${label}: ${d.toFixed(2)} m`);
};
const angleDiff = (a, b) => Math.abs(((a - b + 540) % 360) - 180);

// A 100 m/s left turn on a 2 km circle centred at (0, R), heading east at
// the origin.
const R = 2_000;
const W = 100 / R;
const circle = (t) => at(R * Math.sin(W * t), R - R * Math.cos(W * t));
const trackAt = (t) => (90 - (W * t * 180) / Math.PI + 360) % 360;

test('the curve passes through both reports and leaves each along its track', () => {
  const curve = fixCurve(
    circle(0),
    T0,
    trackAt(0),
    circle(15),
    T0 + 15 * SEC,
    trackAt(15),
  );
  assert.ok(curve);
  near(curvePositionAt(curve, T0).position, circle(0), 0.01, 'start');
  near(curvePositionAt(curve, T0 + 15 * SEC).position, circle(15), 0.01, 'end');
  assert.ok(angleDiff(curvePositionAt(curve, T0).courseDeg, trackAt(0)) < 0.1);
  assert.ok(
    angleDiff(curvePositionAt(curve, T0 + 15 * SEC).courseDeg, trackAt(15)) <
      0.1,
  );
  // A true turn: the curve is the turn, within a couple of metres.
  for (let s = 0; s <= 15; s += 0.5)
    near(curvePositionAt(curve, T0 + s * SEC).position, circle(s), 3, `${s} s`);
});

test('its pieces are contiguous arc segments in time order', () => {
  // Tracks that need an S: the first turn and the second do not agree.
  const curve = fixCurve(at(0, 0), T0, 45, at(3_000, 0), T0 + 30 * SEC, 45);
  assert.ok(curve);
  assert.equal(curve.pieces.length, 2);
  assert.equal(curve.pieces[0].t0, T0);
  assert.equal(curve.pieces.at(-1).t1, T0 + 30 * SEC);
  for (const piece of curve.pieces) assert.equal(piece.segment.kind, 'arc');
  const [a, b] = curve.pieces;
  assert.equal(a.t1, b.t0);
  near(
    motionPosition(a.segment, null, a.t1),
    motionPosition(b.segment, null, b.t0),
    0.01,
    'join',
  );
  assert.equal(curvePieceAt(curve, a.t1 - 1), a);
  assert.equal(curvePieceAt(curve, a.t1), b);
  assert.equal(curvePieceAt(curve, T0 + 60 * SEC), b);
});

test('each segment runs on past its end rather than holding', () => {
  const curve = fixCurve(
    circle(0),
    T0,
    trackAt(0),
    circle(15),
    T0 + 15 * SEC,
    trackAt(15),
  );
  const last = curve.pieces.at(-1);
  const end = motionPosition(last.segment, null, last.t1);
  const later = motionPosition(
    last.segment,
    null,
    last.t1 + CURVE_RUN_ON_S * SEC,
  );
  near(later, circle(15 + CURVE_RUN_ON_S), 3, 'run on');
  assert.ok(Cesium.Cartesian3.distance(end, later) > 150);
});

test('no curve without tracks, below 40 m/s, or with a track far off the line', () => {
  const a = at(0, 0);
  const b = at(1_500, 0);
  assert.equal(fixCurve(a, T0, undefined, b, T0 + 15 * SEC, 90), null);
  assert.equal(fixCurve(a, T0, 90, b, T0 + 60 * SEC, 90), null, 'slow');
  assert.equal(fixCurve(a, T0, 180, b, T0 + 15 * SEC, 90), null, 'off line');
  assert.equal(fixCurve(a, T0, 90, b, T0, 90), null, 'no time between');
});

test('trail points follow the curve, exclusive of both ends, a degree of turn apart', () => {
  const curve = fixCurve(
    circle(0),
    T0,
    trackAt(0),
    circle(15),
    T0 + 15 * SEC,
    trackAt(15),
  );
  const points = curvePoints(curve, T0, T0 + 15 * SEC);
  // 15 s at 2.86°/s: about 43° of turn.
  assert.ok(points.length >= 42 && points.length <= 46, `${points.length}`);
  for (const p of points)
    assert.ok(
      Math.abs(Cesium.Cartesian3.distance(p, at(0, R)) - R) < 3,
      'off the turn',
    );
  assert.ok(Cesium.Cartesian3.distance(points[0], circle(0)) > 1);
  assert.ok(Cesium.Cartesian3.distance(points.at(-1), circle(15)) > 1);
});

test('a straight segment reaches its end at its time and runs on along the same line', () => {
  const a = at(0, 0);
  const b = at(1_000, 0);
  const segment = straightSegment(a, T0, T0 + 10 * SEC, b);
  near(motionPosition(segment, null, T0), a, 0.01, 'start');
  near(motionPosition(segment, null, T0 + 5 * SEC), at(500, 0), 1, 'middle');
  near(motionPosition(segment, null, T0 + 10 * SEC), b, 0.01, 'end');
});
