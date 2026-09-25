import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createOverpassFeatureSource,
  FEATURE_SOURCE_METHODS,
} from './overpassFeatures.js';
import { normalizeOverpassFeatures } from './overpassFeaturesRecords.js';
import { createAnnotationResolver } from '../annotations/resolver.js';

const geometry = [
  { lat: 30, lon: -97 },
  { lat: 30, lon: -96.999 },
  { lat: 30.001, lon: -96.999 },
  { lat: 30.001, lon: -97 },
  { lat: 30, lon: -97 },
];
const raw = {
  type: 'way',
  id: 42,
  tags: { name: 'Fixture Tower', building: 'yes', height: '100 ft' },
  geometry,
};
const candidate = {
  id: 42,
  category: 'feature',
  names: { primary: 'Fixture Tower' },
  building: true,
  heightM: 30.48,
  coordinates: geometry,
};
const featureSource = (overrides) =>
  Object.assign(
    Object.fromEntries(
      FEATURE_SOURCE_METHODS.map((method) => [method, async () => []]),
    ),
    overrides,
  );

test('Overpass adapter owns all feature query expressions and normalizes returned records', async () => {
  const calls = [];
  const source = createOverpassFeatureSource({
    boundarySource: {
      query: async (query, options) => {
        calls.push({ query, options });
        return [raw, { ...raw, type: 'relation' }];
      },
    },
  });
  for (const method of FEATURE_SOURCE_METHODS) {
    const records = await source[method](
      method === 'getAreaGeometry' ? 3600000042 : { lat: 30, lon: -97 },
    );
    assert.equal(records[0].names.primary, 'Fixture Tower');
    assert.equal(records[0].heightM, 30.48);
    assert.deepEqual(records[0].coordinates, geometry);
    assert.equal('tags' in records[0], false);
    assert.equal(records.length, method === 'getAreaGeometry' ? 1 : 2);
  }
  assert.equal(calls.length, 9);
  assert.ok(
    calls.every(
      ({ query, options }) =>
        query.includes('[out:json]') && options.signal instanceof AbortSignal,
    ),
  );
  assert.match(calls[1].query, /rel\(pivot.x\)/);
  assert.match(calls[4].query, /\["highway"\]/);
  assert.match(calls[7].query, /memorial\|monument/);
  assert.match(calls[8].query, /around:180,/);
  assert.throws(
    () => source.getFootprints({ lat: '30);out;', lon: -97 }),
    /coordinates/,
  );
  assert.throws(() => source.getAreaGeometry('1);out;'), /reference/);
  assert.equal(calls.length, 9);
});

test('provider preserves empty, transient and throttled responses and rejects late canceled data', async () => {
  const lifetime = new AbortController();
  let value = [];
  const source = createOverpassFeatureSource({
    signal: lifetime.signal,
    boundarySource: { query: async () => value },
  });
  assert.deepEqual(await source.getFootprints({ lat: 30, lon: -97 }), []);
  value = null;
  assert.equal(await source.getFootprints({ lat: 30, lon: -97 }), null);
  value = { rateLimited: true, retryAfterMs: 1500 };
  assert.deepEqual(await source.getFootprints({ lat: 30, lon: -97 }), value);
  let respond, signal;
  const pendingSource = createOverpassFeatureSource({
    signal: lifetime.signal,
    boundarySource: {
      query: async (_q, options) => {
        signal = options.signal;
        return new Promise((resolve) => {
          respond = resolve;
        });
      },
    },
  });
  const pending = pendingSource.getFootprints({ lat: 30, lon: -97 });
  lifetime.abort();
  respond([raw]);
  assert.equal(signal.aborted, true);
  assert.equal(await pending, null);
});

test('relation normalization keeps the largest closed outer and rejects a missing boundary', () => {
  const relation = {
    type: 'relation',
    id: 1,
    tags: { name: 'Region' },
    members: [
      { role: 'outer', geometry: geometry.slice(0, 3) },
      { role: 'outer', geometry: geometry.slice(2) },
      {
        role: 'inner',
        geometry: geometry.map((p) => ({ lat: p.lat + 1, lon: p.lon + 1 })),
      },
    ],
  };
  assert.deepEqual(
    normalizeOverpassFeatures([relation])[0].coordinates,
    geometry,
  );
  relation.members = [{ role: 'outer', geometry: geometry.slice(0, 3) }];
  assert.deepEqual(normalizeOverpassFeatures([relation])[0].coordinates, []);
  assert.deepEqual(
    normalizeOverpassFeatures([{ ...raw, geometry: undefined, members: {} }], {
      focus: true,
    })[0].coordinates,
    [],
  );
});

test('annotation selection accepts another feature provider with no query transport', async () => {
  let calls = 0;
  const resolver = createAnnotationResolver({
    featureSource: featureSource({
      getFootprints: async () => {
        calls++;
        return [candidate];
      },
    }),
  });
  const args = {
    latitude: 30.0005,
    longitude: -96.9995,
    target: 'Fixture Tower',
    entityKind: 'building',
    footprint: true,
  };
  const first = await resolver.resolveAnnotationTarget(args);
  const second = await resolver.resolveAnnotationTarget(args);
  assert.equal(first.footprintKind, 'building');
  assert.equal(first.buildingHeight, 30.48);
  assert.deepEqual(
    first.ring,
    geometry.map((p) => [p.lon, p.lat]),
  );
  assert.deepEqual(second.ring, first.ring);
  assert.equal(
    calls,
    1,
    'ranking cache is independent of the provider implementation',
  );
});

test('annotation retries transient feature failures but caches definitive misses', async () => {
  let calls = 0;
  const resolver = createAnnotationResolver({
    featureSource: featureSource({
      getFootprints: async () => {
        calls++;
        return calls === 1 ? null : [];
      },
    }),
  });
  const anchor = await resolver.resolveAnnotationTarget({
    latitude: 30.0005,
    longitude: -96.9995,
    target: 'Missing Tower',
    entityKind: 'building',
    footprint: true,
    deferFootprint: true,
  });
  assert.equal(await anchor.resolveOutline(), undefined);
  assert.equal(await anchor.resolveOutline(), null);
  assert.equal(await anchor.resolveOutline(), null);
  assert.equal(calls, 2);
});

// A multipolygon relation as Overpass prints it with `out geom`: the outer
// boundary split across two ways, an inner ring, and a label node.
const relationRing = [
  { lat: 30, lon: -97 },
  { lat: 30, lon: -96.994 },
  { lat: 30.005, lon: -96.994 },
  { lat: 30.005, lon: -97 },
  { lat: 30, lon: -97 },
];
const relationFixture = (name, tags) => ({
  type: 'relation',
  id: 7,
  bounds: { minlat: 30, minlon: -97, maxlat: 30.005, maxlon: -96.994 },
  members: [
    { type: 'way', ref: 71, role: 'outer', geometry: relationRing.slice(0, 3) },
    { type: 'way', ref: 72, role: 'outer', geometry: relationRing.slice(2) },
    {
      type: 'way',
      ref: 73,
      role: 'inner',
      geometry: relationRing.map((p) => ({ lat: p.lat + 0.001, lon: p.lon })),
    },
    { type: 'node', ref: 74, role: 'label', lat: 30.0025, lon: -96.997 },
  ],
  tags: { name, ...tags },
});

// Overpass leaves members out at `tags` verbosity, so `geom` has nothing to
// attach to and a relation keeps only its bounds.
const overpassPrinting = (element) => ({
  query: async (text) =>
    /\bout\s+tags\b/.test(text)
      ? [
          {
            type: element.type,
            id: element.id,
            bounds: element.bounds,
            tags: element.tags,
          },
        ]
      : [element],
});

test('neighborhood and street-area lookups keep relation member geometry', async () => {
  const calls = [];
  const source = createOverpassFeatureSource({
    boundarySource: {
      query: async (text) => {
        calls.push(text);
        return overpassPrinting(
          relationFixture('Fixture Quarter', { place: 'quarter' }),
        ).query(text);
      },
    },
  });
  for (const method of ['getNeighborhoodAreas', 'getStreetAreas']) {
    const [record] = await source[method]({ lat: 30.002, lon: -96.997 });
    assert.deepEqual(record.coordinates, relationRing, method);
  }
  for (const text of calls) {
    assert.match(text, /\);out geom;$/);
    assert.doesNotMatch(text, /\bout\s+tags\b/);
  }
});

test('annotations outline a neighborhood or street area mapped as a relation', async () => {
  const ring = relationRing.map((p) => [p.lon, p.lat]);
  const areas = (tags, name) => {
    const source = createOverpassFeatureSource({
      boundarySource: overpassPrinting(relationFixture(name, tags)),
    });
    return (point, options) =>
      source[tags.place ? 'getNeighborhoodAreas' : 'getStreetAreas'](
        point,
        options,
      );
  };
  const neighborhood = await createAnnotationResolver({
    featureSource: featureSource({
      getNeighborhoodAreas: areas(
        { place: 'neighbourhood' },
        'Fixture Heights',
      ),
    }),
  }).resolveAnnotationTarget({
    latitude: 30.002,
    longitude: -96.997,
    target: 'Fixture Heights',
    entityKind: 'district',
    footprint: true,
  });
  assert.equal(neighborhood.footprintKind, 'area');
  assert.deepEqual(neighborhood.ring, ring);

  const street = await createAnnotationResolver({
    featureSource: featureSource({
      getStreetAreas: areas(
        { landuse: 'retail', type: 'multipolygon' },
        'Fixture Street Market',
      ),
    }),
  }).resolveAnnotationTarget({
    latitude: 30.002,
    longitude: -96.997,
    target: 'Fixture Street',
    entityKind: 'street',
    footprint: true,
  });
  assert.equal(street.footprintKind, 'area');
  assert.deepEqual(street.ring, ring);
});

test('focus footprints keep relation members and centers', async () => {
  let query;
  const element = relationFixture('Fixture Building', { building: 'yes' });
  const source = createOverpassFeatureSource({
    boundarySource: {
      query: async (text) => {
        query = text;
        return overpassPrinting(element).query(text);
      },
    },
  });
  const [record] = await source.getFocusFootprints({
    lat: 30.002,
    lon: -96.997,
  });
  assert.deepEqual(
    record.coordinates,
    element.members.flatMap((member) => member.geometry || []),
  );
  assert.match(query, /out center geom;/);
  assert.doesNotMatch(query, /out tags/);
});
