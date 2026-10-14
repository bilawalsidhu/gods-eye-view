// Argument-check parity with Cesium. gev runs Cesium from source, where its
// debug checks are live, so for any input both sides must throw an error with
// the same name and message, or neither may throw. The inputs are seeded and
// deterministic: each case builds its arguments twice from the same seed, once
// for geo and once for Cesium, so no object is shared between the two sides.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import * as geo from './index.js';
import { DeveloperError } from './developerError.js';

const TRIALS = 150;

function generator(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Invalid values every argument may receive. NaN is a number to Check.typeOf.number
// and null an object to Check.typeOf.object, so both reach the arithmetic.
const INVALID = [undefined, null, Number.NaN, 'abc', 5, true, {}];

const vectorValues = { x: 1.5, y: -2, z: 3 };
const VALID = {
  num: (side, random) => [0, -0, 0.7, -2.5, 1e6][Math.floor(random() * 5)],
  index3: (side, random) => Math.floor(random() * 5) - 1,
  index4: (side, random) => Math.floor(random() * 6) - 1,
  nonNegative: (side, random) => [0, 3, 6378137, -1][Math.floor(random() * 4)],
  vec: (side) =>
    side === 'geo' ? { ...vectorValues } : new Cesium.Cartesian3(1.5, -2, 3),
  zeroVec: (side) =>
    side === 'geo' ? { x: 0, y: 0, z: 0 } : new Cesium.Cartesian3(),
  vec4: (side) =>
    side === 'geo' ? { x: 0, y: 0, z: 0, w: 0 } : new Cesium.Cartesian4(),
  carto: (side) =>
    side === 'geo'
      ? { longitude: 0.3, latitude: -0.2, height: 10 }
      : new Cesium.Cartographic(0.3, -0.2, 10),
  partialCarto: (side) =>
    side === 'geo'
      ? { longitude: 0.3, latitude: -0.2 }
      : { longitude: 0.3, latitude: -0.2 },
  quat: (side) =>
    side === 'geo'
      ? { x: 0.1, y: 0.2, z: 0.3, w: 0.9 }
      : new Cesium.Quaternion(0.1, 0.2, 0.3, 0.9),
  mat3: (side) =>
    side === 'geo'
      ? geo.matrix3.fromRotationZ(0.4)
      : Cesium.Matrix3.fromRotationZ(0.4, new Cesium.Matrix3()),
  mat4: (side) =>
    side === 'geo'
      ? geo.transforms.eastNorthUpToFixedFrame({ x: 6378137, y: 1, z: 2 })
      : Cesium.Transforms.eastNorthUpToFixedFrame(
          new Cesium.Cartesian3(6378137, 1, 2),
        ),
  hpr: (side) =>
    side === 'geo'
      ? { heading: 0.3, pitch: -0.2, roll: 0.1 }
      : new Cesium.HeadingPitchRoll(0.3, -0.2, 0.1),
  partialHpr: () => ({ heading: 0.3 }),
  ellipsoid: (side) =>
    side === 'geo' ? geo.ellipsoid.WGS84 : Cesium.Ellipsoid.WGS84,
  coords2: (side, random) =>
    [[1, 2], [1, 2, 3], [], [1, 2, 3, 4]][Math.floor(random() * 4)],
  coords3: (side, random) =>
    [[1, 2, 3], [1, 2], [], [1, 2, 3, 4, 5, 6], [1, 2, 'h']][
      Math.floor(random() * 5)
    ],
  nanVec: (side) =>
    side === 'geo'
      ? { x: 1, y: Number.NaN, z: 2 }
      : new Cesium.Cartesian3(1, Number.NaN, 2),
  partialVec: () => ({ x: 1, y: 2 }),
  stringHeight: () => '5',
};

/** One argument: usually a valid value of its kind, sometimes an invalid one. */
function argument(kinds, side, random) {
  if (random() < 0.4) return INVALID[Math.floor(random() * INVALID.length)];
  const kind = kinds[Math.floor(random() * kinds.length)];
  return VALID[kind](side, random);
}

const W = Cesium.Ellipsoid.WGS84;
const C3 = Cesium.Cartesian3;
const V = ['vec', 'zeroVec', 'nanVec', 'partialVec'];
const N = ['num'];
const R = ['vec'];

// [name, geo function, Cesium function, argument kinds per position]
const CASES = [
  ['math.toRadians', geo.math.toRadians, Cesium.Math.toRadians, [N]],
  ['math.toDegrees', geo.math.toDegrees, Cesium.Math.toDegrees, [N]],
  ['math.clamp', geo.math.clamp, Cesium.Math.clamp, [N, N, N]],
  ['math.lerp', geo.math.lerp, Cesium.Math.lerp, [N, N, N]],
  ['math.mod', geo.math.mod, Cesium.Math.mod, [N, ['num', 'nonNegative']]],
  ['math.zeroToTwoPi', geo.math.zeroToTwoPi, Cesium.Math.zeroToTwoPi, [N]],
  [
    'math.negativePiToPi',
    geo.math.negativePiToPi,
    Cesium.Math.negativePiToPi,
    [N],
  ],
  [
    'math.equalsEpsilon',
    geo.math.equalsEpsilon,
    Cesium.Math.equalsEpsilon,
    [N, N, N, N],
  ],

  ['cartesian2.clone', geo.cartesian2.clone, Cesium.Cartesian2.clone, [R, R]],
  [
    'cartesian2.distance',
    geo.cartesian2.distance,
    Cesium.Cartesian2.distance,
    [R, R],
  ],

  ['cartesian3.clone', geo.cartesian3.clone, C3.clone, [V, R]],
  [
    'cartesian3.fromElements',
    geo.cartesian3.fromElements,
    C3.fromElements,
    [N, N, N, R],
  ],
  ['cartesian3.magnitude', geo.cartesian3.magnitude, C3.magnitude, [V]],
  [
    'cartesian3.magnitudeSquared',
    geo.cartesian3.magnitudeSquared,
    C3.magnitudeSquared,
    [V],
  ],
  ['cartesian3.distance', geo.cartesian3.distance, C3.distance, [V, V]],
  [
    'cartesian3.distanceSquared',
    geo.cartesian3.distanceSquared,
    C3.distanceSquared,
    [V, V],
  ],
  ['cartesian3.normalize', geo.cartesian3.normalize, C3.normalize, [V, R]],
  ['cartesian3.dot', geo.cartesian3.dot, C3.dot, [V, V]],
  [
    'cartesian3.multiplyComponents',
    geo.cartesian3.multiplyComponents,
    C3.multiplyComponents,
    [V, V, R],
  ],
  ['cartesian3.add', geo.cartesian3.add, C3.add, [V, V, R]],
  ['cartesian3.subtract', geo.cartesian3.subtract, C3.subtract, [V, V, R]],
  [
    'cartesian3.multiplyByScalar',
    geo.cartesian3.multiplyByScalar,
    C3.multiplyByScalar,
    [V, N, R],
  ],
  [
    'cartesian3.divideByScalar',
    geo.cartesian3.divideByScalar,
    C3.divideByScalar,
    [V, N, R],
  ],
  ['cartesian3.negate', geo.cartesian3.negate, C3.negate, [V, R]],
  ['cartesian3.lerp', geo.cartesian3.lerp, C3.lerp, [V, V, N, R]],
  ['cartesian3.cross', geo.cartesian3.cross, C3.cross, [V, V, R]],
  ['cartesian3.midpoint', geo.cartesian3.midpoint, C3.midpoint, [V, V, R]],
  ['cartesian3.equals', geo.cartesian3.equals, C3.equals, [V, V]],
  [
    'cartesian3.equalsEpsilon',
    geo.cartesian3.equalsEpsilon,
    C3.equalsEpsilon,
    [V, V, N, N],
  ],
  [
    'cartesian3.fromRadians',
    geo.cartesian3.fromRadians,
    C3.fromRadians,
    [N, N, ['num', 'stringHeight'], ['ellipsoid'], R],
  ],
  [
    'cartesian3.fromDegrees',
    geo.cartesian3.fromDegrees,
    C3.fromDegrees,
    [N, N, ['num', 'stringHeight'], ['ellipsoid'], R],
  ],
  [
    'cartesian3.fromDegreesArray',
    geo.cartesian3.fromDegreesArray,
    C3.fromDegreesArray,
    [['coords2'], ['ellipsoid']],
  ],
  [
    'cartesian3.fromDegreesArrayHeights',
    geo.cartesian3.fromDegreesArrayHeights,
    C3.fromDegreesArrayHeights,
    [['coords3'], ['ellipsoid']],
  ],

  [
    'cartographic.fromRadians',
    geo.cartographic.fromRadians,
    Cesium.Cartographic.fromRadians,
    [N, N, N, ['carto']],
  ],
  [
    'cartographic.fromDegrees',
    geo.cartographic.fromDegrees,
    Cesium.Cartographic.fromDegrees,
    [N, N, N, ['carto']],
  ],
  [
    'cartographic.fromCartesian',
    geo.cartographic.fromCartesian,
    Cesium.Cartographic.fromCartesian,
    [V, ['ellipsoid'], ['carto']],
  ],
  [
    'cartographic.toCartesian',
    geo.cartographic.toCartesian,
    Cesium.Cartographic.toCartesian,
    [['carto', 'partialCarto'], ['ellipsoid'], R],
  ],
  [
    'cartographic.clone',
    geo.cartographic.clone,
    Cesium.Cartographic.clone,
    [['carto'], ['carto']],
  ],

  [
    'ellipsoid.create',
    geo.ellipsoid.create,
    (x, y, z) => new Cesium.Ellipsoid(x, y, z),
    [['nonNegative'], ['nonNegative'], ['nonNegative']],
  ],
  [
    'WGS84.geodeticSurfaceNormal',
    geo.ellipsoid.WGS84.geodeticSurfaceNormal,
    (c, r) => W.geodeticSurfaceNormal(c, r),
    [V, R],
  ],
  [
    'WGS84.geodeticSurfaceNormalCartographic',
    geo.ellipsoid.WGS84.geodeticSurfaceNormalCartographic,
    (c, r) => W.geodeticSurfaceNormalCartographic(c, r),
    [['carto', 'partialCarto'], R],
  ],
  [
    'WGS84.scaleToGeodeticSurface',
    geo.ellipsoid.WGS84.scaleToGeodeticSurface,
    (c, r) => W.scaleToGeodeticSurface(c, r),
    [V, R],
  ],
  [
    'WGS84.cartographicToCartesian',
    geo.ellipsoid.WGS84.cartographicToCartesian,
    (c, r) => W.cartographicToCartesian(c, r),
    [['carto', 'partialCarto'], R],
  ],
  [
    'WGS84.cartesianToCartographic',
    geo.ellipsoid.WGS84.cartesianToCartographic,
    (c, r) => W.cartesianToCartographic(c, r),
    [V, ['carto']],
  ],

  [
    'matrix3.fromQuaternion',
    geo.matrix3.fromQuaternion,
    Cesium.Matrix3.fromQuaternion,
    [['quat'], ['mat3']],
  ],
  [
    'matrix3.fromRotationZ',
    geo.matrix3.fromRotationZ,
    Cesium.Matrix3.fromRotationZ,
    [N, ['mat3']],
  ],
  [
    'matrix3.multiplyByVector',
    geo.matrix3.multiplyByVector,
    Cesium.Matrix3.multiplyByVector,
    [['mat3'], V, R],
  ],
  [
    'matrix3.getColumn',
    geo.matrix3.getColumn,
    Cesium.Matrix3.getColumn,
    [['mat3'], ['index3'], R],
  ],

  [
    'matrix4.clone',
    geo.matrix4.clone,
    Cesium.Matrix4.clone,
    [['mat4'], ['mat4']],
  ],
  [
    'matrix4.equals',
    geo.matrix4.equals,
    Cesium.Matrix4.equals,
    [['mat4'], ['mat4']],
  ],
  [
    'matrix4.multiply',
    geo.matrix4.multiply,
    Cesium.Matrix4.multiply,
    [['mat4'], ['mat4'], ['mat4']],
  ],
  [
    'matrix4.multiplyTransformation',
    geo.matrix4.multiplyTransformation,
    Cesium.Matrix4.multiplyTransformation,
    [['mat4'], ['mat4'], ['mat4']],
  ],
  [
    'matrix4.multiplyByPoint',
    geo.matrix4.multiplyByPoint,
    Cesium.Matrix4.multiplyByPoint,
    [['mat4'], V, R],
  ],
  [
    'matrix4.multiplyByPointAsVector',
    geo.matrix4.multiplyByPointAsVector,
    Cesium.Matrix4.multiplyByPointAsVector,
    [['mat4'], V, R],
  ],
  [
    'matrix4.getTranslation',
    geo.matrix4.getTranslation,
    Cesium.Matrix4.getTranslation,
    [['mat4'], R],
  ],
  [
    'matrix4.getMatrix3',
    geo.matrix4.getMatrix3,
    Cesium.Matrix4.getMatrix3,
    [['mat4'], ['mat3']],
  ],
  [
    'matrix4.getColumn',
    geo.matrix4.getColumn,
    Cesium.Matrix4.getColumn,
    [['mat4'], ['index4'], ['vec4']],
  ],
  [
    'matrix4.inverseTransformation',
    geo.matrix4.inverseTransformation,
    Cesium.Matrix4.inverseTransformation,
    [['mat4'], ['mat4']],
  ],
  [
    'matrix4.fromRotationTranslation',
    geo.matrix4.fromRotationTranslation,
    Cesium.Matrix4.fromRotationTranslation,
    [['mat3'], R, ['mat4']],
  ],
  [
    'matrix4.fromUniformScale',
    geo.matrix4.fromUniformScale,
    Cesium.Matrix4.fromUniformScale,
    [N, ['mat4']],
  ],

  [
    'quaternion.fromAxisAngle',
    geo.quaternion.fromAxisAngle,
    Cesium.Quaternion.fromAxisAngle,
    [V, N, ['quat']],
  ],
  [
    'quaternion.fromRotationMatrix',
    geo.quaternion.fromRotationMatrix,
    Cesium.Quaternion.fromRotationMatrix,
    [['mat3'], ['quat']],
  ],

  [
    'transforms.eastNorthUpToFixedFrame',
    geo.transforms.eastNorthUpToFixedFrame,
    Cesium.Transforms.eastNorthUpToFixedFrame,
    [V, ['ellipsoid'], ['mat4']],
  ],
  [
    'transforms.headingPitchRollToFixedFrame',
    geo.transforms.headingPitchRollToFixedFrame,
    Cesium.Transforms.headingPitchRollToFixedFrame,
    [V, ['hpr', 'partialHpr'], ['ellipsoid'], [], ['mat4']],
  ],
];

function outcome(fn, args) {
  try {
    fn(...args);
    return 'returned';
  } catch (error) {
    return `${error?.name}: ${error?.message}`;
  }
}

test('every ported function throws exactly where Cesium does, with the same name and message', () => {
  let thrown = 0;
  let checked = 0;
  const mismatches = [];
  CASES.forEach(([name, ours, theirs, kinds], caseIndex) => {
    for (let trial = 0; trial < TRIALS; trial++) {
      const seed = caseIndex * 100003 + trial;
      // Trial 0 passes no arguments at all; the rest draw from the pools.
      const build = (side) => {
        if (trial === 0) return [];
        const random = generator(seed);
        return kinds.map((k) =>
          k.length ? argument(k, side, random) : undefined,
        );
      };
      const a = outcome(ours, build('geo'));
      const b = outcome(theirs, build('cesium'));
      if (a !== b)
        mismatches.push(`${name} (seed ${seed}): geo ${a} | Cesium ${b}`);
      checked++;
      if (b !== 'returned') thrown++;
    }
  });
  assert.deepEqual(mismatches, []);
  // The pools must actually reach the checks.
  assert.ok(thrown > checked / 4, `only ${thrown} of ${checked} cases threw`);
});

test('the checks throw a DeveloperError with Cesium message text', () => {
  const cases = [
    [() => geo.math.toRadians(undefined), 'degrees is required.'],
    [() => geo.math.mod(5, 0), 'divisor cannot be 0.'],
    [
      () => geo.math.clamp('1', 0, 1),
      'Expected value to be typeof number, actual typeof was string',
    ],
    [
      () => geo.cartesian3.fromDegrees(undefined, 1),
      'Expected longitude to be typeof number, actual typeof was undefined',
    ],
    [
      () => geo.cartesian3.add({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }),
      'Expected result to be typeof object, actual typeof was undefined',
    ],
    [
      () => geo.cartesian3.fromDegreesArray([1]),
      'the number of coordinates must be a multiple of 2 and at least 2',
    ],
    [
      () => geo.cartesian3.fromDegreesArray(),
      'coordinates is required, actual value was undefined',
    ],
    [
      () => geo.ellipsoid.create(-1, 1, 1),
      'Expected x to be greater than or equal to 0, actual value was -1',
    ],
    [
      () => geo.matrix3.getColumn(geo.matrix3.create(), 3, {}),
      'Expected index to be less than or equal to 2, actual value was 3',
    ],
    [
      () =>
        geo.transforms.eastNorthUpToFixedFrame({ x: 1, y: Number.NaN, z: 0 }),
      'origin has a NaN component',
    ],
    [
      () => geo.cartographic.fromCartesian({ x: 1, y: 2, z: 3 }, {}),
      'oneOverRadii is required.',
    ],
  ];
  for (const [fn, message] of cases) {
    assert.throws(fn, (error) => {
      assert.ok(error instanceof DeveloperError);
      assert.equal(error.name, 'DeveloperError');
      assert.equal(error.message, message);
      return true;
    });
  }
  // NaN is typeof number, so Check.typeOf.number lets it through (as in Cesium).
  assert.ok(Number.isNaN(geo.math.clamp(Number.NaN, 0, 1)));
  assert.ok(Number.isNaN(Cesium.Math.clamp(Number.NaN, 0, 1)));
});
