// Seeded, deterministic bit-for-bit comparison of src/geo against Cesium's
// release build (Build/Cesium, debug checks stripped, as production ships it).
// Every number is compared with Object.is (so -0 and NaN count), a throw on one
// side must be a throw on the other, and `result` aliasing is exercised the
// same way on both sides.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as geo from './index.js';

const Cesium = createRequire(import.meta.url)('cesium/Build/Cesium/index.cjs');

const {
  cartesian3: c3,
  cartographic,
  ellipsoid,
  matrix3,
  matrix4,
  quaternion,
  transforms,
} = geo;
const C3 = Cesium.Cartesian3;
const CASES = 2000;
const POLAR_RADIUS = 6356752.3142451793;

// mulberry32: a small seeded generator, so a failure always reproduces.
function generator(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SPECIAL = [
  0,
  -0,
  1e-15,
  -1e-15,
  1,
  -1,
  6378137,
  -6378137,
  POLAR_RADIUS,
  -POLAR_RADIUS,
];

function inputs(seed) {
  const random = generator(seed);
  const scalar = () => {
    if (random() < 0.15) return SPECIAL[Math.floor(random() * SPECIAL.length)];
    const scale = [1e-12, 1, 1e3, 6.4e6, 4.2e7][Math.floor(random() * 5)];
    return (random() - 0.5) * 2 * scale;
  };
  const vector = () => ({ x: scalar(), y: scalar(), z: scalar() });
  return { random, scalar, vector };
}

const label = (value) => (Object.is(value, -0) ? '-0' : String(value));

function sameKeys(ours, theirs, keys, what) {
  if (theirs === undefined) {
    assert.equal(ours, undefined, `${what}: expected undefined`);
    return;
  }
  assert.notEqual(ours, undefined, `${what}: unexpected undefined`);
  for (const k of keys) {
    assert.ok(
      Object.is(ours[k], theirs[k]),
      `${what}.${k}: ${label(ours[k])} vs ${label(theirs[k])}`,
    );
  }
}

const XYZ = ['x', 'y', 'z'];
const XYZW = ['x', 'y', 'z', 'w'];
const GEODETIC = ['longitude', 'latitude', 'height'];
const M3 = Array.from({ length: 9 }, (_, i) => i);
const M4 = Array.from({ length: 16 }, (_, i) => i);

/** Runs both sides; a throw on one side must be a throw on the other. */
function compare(ours, theirs, keys, what) {
  let a;
  let b;
  let aThrew = false;
  let bThrew = false;
  try {
    a = ours();
  } catch {
    aThrew = true;
  }
  try {
    b = theirs();
  } catch {
    bThrew = true;
  }
  assert.equal(
    aThrew,
    bThrew,
    `${what}: throw mismatch (ours ${aThrew}, Cesium ${bThrew})`,
  );
  if (aThrew) return;
  if (keys === null)
    assert.ok(Object.is(a, b), `${what}: ${label(a)} vs ${label(b)}`);
  else sameKeys(a, b, keys, what);
}

const plain = (v) => ({ x: v.x, y: v.y, z: v.z });
const cesium = (v) => new C3(v.x, v.y, v.z);

test('vector operations, including -0 inputs and aliased results, equal Cesium bit for bit', () => {
  const { scalar, vector } = inputs(1);
  // Directionless vectors first: normalize returns NaN on both sides.
  const DEGENERATE = [
    { x: 0, y: 0, z: 0 },
    { x: -0, y: 0, z: -0 },
    { x: Number.NaN, y: 1, z: 2 },
  ];
  for (let i = 0; i < CASES; i++) {
    const a = i < DEGENERATE.length ? DEGENERATE[i] : vector();
    const b = vector();
    const t = scalar();
    for (const op of [
      'add',
      'subtract',
      'cross',
      'multiplyComponents',
      'midpoint',
    ]) {
      compare(
        () => c3[op](a, b, c3.create()),
        () => C3[op](cesium(a), cesium(b), new C3()),
        XYZ,
        op,
      );
    }
    for (const op of ['dot', 'distance', 'distanceSquared']) {
      compare(
        () => c3[op](a, b),
        () => C3[op](cesium(a), cesium(b)),
        null,
        op,
      );
    }
    compare(
      () => c3.magnitude(a),
      () => C3.magnitude(cesium(a)),
      null,
      'magnitude',
    );
    compare(
      () => c3.negate(a, c3.create()),
      () => C3.negate(cesium(a), new C3()),
      XYZ,
      'negate',
    );
    compare(
      () => c3.multiplyByScalar(a, t, c3.create()),
      () => C3.multiplyByScalar(cesium(a), t, new C3()),
      XYZ,
      'multiplyByScalar',
    );
    compare(
      () => c3.divideByScalar(a, t, c3.create()),
      () => C3.divideByScalar(cesium(a), t, new C3()),
      XYZ,
      'divideByScalar',
    );
    compare(
      () => c3.equalsEpsilon(a, b, Math.abs(t), Math.abs(t) / 3),
      () =>
        C3.equalsEpsilon(cesium(a), cesium(b), Math.abs(t), Math.abs(t) / 3),
      null,
      'equalsEpsilon',
    );
    compare(
      () => c3.lerp(a, b, t, c3.create()),
      () => C3.lerp(cesium(a), cesium(b), t, new C3()),
      XYZ,
      'lerp',
    );

    // Aliasing: the result is one of the inputs on both sides.
    compare(
      () => {
        const left = plain(a);
        return c3.lerp(left, b, t, left);
      },
      () => {
        const left = cesium(a);
        return C3.lerp(left, cesium(b), t, left);
      },
      XYZ,
      'lerp result = start',
    );
    compare(
      () => {
        const right = plain(b);
        return c3.lerp(a, right, t, right);
      },
      () => {
        const right = cesium(b);
        return C3.lerp(cesium(a), right, t, right);
      },
      XYZ,
      'lerp result = end',
    );
    compare(
      () => {
        const left = plain(a);
        return c3.cross(left, b, left);
      },
      () => {
        const left = cesium(a);
        return C3.cross(left, cesium(b), left);
      },
      XYZ,
      'cross result = left',
    );
    compare(
      () => {
        const right = plain(b);
        return c3.cross(a, right, right);
      },
      () => {
        const right = cesium(b);
        return C3.cross(cesium(a), right, right);
      },
      XYZ,
      'cross result = right',
    );
    compare(
      () => {
        const v = plain(a);
        return c3.normalize(v, v);
      },
      () => {
        const v = cesium(a);
        return C3.normalize(v, v);
      },
      XYZ,
      'normalize in place',
    );
  }
});

test('geodetic conversions, including the centre, poles and -0 inputs, equal Cesium bit for bit', () => {
  const { random, scalar, vector } = inputs(2);
  const W = Cesium.Ellipsoid.WGS84;
  for (let i = 0; i < CASES; i++) {
    const p = vector();
    const cp = cesium(p);
    compare(
      () => ellipsoid.WGS84.geodeticSurfaceNormal(p),
      () => W.geodeticSurfaceNormal(cp),
      XYZ,
      'normal',
    );
    compare(
      () => ellipsoid.WGS84.scaleToGeodeticSurface(p),
      () => W.scaleToGeodeticSurface(cp),
      XYZ,
      'scale',
    );
    compare(
      () => ellipsoid.WGS84.cartesianToCartographic(p),
      () => W.cartesianToCartographic(cp),
      GEODETIC,
      'cartesianToCartographic',
    );
    compare(
      () => cartographic.fromCartesian(p),
      () => Cesium.Cartographic.fromCartesian(cp),
      GEODETIC,
      'fromCartesian',
    );
    compare(
      () => {
        const v = plain(p);
        return ellipsoid.WGS84.geodeticSurfaceNormal(v, v);
      },
      () => {
        const v = cesium(p);
        return W.geodeticSurfaceNormal(v, v);
      },
      XYZ,
      'normal in place',
    );

    const g = {
      longitude: random() < 0.1 ? -0 : (random() - 0.5) * 8,
      latitude: random() < 0.1 ? Math.PI / 2 : (random() - 0.5) * Math.PI,
      height: scalar() / 10,
    };
    const cg = new Cesium.Cartographic(g.longitude, g.latitude, g.height);
    compare(
      () => ellipsoid.WGS84.cartographicToCartesian(g),
      () => W.cartographicToCartesian(cg),
      XYZ,
      'cartographicToCartesian',
    );
    compare(
      () => cartographic.toCartesian(g),
      () => Cesium.Cartographic.toCartesian(cg),
      XYZ,
      'toCartesian',
    );
    const lon = (random() - 0.5) * 720;
    const lat = (random() - 0.5) * 180;
    compare(
      () => c3.fromDegrees(lon, lat, g.height),
      () => C3.fromDegrees(lon, lat, g.height),
      XYZ,
      'fromDegrees',
    );
  }
});

/** A rotation by angle around axis (Cesium's own construction, so both sides get the same matrix). */
function rotation(axis, angle) {
  const q = Cesium.Quaternion.fromAxisAngle(cesium(axis), angle);
  return Array.from(Cesium.Matrix3.fromQuaternion(q, new Cesium.Matrix3()));
}

test('matrices and quaternions, including aliased results and every fromRotationMatrix branch, equal Cesium', () => {
  const { random, scalar, vector } = inputs(3);
  const branches = new Set();
  for (let i = 0; i < CASES; i++) {
    const a = Array.from({ length: 16 }, () => scalar());
    const b = Array.from({ length: 16 }, () => scalar());
    const ca = Cesium.Matrix4.fromArray(a);
    const cb = Cesium.Matrix4.fromArray(b);
    for (const op of ['multiply', 'multiplyTransformation']) {
      compare(
        () => matrix4[op](a, b, matrix4.create()),
        () => Cesium.Matrix4[op](ca, cb, new Cesium.Matrix4()),
        M4,
        op,
      );
      compare(
        () => {
          const left = [...a];
          return matrix4[op](left, b, left);
        },
        () => {
          const left = ca.clone();
          return Cesium.Matrix4[op](left, cb, left);
        },
        M4,
        `${op} result = left`,
      );
      compare(
        () => {
          const right = [...b];
          return matrix4[op](a, right, right);
        },
        () => {
          const right = cb.clone();
          return Cesium.Matrix4[op](ca, right, right);
        },
        M4,
        `${op} result = right`,
      );
    }
    compare(
      () => {
        const m = [...a];
        return matrix4.inverseTransformation(m, m);
      },
      () => {
        const m = ca.clone();
        return Cesium.Matrix4.inverseTransformation(m, m);
      },
      M4,
      'inverseTransformation in place',
    );
    const p = vector();
    for (const op of ['multiplyByPoint', 'multiplyByPointAsVector']) {
      compare(
        () => {
          const v = plain(p);
          return matrix4[op](a, v, v);
        },
        () => {
          const v = cesium(p);
          return Cesium.Matrix4[op](ca, v, v);
        },
        XYZ,
        `${op} in place`,
      );
    }

    // Rotations near a half turn have trace <= 0, which selects the i = 0, 1, 2 branches.
    const axis = [
      { x: 1, y: 0.1 * random(), z: 0.1 * random() },
      { x: 0.1 * random(), y: 1, z: 0.1 * random() },
      { x: 0.1 * random(), y: 0.1 * random(), z: 1 },
      vector(),
    ][i % 4];
    const angle =
      i % 8 < 4 ? Math.PI - 0.5 * random() : (random() - 0.5) * 2 * Math.PI;
    const m = rotation(axis, angle);
    const trace = m[0] + m[4] + m[8];
    branches.add(
      trace > 0
        ? 'trace>0'
        : m[8] > m[0] && m[8] > m[4]
          ? 'i=2'
          : m[4] > m[0]
            ? 'i=1'
            : 'i=0',
    );
    compare(
      () => quaternion.fromRotationMatrix(m),
      () => Cesium.Quaternion.fromRotationMatrix(Cesium.Matrix3.fromArray(m)),
      XYZW,
      `fromRotationMatrix (trace ${trace})`,
    );
    const q = { x: scalar(), y: scalar(), z: scalar(), w: scalar() };
    compare(
      () => matrix3.fromQuaternion(q),
      () =>
        Cesium.Matrix3.fromQuaternion(
          new Cesium.Quaternion(q.x, q.y, q.z, q.w),
        ),
      M3,
      'fromQuaternion',
    );
    compare(
      () => quaternion.fromAxisAngle(axis, angle),
      () => Cesium.Quaternion.fromAxisAngle(cesium(axis), angle),
      XYZW,
      'fromAxisAngle',
    );
  }
  assert.deepEqual([...branches].sort(), ['i=0', 'i=1', 'i=2', 'trace>0']);
});

test('local frames, including the centre and the exact poles, equal Cesium bit for bit', () => {
  const { random, vector } = inputs(4);
  const DEGENERATE = [
    { x: 0, y: 0, z: 0 },
    { x: -0, y: -0, z: -0 },
    { x: 0, y: 0, z: POLAR_RADIUS },
    { x: 0, y: 0, z: -POLAR_RADIUS },
    { x: -0, y: 1e-15, z: 7 },
  ];
  for (let i = 0; i < CASES; i++) {
    const origin = i < DEGENERATE.length ? DEGENERATE[i] : vector();
    compare(
      () => transforms.eastNorthUpToFixedFrame(origin),
      () => Cesium.Transforms.eastNorthUpToFixedFrame(cesium(origin)),
      M4,
      'eastNorthUpToFixedFrame',
    );
    const hpr = {
      heading: (random() - 0.5) * 10,
      pitch: (random() - 0.5) * 4,
      roll: (random() - 0.5) * 4,
    };
    compare(
      () =>
        transforms.headingPitchRollToFixedFrame(
          origin,
          hpr,
          undefined,
          undefined,
          matrix4.create(),
        ),
      () =>
        Cesium.Transforms.headingPitchRollToFixedFrame(
          cesium(origin),
          new Cesium.HeadingPitchRoll(hpr.heading, hpr.pitch, hpr.roll),
          undefined,
          undefined,
          new Cesium.Matrix4(),
        ),
      M4,
      'headingPitchRollToFixedFrame',
    );
  }
});
