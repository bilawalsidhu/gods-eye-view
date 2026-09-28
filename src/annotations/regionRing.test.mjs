import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FEATURE_SOURCE_METHODS } from '../sources/featureSource.js';
import { createAnnotationResolver } from './resolver.js';

function featureSource(overrides = {}) {
  const source = {};
  for (const method of FEATURE_SOURCE_METHODS)
    source[method] = async () => null;
  return Object.assign(source, overrides);
}

const texasGeocode = {
  async geocode() {
    return {
      place: {
        lat: 31.0,
        lng: -99.9,
        label: 'Texas, USA',
        name: 'Texas',
        types: ['administrative_area_level_1', 'political'],
      },
    };
  },
};

test('region ring: Natural Earth names resolve without a geocoder', async () => {
  const { resolveRegionRingForQuery } = createAnnotationResolver({
    featureSource: featureSource(),
  });
  for (const name of ['Gulf of Mexico', 'the Alps']) {
    const region = await resolveRegionRingForQuery(name);
    assert.ok(region?.ring?.length >= 3, `${name} resolves to a ring`);
    assert.equal(region.error, undefined);
  }
});

test('region ring: a slow admin-boundary lookup returns region-timeout within the budget', async () => {
  let adminSignal;
  let release;
  const { resolveRegionRingForQuery } = createAnnotationResolver({
    featureSource: featureSource({
      getAdministrativeAreas(_point, { signal }) {
        adminSignal = signal;
        return new Promise((resolve) => {
          release = resolve;
        });
      },
    }),
  });
  const started = Date.now();
  const region = await resolveRegionRingForQuery(
    'Texas',
    undefined,
    texasGeocode,
    { budgetMs: 50 },
  );
  assert.deepEqual(region, {
    name: 'Texas',
    ring: null,
    error: 'region-timeout',
  });
  assert.ok(
    Date.now() - started < 1000,
    'returns at the budget, not the lookup',
  );
  // The lookup is left running so it can fill the boundary cache.
  assert.equal(adminSignal?.aborted ?? false, false);
  release(null);
});

test('region ring: an unbounded budget waits for the lookup', async () => {
  const { resolveRegionRingForQuery } = createAnnotationResolver({
    featureSource: featureSource({
      getAdministrativeAreas: () =>
        new Promise((resolve) => setTimeout(() => resolve(null), 30)),
    }),
  });
  const region = await resolveRegionRingForQuery(
    'Texas',
    undefined,
    texasGeocode,
    { budgetMs: Infinity },
  );
  assert.equal(region, null);
});
