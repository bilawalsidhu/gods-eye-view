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

test('region ring: duplicate natural names need a containing geocoded anchor', async () => {
  const { resolveRegionRingForQuery } = createAnnotationResolver({
    featureSource: featureSource(),
  });
  const miss = geocoderFor(null);
  assert.equal(
    await resolveRegionRingForQuery('Cordillera Oriental', undefined, miss),
    null,
  );
  assert.deepEqual(miss.calls, ['Cordillera Oriental']);

  const inside = geocoderFor({
    lat: 5,
    lng: -73,
    label: 'Cordillera Oriental',
    name: 'Cordillera Oriental',
    types: ['natural_feature'],
  });
  const region = await resolveRegionRingForQuery(
    'Cordillera Oriental',
    undefined,
    inside,
  );
  assert.equal(region?.source, 'natural-earth');
  assert.equal(region.name, 'Cordillera Oriental');
  assert.ok(region.ring.length >= 8);
  assert.deepEqual(inside.calls, ['Cordillera Oriental']);
});

test('region ring: outside and overlapping geocoded natural anchors stay unresolved', async () => {
  const { resolveRegionRingForQuery } = createAnnotationResolver({
    featureSource: featureSource(),
  });
  for (const [name, lat, lng] of [
    ['Cordillera Oriental', 30.27, -97.74],
    ['Canadian Shield', 45.6336, -74.86493],
  ]) {
    const geocoder = geocoderFor({
      lat,
      lng,
      label: name,
      name,
      types: ['natural_feature'],
    });
    assert.equal(
      await resolveRegionRingForQuery(name, undefined, geocoder),
      null,
    );
    assert.deepEqual(geocoder.calls, [name]);
  }
});

test('region ring: geocoded administrative scope wins over duplicate natural geography', async () => {
  const lookups = [];
  const { resolveRegionRingForQuery } = createAnnotationResolver({
    featureSource: featureSource({
      getAdministrativeAreas: async (point) => {
        lookups.push(point);
        return [];
      },
    }),
  });
  const geo = geocoderFor({
    lat: 5,
    lng: -73,
    label: 'Cordillera Oriental',
    name: 'Cordillera Oriental',
    types: ['locality'],
  });
  const resolved = await resolveRegionRingForQuery(
    'Cordillera Oriental',
    undefined,
    geo,
  );
  assert.equal(
    resolved,
    null,
    'an unavailable city boundary is not a natural-region outline',
  );
  assert.deepEqual(lookups, [{ lat: 5, lon: -73 }]);
  assert.deepEqual(geo.calls, ['Cordillera Oriental']);
});

test('region ring: cancellation during bundled lookup and geocode never returns a region', async () => {
  const { resolveRegionRingForQuery } = createAnnotationResolver({
    featureSource: featureSource(),
  });
  const controller = new AbortController();
  const pending = resolveRegionRingForQuery('the Alps', controller.signal);
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });

  const later = new AbortController();
  await assert.rejects(
    resolveRegionRingForQuery('Cordillera Oriental', later.signal, {
      async geocode() {
        later.abort();
        return { place: null };
      },
    }),
    { name: 'AbortError' },
  );
});

test('region ring: a slow admin-boundary lookup returns region-timeout within the budget', async () => {
  let adminSignal;
  let release;
  let lookupStarted;
  const { resolveRegionRingForQuery } = createAnnotationResolver({
    featureSource: featureSource({
      getAdministrativeAreas(_point, { signal }) {
        lookupStarted = Date.now();
        adminSignal = signal;
        return new Promise((resolve) => {
          release = resolve;
        });
      },
    }),
  });
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
  // Timed from the boundary lookup, so the bundled pack scans before it do not
  // count. Under the 3 s default budget, so an ignored budgetMs still fails.
  assert.ok(
    Date.now() - lookupStarted < 2_000,
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
    assert.equal(region.source, 'bundled-admin');
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
