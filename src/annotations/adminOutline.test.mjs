// Area annotations draw bundled state/province/county outlines with no
// network lookup, and multi-part outlines reach the renderer intact.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FEATURE_SOURCE_METHODS } from '../sources/featureSource.js';
import { createAnnotationResolver } from './resolver.js';
import { createAnnotationEngine } from './annotationEngine.js';
import { _resetRenderGovernorForTest } from '../renderGovernor.js';

function viewerAt(lat, lon, height = 20_000) {
  return {
    camera: {
      positionCartographic: {
        latitude: (lat * Math.PI) / 180,
        longitude: (lon * Math.PI) / 180,
        height,
      },
    },
  };
}

/** A resolver whose boundary lookups and geocoder record every call. */
function harness(place = null) {
  const lookups = [];
  const featureSource = {};
  for (const method of FEATURE_SOURCE_METHODS)
    featureSource[method] = async () => {
      lookups.push(method);
      return null;
    };
  const geocodes = [];
  const placeSearch = {
    async geocode(query) {
      geocodes.push(query);
      return { place };
    },
    async textSearch() {
      geocodes.push('text-search');
      return [];
    },
  };
  const { resolveAnnotationTarget } = createAnnotationResolver({
    featureSource,
  });
  const resolve = (target, viewer, extra = {}) =>
    resolveAnnotationTarget({
      placeSearch,
      viewer,
      target,
      footprint: true,
      deferFootprint: true,
      ...extra,
    });
  return { resolve, lookups, geocodes };
}

const AUSTIN = viewerAt(30.2672, -97.7431, 3000);

test('"Texas", "Travis County, Texas" and "Bavaria" outline offline', async () => {
  const { resolve, lookups, geocodes } = harness();
  for (const [target, label] of [
    ['Texas', 'Texas'],
    ['Travis County, Texas', 'Travis County'],
    // Far from the camera, but named outright: no proximity gate applies.
    ['Bavaria', 'Bavaria'],
  ]) {
    const resolved = await resolve(target, AUSTIN);
    assert.ok(resolved, target);
    assert.equal(resolved.source, 'bundled', target);
    assert.equal(resolved.label, label);
    assert.equal(resolved.footprintKind, 'area');
    assert.equal(resolved.synthesized, false);
    assert.equal(resolved.resolveOutline, undefined, 'drawn at once');
    assert.ok(resolved.ring.length >= 9, `${target} ring`);
    assert.deepEqual(resolved.ring[0], resolved.ring.at(-1), 'ring closed');
    assert.ok(resolved.polygons.length >= 1, `${target} parts`);
    assert.equal(resolved.polygons[0][0].length + 1, resolved.ring.length);
    assert.ok(resolved.viewport?.low && resolved.viewport?.high);
  }
  assert.deepEqual(geocodes, [], 'no geocoding');
  assert.deepEqual(lookups, [], 'no boundary lookups');
});

test('duplicate county names go to the one near the camera', async () => {
  const { resolve } = harness();
  const nearPortland = await resolve(
    'Washington County',
    viewerAt(45.52, -122.68),
  );
  assert.ok(nearPortland.lat > 45 && nearPortland.lon < -122, 'Oregon');
  const nearAustin = await resolve('Washington County', AUSTIN);
  assert.ok(nearAustin.lat > 29.9 && nearAustin.lat < 30.5, 'Texas');
  assert.ok(nearAustin.lon > -96.8 && nearAustin.lon < -96, 'Texas');
});

test('multi-part outlines carry every part and hole', async () => {
  const { resolve } = harness();
  const hawaii = await resolve('Hawaii', AUSTIN);
  assert.ok(hawaii.polygons.length >= 7, 'islands');
  const brandenburg = await resolve('Brandenburg', AUSTIN);
  assert.ok(
    brandenburg.polygons.some((part) => part.length === 2),
    'Berlin hole',
  );
});

test('Georgia resolves from camera geography without a geocoder', async () => {
  const { resolve, lookups, geocodes } = harness();
  for (const [query, viewer, latitude] of [
    ['Georgia', viewerAt(33.75, -84.39, 400_000), 32],
    ['the country of Georgia', AUSTIN, 42],
    ['Georgia', viewerAt(41.7, 44.8), 42],
  ]) {
    const resolved = await resolve(query, viewer);
    assert.equal(resolved.source, 'bundled');
    assert.ok(Math.abs(resolved.lat - latitude) < 2);
    assert.ok(resolved.ring.length > 20);
  }
  assert.deepEqual(lookups, []);
  assert.deepEqual(geocodes, []);
});

test('a natural region under the camera wins over a wrong remote geocode', async () => {
  const { resolve, lookups, geocodes } = harness({
    lat: -27.96,
    lng: 152.2,
    label: 'The Alps, Queensland, Australia',
    name: 'The Alps',
    types: ['locality', 'political'],
  });
  const resolved = await resolve('the Alps', viewerAt(46.5, 10, 248_000));
  assert.ok(resolved);
  assert.equal(resolved.source, 'bundled');
  assert.equal(resolved.label, 'Alps');
  assert.equal(resolved.naturalRegion, 'Alps');
  assert.equal(resolved.footprintKind, 'area');
  assert.ok(resolved.ring.length >= 8, 'real Alps ring');
  assert.equal(resolved.resolveOutline, undefined, 'drawn at once');
  assert.deepEqual(geocodes, [], 'wrong remote match was never consulted');
  assert.deepEqual(lookups, [], 'no boundary lookup');
});

test('country asks and geocoded country scopes use the bundled outline', async () => {
  const direct = harness();
  for (const name of ['Switzerland', 'Iran', 'France', 'Japan']) {
    const resolved = await direct.resolve(name, AUSTIN);
    assert.equal(resolved.source, 'bundled');
    assert.ok(resolved.polygons.length);
    if (name === 'Japan') assert.ok(resolved.polygons.length > 3);
  }
  assert.deepEqual(direct.lookups, []);
  assert.deepEqual(direct.geocodes, []);
  const geocoded = harness({
    lat: 46.95,
    lng: 7.45,
    label: 'Switzerland',
    name: 'Switzerland',
    types: ['country', 'political'],
  });
  const resolved = await geocoded.resolve(
    'Swiss country outline',
    viewerAt(46.95, 7.45),
  );
  assert.equal(resolved.source, 'geocode');
  const outline = await resolved.resolveOutline();
  assert.ok(outline.polygons.length);
  assert.deepEqual(geocoded.lookups, []);
});

test('non-admin asks and entity facts keep the existing path', async () => {
  const { resolve, geocodes } = harness();
  await resolve('Texas Capitol', AUSTIN);
  await resolve('Texas', AUSTIN, { entityKind: 'building' });
  await resolve('Zilker Park', AUSTIN);
  assert.equal(
    geocodes.filter((q) => q !== 'text-search').length,
    3,
    'each ask geocoded',
  );
  // Points and explicit coordinates never use the pack.
  const point = await resolve('Texas', AUSTIN, { footprint: false });
  assert.notEqual(point?.source, 'bundled');
});

test('the engine keeps every part on the mark, drawn at once or upgraded', async (t) => {
  globalThis.requestAnimationFrame ??= () => 1;
  globalThis.cancelAnimationFrame ??= () => {};
  _resetRenderGovernorForTest();
  t.after(() => _resetRenderGovernorForTest());
  const polygons = [
    [
      [
        [0, 0],
        [2, 0],
        [2, 2],
        [0, 2],
      ],
      [
        [0.5, 0.5],
        [0.5, 1],
        [1, 1],
        [1, 0.5],
      ],
    ],
    [
      [
        [3, 3],
        [4, 3],
        [4, 4],
      ],
    ],
  ];
  const ring = [...polygons[0][0], polygons[0][0][0]];
  const seen = [];
  const renderer = {
    add: (anno) => seen.push(['add', anno.polygons]),
    update: (anno) => seen.push(['update', anno.polygons]),
    remove() {},
    sync() {},
    destroy() {},
  };
  const engine = createAnnotationEngine({
    viewer: {},
    renderer,
    resolveTarget: async ({ target }) =>
      target === 'now'
        ? { lon: 1, lat: 1, height: 0, ring, polygons, footprintKind: 'area' }
        : {
            lon: 1,
            lat: 1,
            height: 0,
            ring: null,
            resolveOutline: async () => ({
              ring,
              polygons,
              footprintKind: 'area',
              lat: 1,
              lon: 1,
              height: 0,
            }),
          },
  });
  await engine.annotate([{ type: 'area', target: 'now' }]);
  await engine.annotate([{ type: 'area', target: 'later', label: 'later' }]);
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
  const marks = engine.list();
  assert.equal(marks[0].polygons, polygons);
  assert.ok(
    marks.some((m) => m.label === 'later' && m.polygons === polygons),
    'upgrade carries the parts',
  );
  assert.ok(
    seen.some(([kind, parts]) => kind === 'update' && parts === polygons),
  );
  engine.destroy();
});
