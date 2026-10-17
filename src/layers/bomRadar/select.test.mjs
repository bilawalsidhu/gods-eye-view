import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BOM_MID_HEIGHT_M,
  BOM_NEAR_HEIGHT_M,
  bomRangePreference,
  distanceKm,
  pickBomProduct,
} from './select.js';

// Radar centres as the proxy learns them from the .map files.
const ADELAIDE = { lat: -34.617, lon: 138.469 };
const SELLICKS = { lat: -35.33, lon: 138.5 };
const WOOMERA = { lat: -31.15, lon: 136.8 };
const SYDNEY = { lat: -33.7, lon: 151.2 };
const radars = [
  {
    id: '64',
    products: ['IDR641', 'IDR642', 'IDR643', 'IDR644'],
    center: ADELAIDE,
  },
  { id: '46', products: ['IDR461', 'IDR462', 'IDR463'], center: SELLICKS },
  { id: '27', products: ['IDR271', 'IDR272', 'IDR273'], center: WOOMERA },
  { id: '71', products: ['IDR713'], center: SYDNEY },
  // Centre not learned yet: never a candidate.
  { id: '33', products: ['IDR333'] },
];
const at = (lat, lon) => ({ lat, lon });

test('altitude chooses the preferred range with ordered fallbacks', () => {
  assert.deepEqual(bomRangePreference(1_000), [64, 128, 256, 512]);
  assert.deepEqual(
    bomRangePreference(BOM_NEAR_HEIGHT_M - 1),
    [64, 128, 256, 512],
  );
  assert.deepEqual(bomRangePreference(BOM_NEAR_HEIGHT_M), [128, 256, 64, 512]);
  assert.deepEqual(
    bomRangePreference(BOM_MID_HEIGHT_M - 1),
    [128, 256, 64, 512],
  );
  assert.deepEqual(bomRangePreference(BOM_MID_HEIGHT_M), [256, 512, 128, 64]);
  assert.deepEqual(bomRangePreference(30_000_000), [256, 512, 128, 64]);
  assert.deepEqual(bomRangePreference(NaN), [256, 512, 128, 64]);
});

test('distance is great-circle kilometres', () => {
  assert.equal(distanceKm(ADELAIDE, ADELAIDE), 0);
  assert.ok(Math.abs(distanceKm(ADELAIDE, SYDNEY) - 1165) < 15);
});

test('low over Adelaide picks the 64 km product of the nearest radar', () => {
  const pick = pickBomProduct({
    radars,
    view: at(-34.6, 138.5),
    height: 20_000,
  });
  assert.equal(pick.product, 'IDR644');
  assert.equal(pick.radarId, '64');
  assert.equal(pick.rangeKm, 64);
  assert.ok(pick.distanceKm < 10);
});

test('mid altitude picks 128 km and high altitude picks 256 km', () => {
  const view = at(-34.6, 138.5);
  assert.equal(
    pickBomProduct({ radars, view, height: 300_000 }).product,
    'IDR643',
  );
  assert.equal(
    pickBomProduct({ radars, view, height: 2_000_000 }).product,
    'IDR642',
  );
});

test('the nearest radar with a centre wins, not the one with most products', () => {
  const pick = pickBomProduct({
    radars,
    view: at(-35.4, 138.6),
    height: 20_000,
  });
  assert.equal(pick.radarId, '46');
  // Sellicks Hill has no 64 km product in this listing: fall back to 128 km.
  assert.equal(pick.product, 'IDR463');
  assert.equal(
    pickBomProduct({ radars, view: at(-31.2, 136.9), height: 20_000 }).radarId,
    '27',
  );
});

test('a view beyond every product range gets no radar', () => {
  // Alice Springs is far from every centre in this list.
  assert.equal(
    pickBomProduct({ radars, view: at(-23.7, 133.9), height: 300_000 }),
    null,
  );
  // 100 km out: the 64 km product cannot reach it, so the next range is used.
  const pick = pickBomProduct({
    radars: [radars[0]],
    view: at(-34.617, 139.62),
    height: 20_000,
  });
  assert.equal(pick.rangeKm, 128);
});

test('a missing or unusable view, or no radars, gives no pick', () => {
  assert.equal(pickBomProduct({ radars: [], view: ADELAIDE, height: 1 }), null);
  assert.equal(pickBomProduct({ radars, view: null, height: 1 }), null);
  assert.equal(pickBomProduct({ radars, view: at(NaN, 138), height: 1 }), null);
  assert.equal(
    pickBomProduct({ radars: null, view: ADELAIDE, height: 1 }),
    null,
  );
  assert.equal(
    pickBomProduct({
      radars: [{ id: '64', products: ['IDR64I'], center: ADELAIDE }],
      view: ADELAIDE,
      height: 1,
    }),
    null,
  );
});

test('the current product is kept through small camera and altitude changes', () => {
  const view = at(-34.9, 138.6);
  // 150 km altitude would prefer 128 km, but 64 km is current and within the margin.
  assert.equal(
    pickBomProduct({ radars, view, height: 160_000, current: 'IDR644' })
      .product,
    'IDR644',
  );
  // Well past the margin, it changes.
  assert.equal(
    pickBomProduct({ radars, view, height: 400_000, current: 'IDR644' })
      .product,
    'IDR643',
  );
  // A slightly closer neighbour does not steal the view; a clearly closer one does.
  const between = at(-34.95, 138.5);
  const keep = pickBomProduct({
    radars,
    view: between,
    height: 20_000,
    current: 'IDR644',
  });
  assert.equal(keep.radarId, '64');
  const switched = pickBomProduct({
    radars,
    view: at(-35.4, 138.5),
    height: 20_000,
    current: 'IDR644',
  });
  assert.equal(switched.radarId, '46');
});

test('a current product whose range no longer reaches the view is dropped', () => {
  const pick = pickBomProduct({
    radars: [radars[0]],
    view: at(-34.617, 139.62),
    height: 20_000,
    current: 'IDR644',
  });
  assert.equal(pick.product, 'IDR643');
});
