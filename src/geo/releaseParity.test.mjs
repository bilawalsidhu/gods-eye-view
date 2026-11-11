// Release parity: src/geo returns what release Cesium returns.
//
// Production builds ship Cesium's Build/Cesium, whose debug checks are
// stripped, and src/geo has no debug checks either. So for a degenerate input
// (a zero vector to normalize, a NaN origin, a divisor of 0, an index out of
// range) both must return the same values, NaN for NaN and -0 for -0, or fail
// with the same error.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as geo from './index.js';

const Cesium = createRequire(import.meta.url)('cesium/Build/Cesium/index.cjs');

const W = Cesium.Ellipsoid.WGS84;
const C3 = Cesium.Cartesian3;

// Builders run once per side so no object is shared between geo and Cesium.
const vec = (x, y, z) => (side) =>
  side === 'geo' ? geo.cartesian3.create(x, y, z) : new C3(x, y, z);
const carto = (lon, lat, h) => (side) =>
  side === 'geo'
    ? geo.cartographic.create(lon, lat, h)
    : new Cesium.Cartographic(lon, lat, h);
const mat3 = (side) =>
  side === 'geo'
    ? geo.matrix3.fromRotationZ(0.4)
    : Cesium.Matrix3.fromRotationZ(0.4, new Cesium.Matrix3());
const mat4 = (side) =>
  side === 'geo' ? geo.matrix4.create() : new Cesium.Matrix4();
const nanMat4 = (side) => {
  const m = side === 'geo' ? geo.matrix4.create() : new Cesium.Matrix4();
  for (let i = 0; i < 16; i++)
    m[i] = i === 5 ? Number.NaN : i % 5 === 0 ? 1 : 0;
  return m;
};
const vec4 = (side) =>
  side === 'geo' ? { x: 0, y: 0, z: 0, w: 0 } : new Cesium.Cartesian4();
const quat = (side) =>
  side === 'geo' ? geo.quaternion.create() : new Cesium.Quaternion();
const hpr = (h, p, r) => (side) =>
  side === 'geo'
    ? { heading: h, pitch: p, roll: r }
    : new Cesium.HeadingPitchRoll(h, p, r);
const ellipsoid = (side) => (side === 'geo' ? geo.ellipsoid.WGS84 : W);
const value = (v) => () => v;
const list =
  (...v) =>
  () => [...v];

const ZERO = vec(0, 0, 0);
const NAN = vec(1, Number.NaN, 2);
const INF = vec(Number.POSITIVE_INFINITY, 0, 0);
const R = vec(0, 0, 0);
const NaNum = value(Number.NaN);

// [name, geo function, Cesium function, argument builders]
const CASES = [
  ['math.toRadians()', geo.math.toRadians, Cesium.Math.toRadians, []],
  [
    'math.toDegrees(null)',
    geo.math.toDegrees,
    Cesium.Math.toDegrees,
    [value(null)],
  ],
  [
    'math.clamp(str)',
    geo.math.clamp,
    Cesium.Math.clamp,
    [value('5'), value(0), value(2)],
  ],
  ['math.mod(5, 0)', geo.math.mod, Cesium.Math.mod, [value(5), value(0)]],
  ['math.mod(-5, 0)', geo.math.mod, Cesium.Math.mod, [value(-5), value(0)]],
  [
    'math.mod(undefined, 3)',
    geo.math.mod,
    Cesium.Math.mod,
    [value(undefined), value(3)],
  ],
  ['math.zeroToTwoPi()', geo.math.zeroToTwoPi, Cesium.Math.zeroToTwoPi, []],
  [
    'math.negativePiToPi(NaN)',
    geo.math.negativePiToPi,
    Cesium.Math.negativePiToPi,
    [NaNum],
  ],
  [
    'math.equalsEpsilon(null, 1)',
    geo.math.equalsEpsilon,
    Cesium.Math.equalsEpsilon,
    [value(null), value(1), value(0)],
  ],

  [
    'cartesian3.normalize(zero)',
    geo.cartesian3.normalize,
    C3.normalize,
    [ZERO, R],
  ],
  [
    'cartesian3.normalize(NaN)',
    geo.cartesian3.normalize,
    C3.normalize,
    [NAN, R],
  ],
  [
    'cartesian3.normalize(Infinity)',
    geo.cartesian3.normalize,
    C3.normalize,
    [INF, R],
  ],
  ['cartesian3.magnitude(NaN)', geo.cartesian3.magnitude, C3.magnitude, [NAN]],
  [
    'cartesian3.multiplyByScalar(str)',
    geo.cartesian3.multiplyByScalar,
    C3.multiplyByScalar,
    [vec(1, 2, 3), value('2'), R],
  ],
  [
    'cartesian3.divideByScalar(0)',
    geo.cartesian3.divideByScalar,
    C3.divideByScalar,
    [vec(1, -2, 0), value(0), R],
  ],
  [
    'cartesian3.lerp(NaN t)',
    geo.cartesian3.lerp,
    C3.lerp,
    [vec(1, 2, 3), ZERO, NaNum, R],
  ],
  [
    'cartesian3.fromRadians(NaN)',
    geo.cartesian3.fromRadians,
    C3.fromRadians,
    [NaNum, value(0.2), value(10)],
  ],
  [
    'cartesian3.fromRadians(str lat)',
    geo.cartesian3.fromRadians,
    C3.fromRadians,
    [value(0.1), value('0.2')],
  ],
  [
    'cartesian3.fromDegrees(NaN, NaN)',
    geo.cartesian3.fromDegrees,
    C3.fromDegrees,
    [NaNum, NaNum],
  ],
  [
    'cartesian3.fromDegrees(str height)',
    geo.cartesian3.fromDegrees,
    C3.fromDegrees,
    [value(10), value(20), value('5')],
  ],
  [
    'cartesian3.fromDegreesArray([])',
    geo.cartesian3.fromDegreesArray,
    C3.fromDegreesArray,
    [list()],
  ],
  [
    'cartesian3.fromDegreesArray(odd)',
    geo.cartesian3.fromDegreesArray,
    C3.fromDegreesArray,
    [list(1, 2, 3)],
  ],

  [
    'cartographic.fromRadians(NaN)',
    geo.cartographic.fromRadians,
    Cesium.Cartographic.fromRadians,
    [NaNum, value(0.1)],
  ],
  [
    'cartographic.fromDegrees(str)',
    geo.cartographic.fromDegrees,
    Cesium.Cartographic.fromDegrees,
    [value('10'), value(20)],
  ],
  [
    'cartographic.fromCartesian(NaN)',
    geo.cartographic.fromCartesian,
    Cesium.Cartographic.fromCartesian,
    [NAN],
  ],
  [
    'cartographic.fromCartesian(zero)',
    geo.cartographic.fromCartesian,
    Cesium.Cartographic.fromCartesian,
    [ZERO],
  ],
  [
    'cartographic.fromCartesian(Infinity)',
    geo.cartographic.fromCartesian,
    Cesium.Cartographic.fromCartesian,
    [INF],
  ],
  [
    'cartographic.toCartesian(NaN)',
    geo.cartographic.toCartesian,
    Cesium.Cartographic.toCartesian,
    [carto(Number.NaN, 0, 0)],
  ],

  [
    'ellipsoid.create(-1, 2, 3)',
    geo.ellipsoid.create,
    (x, y, z) => new Cesium.Ellipsoid(x, y, z),
    [value(-1), value(2), value(3)],
  ],
  [
    'WGS84.geodeticSurfaceNormal(NaN)',
    geo.ellipsoid.WGS84.geodeticSurfaceNormal,
    (c, r) => W.geodeticSurfaceNormal(c, r),
    [NAN, R],
  ],
  [
    'WGS84.geodeticSurfaceNormal(Infinity)',
    geo.ellipsoid.WGS84.geodeticSurfaceNormal,
    (c, r) => W.geodeticSurfaceNormal(c, r),
    [INF, R],
  ],
  [
    'WGS84.geodeticSurfaceNormalCartographic(NaN)',
    geo.ellipsoid.WGS84.geodeticSurfaceNormalCartographic,
    (c, r) => W.geodeticSurfaceNormalCartographic(c, r),
    [carto(0.1, Number.NaN, 0), R],
  ],
  [
    'WGS84.scaleToGeodeticSurface(NaN)',
    geo.ellipsoid.WGS84.scaleToGeodeticSurface,
    (c, r) => W.scaleToGeodeticSurface(c, r),
    [NAN, R],
  ],
  [
    'WGS84.cartographicToCartesian(NaN)',
    geo.ellipsoid.WGS84.cartographicToCartesian,
    (c, r) => W.cartographicToCartesian(c, r),
    [carto(Number.NaN, 0.1, 5), R],
  ],
  [
    'WGS84.cartesianToCartographic(NaN)',
    geo.ellipsoid.WGS84.cartesianToCartographic,
    (c, r) => W.cartesianToCartographic(c, r),
    [NAN, carto(0, 0, 0)],
  ],

  [
    'matrix3.fromRotationZ(NaN)',
    geo.matrix3.fromRotationZ,
    Cesium.Matrix3.fromRotationZ,
    [NaNum, mat3],
  ],
  [
    'matrix3.getColumn(5)',
    geo.matrix3.getColumn,
    Cesium.Matrix3.getColumn,
    [mat3, value(5), R],
  ],
  [
    'matrix3.getColumn(-1)',
    geo.matrix3.getColumn,
    Cesium.Matrix3.getColumn,
    [mat3, value(-1), R],
  ],
  [
    'matrix4.getColumn(4)',
    geo.matrix4.getColumn,
    Cesium.Matrix4.getColumn,
    [nanMat4, value(4), vec4],
  ],
  [
    'matrix4.inverseTransformation(NaN)',
    geo.matrix4.inverseTransformation,
    Cesium.Matrix4.inverseTransformation,
    [nanMat4, mat4],
  ],
  [
    'matrix4.multiplyByPoint(NaN)',
    geo.matrix4.multiplyByPoint,
    Cesium.Matrix4.multiplyByPoint,
    [nanMat4, NAN, R],
  ],

  [
    'quaternion.fromAxisAngle(zero)',
    geo.quaternion.fromAxisAngle,
    Cesium.Quaternion.fromAxisAngle,
    [ZERO, value(0.5), quat],
  ],
  [
    'quaternion.fromAxisAngle(NaN angle)',
    geo.quaternion.fromAxisAngle,
    Cesium.Quaternion.fromAxisAngle,
    [vec(0, 0, 1), NaNum, quat],
  ],

  [
    'transforms.eastNorthUpToFixedFrame(NaN)',
    geo.transforms.eastNorthUpToFixedFrame,
    Cesium.Transforms.eastNorthUpToFixedFrame,
    [NAN],
  ],
  [
    'transforms.eastNorthUpToFixedFrame(Infinity)',
    geo.transforms.eastNorthUpToFixedFrame,
    Cesium.Transforms.eastNorthUpToFixedFrame,
    [INF],
  ],
  [
    'transforms.eastNorthUpToFixedFrame(zero)',
    geo.transforms.eastNorthUpToFixedFrame,
    Cesium.Transforms.eastNorthUpToFixedFrame,
    [ZERO],
  ],
  [
    'transforms.headingPitchRollToFixedFrame(NaN origin)',
    geo.transforms.headingPitchRollToFixedFrame,
    Cesium.Transforms.headingPitchRollToFixedFrame,
    [NAN, hpr(0.3, -0.2, 0.1)],
  ],
  [
    'transforms.headingPitchRollToFixedFrame(NaN heading)',
    geo.transforms.headingPitchRollToFixedFrame,
    Cesium.Transforms.headingPitchRollToFixedFrame,
    [vec(6378137, 1, 2), hpr(Number.NaN, 0, 0)],
  ],
  [
    'transforms.headingPitchRollToFixedFrame(partial)',
    geo.transforms.headingPitchRollToFixedFrame,
    Cesium.Transforms.headingPitchRollToFixedFrame,
    [vec(6378137, 1, 2), (side) => ({ heading: 0.3 })],
  ],
];

const FIELDS = ['x', 'y', 'z', 'w', 'longitude', 'latitude', 'height'];

/** The numbers a result holds, in a fixed order, so geo and Cesium values compare. */
function numbers(result) {
  if (result === undefined || result === null || typeof result !== 'object') {
    return [result];
  }
  if (Array.isArray(result) || 0 in result) {
    const out = [];
    for (let i = 0; i in result; i++) out.push(numbers(result[i]));
    return out.flat();
  }
  if ('radii' in result) {
    return [
      'radii',
      'radiiSquared',
      'oneOverRadii',
      'oneOverRadiiSquared',
    ].flatMap((key) => numbers(result[key]));
  }
  return FIELDS.filter((key) => key in result).map((key) => result[key]);
}

function outcome(fn, args) {
  try {
    return { values: numbers(fn(...args)) };
  } catch (error) {
    return { error: `${error.name}: ${error.message}` };
  }
}

for (const [name, geoFn, cesiumFn, builders] of CASES) {
  test(`release ${name} matches Build/Cesium`, () => {
    const g = outcome(
      geoFn,
      builders.map((build) => build('geo')),
    );
    const c = outcome(
      cesiumFn,
      builders.map((build) => build('cesium')),
    );
    if (c.error !== undefined || g.error !== undefined) {
      assert.equal(g.error, c.error);
      return;
    }
    assert.equal(g.values.length, c.values.length);
    g.values.forEach((v, i) =>
      assert.ok(
        Object.is(v, c.values[i]),
        `${name}[${i}]: geo ${v}, Cesium ${c.values[i]}`,
      ),
    );
  });
}

test('geo returns NaN for degenerate inputs, as release Cesium does', () => {
  const r = geo.cartesian3.normalize(
    geo.cartesian3.create(),
    geo.cartesian3.create(),
  );
  assert.ok(Number.isNaN(r.x) && Number.isNaN(r.y) && Number.isNaN(r.z));
  const m = geo.transforms.eastNorthUpToFixedFrame(
    geo.cartesian3.create(Number.NaN, 0, 0),
  );
  assert.ok(Number.isNaN(m[0]));
  assert.ok(Number.isNaN(geo.math.mod(5, 0)));
});
