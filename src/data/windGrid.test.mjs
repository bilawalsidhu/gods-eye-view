import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resampleWindGrid,
  resampleWeatherFields,
} from '../../server/providers/wind/grid.js';

test('resamples and wraps a wind grid', () => {
  const r = resampleWindGrid({
    ni: 4,
    nj: 3,
    lo1: 0,
    la1: 90,
    di: 90,
    dj: 90,
    u: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
    v: new Array(12).fill(1),
    dx: 90,
    dy: 90,
  });
  assert.deepEqual([r.nx, r.ny], [4, 3]);
  assert.equal(r.u[0], 0);
  assert.equal(r.u[3], 3);
  assert.equal(r.u[4], 4);
});

const component = (values, extra = {}) => ({
  ni: 4,
  nj: 3,
  lo1: 0,
  la1: 90,
  di: 90,
  dj: 90,
  values: new Float64Array(12).fill(values),
  ...extra,
});

test('weather resampling converts temperature and MSL pressure on the wind geometry', () => {
  const u = component(3);
  const v = component(-4);
  for (const [overlay, raw, units, expected, outUnits] of [
    ['temperature', 293.15, 'K', 20, '°C'],
    ['pressure', 101325, 'Pa', 1013.25, 'hPa'],
  ]) {
    const result = resampleWeatherFields({
      u,
      v,
      scalar: component(raw, { units }),
      overlay,
      targetDx: 90,
    });
    assert.equal(result.scalar.kind, overlay);
    assert.equal(result.scalar.units, outUnits);
    assert.deepEqual([...result.grid.u], Array(12).fill(3));
    assert.deepEqual([...result.grid.v], Array(12).fill(-4));
    assert.ok(result.grid.scalar.every((n) => Math.abs(n - expected) < 0.0001));
  }
  assert.equal(
    'scalar' in resampleWeatherFields({ u, v, targetDx: 90 }).grid,
    false,
  );
});

test('weather components cannot share a grid when shifted, truncated or non-finite', () => {
  const u = component(1);
  const v = component(2);
  const scalar = component(273.15, { units: 'K' });
  for (const bad of [
    { ...v, lo1: 90 },
    { ...v, ni: 3 },
    { ...v, dj: 45 },
  ]) {
    assert.throws(() => resampleWeatherFields({ u, v: bad }), /Mismatched/);
  }
  assert.throws(
    () =>
      resampleWeatherFields({
        u,
        v,
        scalar: { ...scalar, la1: 89 },
        overlay: 'temperature',
      }),
    /Mismatched/,
  );
  assert.throws(
    () =>
      resampleWeatherFields({
        u,
        v,
        scalar: { ...scalar, units: '°C' },
        overlay: 'temperature',
      }),
    /units/,
  );
  assert.throws(
    () =>
      resampleWeatherFields({
        u,
        v,
        scalar: { ...scalar, values: [1] },
        overlay: 'temperature',
      }),
    /geometry/,
  );
  const invalid = component(1);
  invalid.values[5] = NaN;
  assert.throws(
    () => resampleWeatherFields({ u, v: invalid, targetDx: 180 }),
    /values/,
  );
  assert.throws(
    () =>
      resampleWeatherFields({
        u,
        v,
        scalar: { ...scalar, values: invalid.values },
        overlay: 'temperature',
      }),
    /values/,
  );
  assert.throws(
    () => resampleWeatherFields({ u, v, overlay: 'dewpoint' }),
    /Unknown/,
  );
});

test('optional degradation cannot hide invalid wind geometry', async () => {
  const { resampleWeatherSnapshot } =
    await import('../../server/providers/wind/grid.js');
  const u = component(1);
  const v = component(2);
  const result = resampleWeatherSnapshot({
    u,
    v,
    overlay: 'pressure',
    targetDx: 90,
  });
  assert.equal(result.scalarError, 'Mean sea level pressure field unavailable');
  assert.equal(result.grid.scalar, undefined);
  assert.throws(
    () =>
      resampleWeatherSnapshot({ u, v: { ...v, la1: 89 }, overlay: 'pressure' }),
    /Mismatched/,
  );
  assert.throws(
    () =>
      resampleWindGrid({ ...u, u: u.values, v: v.values, dx: 0.25, dy: 0.25 }),
    /budget/,
  );
});
