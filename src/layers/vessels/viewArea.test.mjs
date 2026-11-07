import test from 'node:test';
import assert from 'node:assert/strict';
import {
  VIEW_AREA_MAX_RADIUS_KM,
  VIEW_AREA_MIN_RADIUS_KM,
  viewAreaMovedEnough,
  viewAreaRadiusKm,
} from './viewArea.js';

test('the area asked for follows the camera height, and a wide view asks for every vessel', () => {
  assert.equal(viewAreaRadiusKm(2_000), VIEW_AREA_MIN_RADIUS_KM);
  assert.equal(viewAreaRadiusKm(80_000), 80);
  assert.equal(
    viewAreaRadiusKm(VIEW_AREA_MAX_RADIUS_KM * 1000),
    VIEW_AREA_MAX_RADIUS_KM,
  );
  assert.equal(viewAreaRadiusKm(VIEW_AREA_MAX_RADIUS_KM * 1000 + 1), null);
  assert.equal(viewAreaRadiusKm(Number.NaN), null);
});

test('a view asks again only after moving or zooming a quarter of its radius', () => {
  const here = { lat: 37.8, lon: -122.4, radiusKm: 40 };
  assert.equal(viewAreaMovedEnough(null, here), true);
  assert.equal(viewAreaMovedEnough(here, null), true);
  assert.equal(viewAreaMovedEnough(null, null), false);
  assert.equal(viewAreaMovedEnough(here, { ...here, lat: 37.85 }), false);
  assert.equal(viewAreaMovedEnough(here, { ...here, lat: 37.9 }), true);
  assert.equal(viewAreaMovedEnough(here, { ...here, radiusKm: 45 }), false);
  assert.equal(viewAreaMovedEnough(here, { ...here, radiusKm: 55 }), true);
});
