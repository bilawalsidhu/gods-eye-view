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

// A state-typed place outside every bundled boundary, so the admin-boundary
// feature lookup (not the bundled packs) answers.
const offPackGeocode = {
  async geocode() {
    return {
      place: {
        lat: 0.5,
        lng: -150.5,
        label: 'Atlantis',
        name: 'Atlantis',
        types: ['administrative_area_level_1', 'political'],
      },
    };
  },
};

function geocoderFor(place) {
  const calls = [];
  return {
    calls,
    async geocode(query) {
      calls.push(query);
      return { place };
    },
  };
}

test('region ring: Natural Earth names resolve without a geocoder', async () => {
  const { resolveRegionRingForQuery } = createAnnotationResolver({
    featureSource: featureSource(),
  });
  for (const name of ['Gulf of Mexico', 'the Alps']) {
    const region = await resolveRegionRingForQuery(name);
    assert.ok(region?.ring?.length >= 3, `${name} resolves to a ring`);
    assert.equal(region.source, 'natural-earth');
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
    'Atlantis',
    undefined,
    offPackGeocode,
    { budgetMs: 50 },
  );
  assert.deepEqual(region, {
    name: 'Atlantis',
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
    'Atlantis',
    undefined,
    offPackGeocode,
    { budgetMs: Infinity },
  );
  assert.equal(region, null);
});

test('region ring: bundled states and counties resolve without a geocoder', async () => {
  const lookups = [];
  const { resolveRegionRingForQuery } = createAnnotationResolver({
    featureSource: featureSource({
      getAdministrativeAreas: async () => {
        lookups.push('admin');
        return null;
      },
    }),
  });
  const geocoder = geocoderFor(null);
  for (const [query, name] of [
    ['Texas', 'Texas'],
    ['Bavaria', 'Bavaria'],
    ['Travis County, Texas', 'Travis County'],
  ]) {
    const region = await resolveRegionRingForQuery(query, undefined, geocoder);
    assert.equal(region?.name, name, query);
    assert.equal(region?.source, 'bundled-admin', query);
    assert.ok(region.ring.length >= 8, `${query} has a real ring`);
  }
  assert.deepEqual(geocoder.calls, [], 'no geocoding');
  assert.deepEqual(lookups, [], 'no boundary lookups');
});

test('region ring: a geocoder-typed state resolves from the bundled pack', async () => {
  const lookups = [];
  const { resolveRegionRingForQuery } = createAnnotationResolver({
    featureSource: featureSource({
      getAdministrativeAreas: async () => {
        lookups.push('admin');
        return null;
      },
    }),
  });
  // "Georgia" alone is also a country, so the words don't settle it; the
  // geocoder's state type and point inside the US state do.
  const geocoder = geocoderFor({
    lat: 32.16,
    lng: -82.9,
    label: 'Georgia, USA',
    name: 'Georgia',
    types: ['administrative_area_level_1', 'political'],
  });
  const region = await resolveRegionRingForQuery(
    'Georgia',
    undefined,
    geocoder,
  );
  assert.equal(region?.name, 'Georgia');
  assert.ok(region.ring.length >= 8);
  assert.deepEqual(geocoder.calls, ['Georgia']);
  assert.deepEqual(lookups, [], 'no boundary lookups');
});
