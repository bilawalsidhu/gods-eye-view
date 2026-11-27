import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fromDegrees } from '../../geo/ellipsoid.js';
import { eastNorthUp } from '../../geo/frames.js';
import {
  iconCourse,
  iconPosition,
  motionCourse,
  motionEndsAt,
  motionPosition,
} from './iconMotion.js';

const FIX = fromDegrees(-97.04, 32.9, 10_500);
const T0 = Date.UTC(2026, 10, 7, 12);
const near = (a, b, tol, what) =>
  assert.ok(Math.abs(a - b) <= tol, `${what}: ${a} vs ${b}`);
const nearVec = (a, b, tol, what) =>
  assert.ok(
    Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) <= tol,
    `${what}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`,
  );

test('the evaluator imports no renderer', () => {
  const source = readFileSync(
    new URL('./iconMotion.js', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(source, /from 'cesium'/);
});

test('hold and no motion stay at the item’s position, geodetic or ECEF', () => {
  const geo = { lon: 4.1, lat: 51.95, height: 2 };
  nearVec(
    iconPosition({ pos: geo }, T0),
    fromDegrees(4.1, 51.95, 2),
    1e-6,
    'none',
  );
  nearVec(
    iconPosition({ pos: FIX, motion: { kind: 'hold' } }, T0 + 9e6),
    FIX,
    0,
    'hold',
  );
  assert.equal(iconCourse({ pos: FIX, course: -30 }, T0), 330, 'its course');
  assert.equal(
    iconCourse(
      { pos: FIX, course: 10, motion: { kind: 'hold', courseDeg: 45 } },
      T0,
    ),
    45,
    'the hold’s course first',
  );
});

test('a lerp runs from `from` to `to`, holds at the ends, and steps when it has no span', () => {
  const to = { x: FIX.x + 1000, y: FIX.y, z: FIX.z };
  const motion = { kind: 'lerp', from: FIX, to, t0: T0, t1: T0 + 10_000 };
  nearVec(motionPosition(motion, FIX, T0 - 5000), FIX, 0, 'before');
  near(motionPosition(motion, FIX, T0 + 2500).x, FIX.x + 250, 1e-6, 'quarter');
  nearVec(motionPosition(motion, FIX, T0 + 60_000), to, 0, 'after');
  const step = { ...motion, t1: T0 - 50 };
  nearVec(motionPosition(step, FIX, T0), FIX, 0, 'no span: still at from');
  nearVec(motionPosition(step, FIX, T0 + 1), to, 0, 'at to 1 ms later');
  const course = { ...motion, course0Deg: 350, courseSlopeDeg: 20 };
  near(motionCourse(course, 0, T0 + 5000), 0, 1e-9, 'course wraps north');
  near(motionCourse(course, 0, T0 + 20_000), 10, 1e-9, 'holds its end course');
});

test('an arc turns in the fix’s tangent plane, climbs, coasts and warms up', () => {
  const arc = {
    kind: 'arc',
    fix: FIX,
    t0: T0,
    speedMps: 200,
    trackDeg: 90,
    turnRateDps: 3,
    climbMps: 10,
    minDtS: -10,
    maxDtS: 20,
  };
  const enu = eastNorthUp(FIX);
  // The contract's closed form.
  const at = (dt) => {
    const track = (arc.trackDeg * Math.PI) / 180;
    const w = (arc.turnRateDps * Math.PI) / 180;
    const e = (arc.speedMps / w) * (Math.cos(track) - Math.cos(track + w * dt));
    const n = (arc.speedMps / w) * (Math.sin(track + w * dt) - Math.sin(track));
    const u = arc.climbMps * dt;
    return {
      x: FIX.x + enu.x.x * e + enu.y.x * n + enu.z.x * u,
      y: FIX.y + enu.x.y * e + enu.y.y * n + enu.z.y * u,
      z: FIX.z + enu.x.z * e + enu.y.z * n + enu.z.z * u,
    };
  };
  nearVec(motionPosition(arc, FIX, T0 + 8000), at(8), 1e-6, 'at 8 s');
  nearVec(
    motionPosition(arc, FIX, T0 + 60_000),
    at(20),
    1e-6,
    'coasts to maxDtS',
  );
  nearVec(
    motionPosition(arc, FIX, T0 - 60_000),
    at(-10),
    1e-6,
    'warms up from minDtS',
  );
  near(motionCourse(arc, 0, T0 + 10_000), 120, 1e-9, 'its track turns');
  const slow = { ...arc, turnRateDps: 0.001, climbMps: 0 };
  // Under 1e-4 rad/s: straight east.
  const straight = motionPosition(slow, FIX, T0 + 10_000);
  nearVec(
    straight,
    {
      x: FIX.x + enu.x.x * 2000,
      y: FIX.y + enu.x.y * 2000,
      z: FIX.z + enu.x.z * 2000,
    },
    1e-6,
    'straight',
  );
  near(motionCourse(slow, 0, T0 + 10_000), 90, 1e-9, 'straight course');
});

test('a glide turns the short way at its rate, then follows; 0 holds', () => {
  const hold = { kind: 'hold', courseDeg: 30 };
  const glide = (rateDps, fromCourseDeg = 330) => ({
    fromCourseDeg,
    t0: T0,
    rateDps,
  });
  near(motionCourse(hold, 0, T0 - 1000, glide(10)), 330, 1e-9, 'before t0');
  near(motionCourse(hold, 0, T0 + 3000, glide(10)), 0, 1e-9, 'through north');
  near(motionCourse(hold, 0, T0 + 10_000, glide(10)), 30, 1e-9, 'there');
  near(motionCourse(hold, 0, T0 + 60_000, glide(0)), 330, 1e-9, 'held');
  near(motionCourse(hold, 0, T0, glide(10, 30)), 30, 1e-9, 'already there');
  // Onto a turning track: catches it and follows.
  const arc = {
    kind: 'arc',
    fix: FIX,
    t0: T0,
    speedMps: 100,
    trackDeg: 0,
    turnRateDps: 2,
    minDtS: 0,
    maxDtS: 600,
  };
  near(motionCourse(arc, 0, T0 + 2000, glide(6, 340)), 352, 1e-9, 'gliding');
  near(motionCourse(arc, 0, T0 + 30_000, glide(6, 340)), 60, 1e-9, 'following');
});

test('motion ends when its segment and glide do', () => {
  assert.equal(motionEndsAt({ motion: { kind: 'hold' } }), -Infinity);
  assert.equal(motionEndsAt({}), -Infinity);
  assert.equal(
    motionEndsAt({ motion: { kind: 'lerp', t0: T0, t1: T0 + 10 } }),
    T0 + 10,
  );
  assert.equal(
    motionEndsAt({ motion: { kind: 'lerp', t0: T0, t1: T0 } }),
    T0 + 1,
  );
  assert.equal(
    motionEndsAt({ motion: { kind: 'arc', t0: T0, maxDtS: 5 } }),
    T0 + 5000,
  );
  assert.equal(
    motionEndsAt({
      motion: { kind: 'hold' },
      courseGlide: { fromCourseDeg: 0, t0: T0, rateDps: 10 },
    }),
    T0 + 18_000,
  );
});

/**
 * The arc as it was evaluated through `eastNorthUp` before positions were
 * written into a caller's vector: the reference the scalar axes must match
 * bit for bit.
 */
function arcThroughFrame(segment, t) {
  const DEG = Math.PI / 180;
  const dt = Math.min(
    segment.maxDtS,
    Math.max(segment.minDtS, (t - segment.t0) / 1000),
  );
  let omega = (segment.turnRateDps || 0) * DEG;
  if (Math.abs(omega) < 1e-4) omega = 0;
  const half = omega * dt * 0.5;
  const sinc =
    Math.abs(half) < 1e-4 ? 1 - (half * half) / 6 : Math.sin(half) / half;
  const reach = (segment.speedMps || 0) * dt * sinc;
  const heading = (segment.trackDeg || 0) * DEG + half;
  const e = reach * Math.sin(heading);
  const n = reach * Math.cos(heading);
  const u = (segment.climbMps || 0) * dt;
  const { x: east, y: north, z: up } = eastNorthUp(segment.fix);
  const fix = segment.fix;
  return {
    x: fix.x + east.x * e + north.x * n + up.x * u,
    y: fix.y + east.y * e + north.y * n + up.y * u,
    z: fix.z + east.z * e + north.z * n + up.z * u,
  };
}

test('a position written into a given vector is that vector, bit for bit the fresh one', () => {
  const geo = { lon: 4.1, lat: 51.95, height: 2 };
  const arcs = [
    { lon: -97.04, lat: 32.9, h: 10_500, track: 90, turn: 3 },
    { lon: 151.2, lat: -33.9, h: 300, track: 271, turn: 0 },
    { lon: 0, lat: 90, h: 9_000, track: 10, turn: -2 },
    { lon: 0, lat: -90, h: 9_000, track: 200, turn: 1 },
  ].map(({ lon, lat, h, track, turn }) => ({
    kind: 'arc',
    fix: fromDegrees(lon, lat, h),
    t0: T0,
    speedMps: 230,
    trackDeg: track,
    turnRateDps: turn,
    climbMps: -4,
    minDtS: -10,
    maxDtS: 20,
  }));
  // Exactly on the axis: eastNorthUp's pole frame, both poles.
  for (const z of [6_365_000, -6_365_000])
    arcs.push({ ...arcs[0], fix: { x: 0, y: 0, z } });
  const lerp = {
    kind: 'lerp',
    from: FIX,
    to: { x: FIX.x + 900, y: FIX.y - 50, z: FIX.z + 3 },
    t0: T0,
    t1: T0 + 10_000,
  };
  const out = { x: NaN, y: NaN, z: NaN };
  for (const t of [T0 - 15_000, T0, T0 + 3_217, T0 + 25_000]) {
    for (const arc of arcs) {
      const written = motionPosition(arc, null, t, out);
      assert.equal(written, out, 'the arc writes into the given vector');
      assert.deepEqual({ ...written }, arcThroughFrame(arc, t), 'arc bits');
      assert.deepEqual(motionPosition(arc, null, t), arcThroughFrame(arc, t));
    }
    const fresh = motionPosition(lerp, null, t);
    assert.equal(motionPosition(lerp, null, t, out), out);
    assert.deepEqual({ ...out }, fresh, 'lerp bits');
  }
  assert.equal(motionPosition({ kind: 'hold' }, geo, T0, out), out);
  assert.deepEqual(
    { ...out },
    fromDegrees(4.1, 51.95, 2),
    'geodetic hold bits',
  );
  assert.equal(iconPosition({ pos: FIX }, T0, out), out);
  assert.deepEqual({ ...out }, { x: FIX.x, y: FIX.y, z: FIX.z }, 'ECEF hold');
  // Without one, each call still answers with a vector of its own.
  const a = iconPosition({ pos: FIX }, T0);
  const b = iconPosition({ pos: FIX }, T0);
  assert.notEqual(a, b);
  assert.notEqual(a, FIX);
});
