import test from 'node:test';
import assert from 'node:assert/strict';
import * as geo from '../../geo/index.js';
import { createModel } from './model.js';

const model = createModel({ state: {}, services: {}, parts: {}, source: {} });

test('installation distance prefilter wraps the date line and stays conservative at high latitudes', () => {
  const from = geo.math.toRadians(179.8);
  const distance = model.approximateSurfaceDistanceM(
    geo.math.toRadians(70),
    from,
    69.9,
    -179.8,
  );
  const start = geo.cartographic.fromDegrees(179.8, 70);
  const end = geo.cartographic.fromDegrees(-179.8, 69.9);
  const exact = geo.ellipsoidGeodesic.create(start, end).surfaceDistance;

  assert.ok(distance > 0 && distance < 50_000);
  assert.ok(distance >= exact * 0.99);
  assert.ok(distance <= exact * 1.03);
});

test('installation model returns engine-neutral palette and source presentation', () => {
  const record = {
    class: 'military_land',
    sources: [
      { name: 'OpenStreetMap', id: 'way:1' },
      { name: 'OpenStreetMap', id: 'relation:2' },
      { name: 'Bundled registry', id: 'registry:3' },
    ],
  };

  assert.deepEqual(model.colorFor(record).rgba(), [
    156 / 255,
    166 / 255,
    176 / 255,
    1,
  ]);
  assert.equal(
    model.installationSourceLabel(record),
    'OpenStreetMap + Bundled registry',
  );
});
