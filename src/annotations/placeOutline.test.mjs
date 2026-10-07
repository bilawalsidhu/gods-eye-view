// Area annotations draw bundled US Census place and neighborhood outlines
// (San Francisco DataSF first, then Who's On First) with no network lookup.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { FEATURE_SOURCE_METHODS } from '../sources/featureSource.js';
import { createAnnotationResolver } from './resolver.js';

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
function harness(place = null, { outlineRungs } = {}) {
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
    ...(outlineRungs ? { outlineRungs } : {}),
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
const SAN_FRANCISCO = viewerAt(37.76, -122.42, 3000);
const LONDON = viewerAt(51.51, -0.16, 3000);

function assertBundledArea(resolved, label) {
  assert.equal(resolved?.source, 'bundled', label);
  assert.equal(resolved.label, label);
  assert.equal(resolved.footprintKind, 'area');
  assert.equal(resolved.synthesized, false);
  assert.equal(resolved.resolveOutline, undefined, 'drawn at once');
  assert.deepEqual(resolved.ring[0], resolved.ring.at(-1), 'ring closed');
  assert.ok(resolved.polygons.length >= 1);
}

test('a city name that is only a neighborhood alias goes to the geocoder', async () => {
  const { resolve, geocodes } = harness();
  // Sé lists "São Paulo" among its names; the ask means the city.
  const saoPaulo = viewerAt(-23.55, -46.633, 60_000);
  const city = await resolve('São Paulo', saoPaulo);
  assert.notEqual(city?.label, 'Se');
  assert.ok(geocodes.includes('São Paulo'));
  // A district ask still takes the alias.
  const district = await resolve('São Paulo', saoPaulo, {
    entityKind: 'district',
  });
  assert.equal(district?.label, 'Se');
});

test('"Austin" over Austin draws the Census place with no lookup', async () => {
  const { resolve, lookups, geocodes } = harness();
  for (const target of ['Austin', 'Austin, Texas', 'City of Austin']) {
    const resolved = await resolve(target, AUSTIN);
    assertBundledArea(resolved, 'Austin');
    assert.ok(resolved.polygons.length >= 4, 'every part of the city');
  }
  // A qualified name needs no view.
  const springfield = await resolve('Springfield, Illinois', AUSTIN);
  assertBundledArea(springfield, 'Springfield');
  assert.ok(Math.abs(springfield.lat - 39.78) < 0.2);
  assert.deepEqual(geocodes, []);
  assert.deepEqual(lookups, []);
});

test("the SF DataSF pack answers before Who's On First in San Francisco", async () => {
  const { resolve, lookups, geocodes } = harness();
  const sf = JSON.parse(
    readFileSync(
      new URL(
        '../data/local_data/neighborhoods/san-francisco.json',
        import.meta.url,
      ),
    ),
  );
  const mission = sf.features.find((f) => f.properties.name === 'Mission');
  const missionRing = mission.geometry.coordinates[0];
  for (const target of ['the Mission District', 'Mission', 'the Mission']) {
    const resolved = await resolve(target, SAN_FRANCISCO, {
      entityKind: 'district',
    });
    assertBundledArea(resolved, 'Mission');
    assert.deepEqual(resolved.polygons[0][0], missionRing, target);
  }
  // A name only WOF has in San Francisco falls through to it.
  const dogpatch = await resolve('Dogpatch', SAN_FRANCISCO);
  assertBundledArea(dogpatch, 'Dogpatch');
  // A park asked for as a compound is not a neighborhood of its name.
  await resolve('Mission Dolores Park', SAN_FRANCISCO, {
    entityKind: 'compound',
  });
  assert.equal(geocodes.filter((q) => q !== 'text-search').length, 1);
  assert.deepEqual(lookups, []);
});

test("Who's On First neighborhoods resolve near the view", async () => {
  const { resolve, geocodes } = harness();
  assertBundledArea(await resolve('Notting Hill', LONDON), 'Notting Hill');
  assertBundledArea(
    await resolve('Le Marais', viewerAt(48.857, 2.352, 3000)),
    'Le Marais',
  );
  assertBundledArea(
    await resolve('Williamsburg', viewerAt(40.71, -73.96, 3000)),
    'Williamsburg',
  );
  assert.deepEqual(geocodes, []);
});

test('campuses, qualified hoods and far names still go to the geocoder', async () => {
  const { resolve, geocodes } = harness();
  // Stanford is a CDP, but a campus ask wants the campus.
  const stanford = await resolve('Stanford', viewerAt(37.43, -122.17, 3000), {
    entityKind: 'compound',
  });
  assert.notEqual(stanford?.source, 'bundled');
  await resolve('the Capitol grounds', AUSTIN);
  await resolve('Notting Hill', AUSTIN);
  assert.equal(geocodes.filter((q) => q !== 'text-search').length, 3);
  // A state settles a place name wherever the camera is: not Brooklyn's
  // Williamsburg, the Virginia city.
  const virginia = await resolve(
    'Williamsburg, Virginia',
    viewerAt(40.71, -73.96, 3000),
  );
  assertBundledArea(virginia, 'Williamsburg');
  assert.ok(Math.abs(virginia.lat - 37.27) < 0.1, 'Virginia');
});

test('a geocoded city or neighborhood upgrades to the bundled outline', async () => {
  const city = harness({
    lat: 30.2672,
    lng: -97.7431,
    label: 'Austin, TX, USA',
    name: 'Austin',
    types: ['locality', 'political'],
  });
  // Seen from far away: the view does not settle the name, the geocoder does.
  const resolved = await city.resolve('Austin', viewerAt(39, -100, 5_000_000));
  assert.equal(resolved.source, 'geocode');
  const outline = await resolved.resolveOutline();
  assert.equal(outline.adminArea, 'Austin');
  assert.ok(outline.polygons.length >= 4);
  assert.deepEqual(city.lookups, [], 'no boundary lookup');

  const hood = harness({
    lat: 51.5118,
    lng: -0.2046,
    label: 'Notting Hill, London, UK',
    name: 'Notting Hill',
    types: ['neighborhood', 'political'],
  });
  const nottingHill = await hood.resolve(
    'Notting Hill',
    viewerAt(48, 10, 5_000_000),
  );
  const hoodOutline = await nottingHill.resolveOutline();
  assert.equal(hoodOutline.adminArea, 'Notting Hill');
  assert.deepEqual(hood.lookups, []);
});

test('a district ask prefers a neighborhood; a place must hold the view', async () => {
  const { resolve, geocodes } = harness();
  // "Richmond" over SF's Richmond District: never Richmond, California.
  const richmond = await resolve('Richmond', viewerAt(37.78, -122.48, 3000), {
    entityKind: 'district',
  });
  assertBundledArea(richmond, 'Richmond District');
  assert.ok(Math.abs(richmond.lat - 37.78) < 0.05, 'not the East Bay city');
  // Omitted kind at a street-level view: the district in view, too.
  const bare = await resolve('Richmond', viewerAt(37.78, -122.48, 3000));
  assertBundledArea(bare, 'Richmond District');
  // Over the East Bay city, the city.
  const wide = await resolve('Richmond', viewerAt(37.94, -122.35, 40_000));
  assert.equal(wide?.source, 'bundled');
  assert.ok(wide.lat > 37.88, 'Richmond, California');
  assert.deepEqual(geocodes, []);
});

test('landmark-named neighborhoods wait for the landmark ladder', async () => {
  const manhattan = viewerAt(40.78, -73.965, 3000);
  const cases = [
    ['Central Park', {}],
    ['Central Park', { entityKind: 'compound' }],
    ['Central Park', { intent: 'around_the_thing' }],
    ['Hyde Park', {}],
    ['Notting Hill', { intent: 'around_the_thing' }],
  ];
  for (const [target, extra] of cases) {
    const { resolve, geocodes } = harness();
    const viewer = target === 'Central Park' ? manhattan : LONDON;
    const resolved = await resolve(target, viewer, extra);
    assert.notEqual(
      resolved?.source,
      'bundled',
      `${target} ${JSON.stringify(extra)}`,
    );
    assert.ok(geocodes.length >= 1, `${target} is geocoded`);
  }
  // Named as a district, the WOF neighborhood answers.
  const { resolve } = harness();
  const park = await resolve('Central Park', manhattan, {
    entityKind: 'district',
  });
  assert.equal(park?.source, 'bundled');
  // "Park Slope" ends in no landmark word: still a neighborhood.
  const slope = await resolve('Park Slope', viewerAt(40.671, -73.98, 3000));
  assertBundledArea(slope, 'Park Slope');
});

/** Outline rungs whose Nominatim answers `answer` (null: nothing found). */
function rungsAnswering(answer) {
  const asked = [];
  return {
    asked,
    resolve: async (ctx, { base, finish }) => {
      asked.push({ scope: ctx.scope, target: ctx.target });
      const baseResult = await base();
      if (baseResult?.ring && !baseResult.synthesized) return baseResult;
      return answer ? finish(answer, ctx.scope) : baseResult;
    },
  };
}

const PARIS_PLACE = {
  lat: 48.8566,
  lng: 2.3522,
  label: 'Paris, France',
  name: 'Paris',
  types: ['locality', 'political'],
};
const square = (lat, lon, d) => [
  [lon - d, lat - d],
  [lon + d, lat - d],
  [lon + d, lat + d],
  [lon - d, lat + d],
  [lon - d, lat - d],
];

test('a coarse bundled admin-1 city waits for a finer outline', async () => {
  const overParis = viewerAt(48.8566, 2.3522, 40_000);
  const ring = square(48.8566, 2.3522, 0.05);
  const rungs = rungsAnswering({ ring, kind: 'area', heightM: null });
  const fine = harness(PARIS_PLACE, { outlineRungs: rungs });
  const resolved = await fine.resolve('Paris', overParis);
  assert.equal(
    resolved.source,
    'geocode',
    'the 11-vertex admin-1 is not drawn at once',
  );
  const outline = await resolved.resolveOutline();
  assert.deepEqual(outline.ring, ring, 'the finer outline wins');
  assert.deepEqual(rungs.asked, [{ scope: 'city', target: 'Paris' }]);

  // Nothing finer (Nominatim off, busy or capped): the bundled shape, not a point.
  const coarse = harness(PARIS_PLACE, { outlineRungs: rungsAnswering(null) });
  const fallback = await (
    await coarse.resolve('Paris', overParis)
  ).resolveOutline();
  assert.equal(fallback.adminArea, 'Paris');
  assert.ok(fallback.ring.length < 32);

  // No geocoder answer at all: the bundled shape at once.
  const offline = harness(null, { outlineRungs: rungsAnswering(null) });
  const direct = await offline.resolve('Paris', overParis);
  assert.equal(direct.source, 'bundled');
  assert.equal(direct.label, 'Paris');
});

test('detailed admin-1 units and admin asks keep the bundled shape', async () => {
  const { resolve } = harness(null, { outlineRungs: rungsAnswering(null) });
  for (const [name, lat, lon] of [
    ['Berlin', 52.52, 13.4],
    ['Bavaria', 48.9, 11.4],
    ['Texas', 31, -99],
  ]) {
    const resolved = await resolve(name, viewerAt(lat, lon, 400_000));
    assert.equal(resolved?.source, 'bundled', name);
  }
  // Countries are never coarse cities, however few vertices.
  const singapore = await resolve('Singapore', viewerAt(1.35, 103.82, 60_000));
  assert.equal(singapore?.source, 'bundled');
  // An explicit admin ask takes the admin unit as it is.
  const dc = await resolve('Paris', viewerAt(48.8566, 2.3522, 40_000), {
    entityKind: 'state',
  });
  assert.equal(dc?.source, 'bundled');
});

test('a campus ask reaches the campus, not the Census place of its town', async () => {
  const stanfordTown = {
    lat: 37.4241,
    lng: -122.1661,
    label: 'Stanford, CA, USA',
    name: 'Stanford',
    types: ['locality', 'political'],
  };
  const campus = square(37.4275, -122.1697, 0.01);
  for (const ask of ['Stanford University', 'Stanford campus']) {
    const rungs = rungsAnswering({ ring: campus, kind: 'area', heightM: null });
    const { resolve } = harness(stanfordTown, { outlineRungs: rungs });
    const resolved = await resolve(ask, viewerAt(37.43, -122.17, 8000));
    assert.notEqual(resolved?.source, 'bundled', ask);
    const outline = await resolved.resolveOutline();
    assert.deepEqual(outline.ring, campus, ask);
    assert.equal(
      rungs.asked[0].scope,
      'compound',
      `${ask}: past the Census rung`,
    );
  }
  // "Stanford" said to be a compound is the campus too.
  const kindRungs = rungsAnswering({
    ring: campus,
    kind: 'area',
    heightM: null,
  });
  const byKind = harness(stanfordTown, { outlineRungs: kindRungs });
  const compound = await (
    await byKind.resolve('Stanford', viewerAt(37.43, -122.17, 8000), {
      entityKind: 'compound',
    })
  ).resolveOutline();
  assert.deepEqual(compound.ring, campus);
  assert.equal(kindRungs.asked[0].scope, 'compound');
  // "Stanford" alone is the town (the Stanford CDP), and a town named after a
  // college stays a town.
  const { resolve } = harness(stanfordTown, {
    outlineRungs: rungsAnswering(null),
  });
  const town = await (
    await resolve('Stanford', viewerAt(39, -100, 5_000_000))
  ).resolveOutline();
  assert.equal(town.adminArea, 'Stanford');
  const station = harness(
    {
      lat: 30.628,
      lng: -96.3344,
      label: 'College Station, TX, USA',
      name: 'College Station',
      types: ['locality', 'political'],
    },
    { outlineRungs: rungsAnswering(null) },
  );
  const collegeStation = await (
    await station.resolve('College Station', viewerAt(39, -100, 5_000_000))
  ).resolveOutline();
  assert.equal(collegeStation.adminArea, 'College Station');
});

test('a grounds ask never takes the state the geocoder typed', async () => {
  const texas = {
    lat: 31.0,
    lng: -99.0,
    label: 'Texas, USA',
    name: 'Texas',
    types: ['administrative_area_level_1', 'political'],
  };
  for (const [ask, extra] of [
    ['the Texas Capitol grounds', {}],
    ['Texas Capitol', { entityKind: 'compound' }],
    // The grounds wording is only in the label.
    ['Texas Capitol', { labelHint: 'Capitol grounds' }],
  ]) {
    const rungs = rungsAnswering(null);
    const { resolve } = harness(texas, { outlineRungs: rungs });
    const resolved = await resolve(ask, viewerAt(31, -99, 3_000_000), extra);
    assert.notEqual(resolved?.source, 'bundled', ask);
    const outline = await resolved.resolveOutline();
    assert.notEqual(outline?.adminArea, 'Texas', ask);
    assert.equal(rungs.asked[0].scope, 'compound', ask);
  }
});
