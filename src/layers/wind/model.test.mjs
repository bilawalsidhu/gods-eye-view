import test from 'node:test';
import assert from 'node:assert/strict';
import {
  advectParticle,
  intersectBounds,
  sampleWind,
  windColor,
} from './model.js';

const field = {
  u: Float32Array.from([1, 2, 3, 4]),
  v: Float32Array.from([5, 6, 7, 8]),
  nx: 2,
  ny: 2,
  lo1: 0,
  la1: 90,
  dx: 180,
  dy: 90,
};

test('sampleWind interpolates, wraps, clamps, and rejects non-finite input', () => {
  assert.deepEqual(sampleWind(field, 0, 90), { u: 1, v: 5 });
  assert.deepEqual(sampleWind(field, 90, 45), { u: 2.5, v: 6.5 });
  assert.deepEqual(sampleWind(field, 359.99, 90), sampleWind(field, -0.01, 90));
  assert.deepEqual(sampleWind(field, 0, 100), { u: 1, v: 5 });
  assert.deepEqual(sampleWind(field, Infinity, 0), { u: 0, v: 0 });
});

test('advectParticle moves and constrains particles', () => {
  const particle = { lon: 179, lat: 88 };
  advectParticle(particle, { u: 10, v: 100 }, 3600);
  assert.ok(particle.lon < 0);
  assert.equal(particle.lat, 89);
});

test('windColor returns a monotonic ramp string', () => {
  assert.equal(typeof windColor(0), 'string');
  assert.notEqual(windColor(0), windColor(30));
});

const regional = {
  // 3 columns from lon 170 eastward (170, 175, 180), 2 rows (la1 10, 5).
  u: Float32Array.from([1, 2, 3, 4, 5, 6]),
  v: Float32Array.from([0, 0, 0, 0, 0, 0]),
  nx: 3,
  ny: 2,
  lo1: 170,
  la1: 10,
  dx: 5,
  dy: 5,
  periodic: false,
  noData: -9999,
};

test('non-periodic grid across the antimeridian samples inside and rejects outside', () => {
  assert.deepEqual(sampleWind(regional, 172.5, 10), { u: 1.5, v: 0 });
  assert.deepEqual(sampleWind(regional, -180, 10), { u: 3, v: 0 });
  assert.deepEqual(sampleWind(regional, 180, 5), { u: 6, v: 0 });
  for (const [lon, lat] of [
    [169, 8],
    [-179, 8],
    [175, 11],
    [175, 4],
  ]) {
    const sample = sampleWind(regional, lon, lat);
    assert.ok(
      Number.isNaN(sample.u) && Number.isNaN(sample.v),
      `(${lon}, ${lat})`,
    );
  }
});

test('a no-data corner invalidates the whole bilinear sample', () => {
  const gapped = {
    ...regional,
    u: Float32Array.from([1, -9999, 3, 4, 5, 6]),
    v: Float32Array.from([0, -9999, 0, 0, 0, 0]),
  };
  assert.ok(Number.isNaN(sampleWind(gapped, 172.5, 10).u));
  assert.ok(Number.isNaN(sampleWind(gapped, 172.5, 7.5).u));
  assert.deepEqual(sampleWind(gapped, 177.5, 5), { u: 5.5, v: 0 });
  // Exactly on the last column: the wrapped neighbour carries no weight and is not consulted.
  assert.deepEqual(
    sampleWind(
      { ...regional, u: Float32Array.from([-9999, 2, 3, -9999, 5, 6]) },
      180,
      10,
    ),
    { u: 3, v: 0 },
  );
});

test('periodic fields ignore the sentinel keys and keep wrapping', () => {
  const periodic = { ...field, noData: undefined, periodic: undefined };
  assert.deepEqual(
    sampleWind(periodic, 359.99, 90),
    sampleWind(field, -0.01, 90),
  );
  assert.deepEqual(
    sampleWind({ ...field, periodic: true, noData: -9999 }, 0, 100),
    { u: 1, v: 5 },
  );
});

test('intersectBounds clips the view to the field box and reports an empty overlap', () => {
  const view = {
    west: -30,
    east: 30,
    sinSouth: Math.sin(-Math.PI / 6),
    sinNorth: Math.sin(Math.PI / 6),
  };
  const box = { latMin: 0, latMax: 60, lonMin: 10, lonMax: 50 };
  const out = intersectBounds(view, box);
  assert.equal(out.west, 10);
  assert.equal(out.east, 30);
  assert.equal(out.sinSouth, 0);
  assert.ok(Math.abs(out.sinNorth - Math.sin(Math.PI / 6)) < 1e-12);
  assert.equal(
    intersectBounds(view, { latMin: 40, latMax: 60, lonMin: 10, lonMax: 50 }),
    null,
  );
  assert.equal(intersectBounds(view, null), view);
  // Field box across the antimeridian meets a view east of it.
  const east = intersectBounds(
    { west: 170, east: 200, sinSouth: -0.5, sinNorth: 0.5 },
    { latMin: -10, latMax: 10, lonMin: 160, lonMax: -170 },
  );
  assert.equal(east.west, 170);
  assert.equal(east.east, 190);
});
