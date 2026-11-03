// Bundled state/province and US county boundaries: name matching,
// disambiguation, multipolygons and holes, and lazy loading.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import {
  decodeRing,
  findAdminArea,
  findAdminAreaAt,
  normalizeAdminName,
  packLoads,
  parseAdminQuery,
  polygonsContain,
} from './adminBoundaries.js';

const ADMIN1 = new URL(
  './local_data/natural_earth/states_provinces.json',
  import.meta.url,
);
const COUNTIES = new URL(
  './local_data/us_census_counties/counties.json',
  import.meta.url,
);

const AUSTIN = { lat: 30.2672, lon: -97.7431 };
const PORTLAND = { lat: 45.5152, lon: -122.6784 };

// Runs first: nothing loads until a lookup needs it, and a state ask never
// pulls the county pack.
test('packs load lazily, once, and only the pack an ask needs', async () => {
  assert.deepEqual(packLoads, { admin1: 0, counties: 0, countries: 0 });
  assert.equal(parseAdminQuery('Texas').kind, 'any');
  assert.deepEqual(
    packLoads,
    { admin1: 0, counties: 0, countries: 0 },
    'parsing is free',
  );
  await findAdminArea('Texas');
  await findAdminArea('Bavaria');
  assert.deepEqual(packLoads, { admin1: 1, counties: 0, countries: 0 });
  await findAdminArea('Travis County');
  await findAdminArea('Orleans Parish');
  assert.deepEqual(packLoads, { admin1: 1, counties: 1, countries: 0 });
});

test('Texas, TX and "State of Texas" name the same unit', async () => {
  for (const query of [
    'Texas',
    'texas',
    'TX',
    'State of Texas',
    'the State of Texas',
    'Texas, USA',
    'Texas, United States',
  ]) {
    const unit = await findAdminArea(query, { near: AUSTIN });
    assert.equal(unit?.id, 'US-TX', query);
    assert.equal(unit.name, 'Texas');
    assert.equal(unit.kind, 'state');
    assert.equal(unit.source, 'natural-earth');
  }
  const texas = await findAdminArea('Texas');
  assert.ok(
    texas.areaKm2 > 600_000 && texas.areaKm2 < 750_000,
    `Texas area ${texas.areaKm2}`,
  );
  assert.ok(polygonsContain(texas.polygons, AUSTIN.lat, AUSTIN.lon));
});

test('provinces and states abroad resolve by English and local names', async () => {
  for (const query of [
    'Bavaria',
    'Bayern',
    'Bavaria, Germany',
    'Free State of Bavaria',
  ]) {
    const unit = await findAdminArea(query);
    assert.equal(unit?.id, 'DE-BY', query);
    assert.equal(unit.name, 'Bavaria');
    assert.equal(unit.country, 'Germany');
  }
  assert.equal((await findAdminArea('Ontario'))?.id, 'CA-ON');
  assert.equal((await findAdminArea('ON'))?.id, 'CA-ON');
  assert.equal((await findAdminArea('Province of Ontario'))?.id, 'CA-ON');
  assert.equal((await findAdminArea('Free State'))?.country, 'South Africa');
  // Same name in two countries: the qualifier decides.
  assert.equal((await findAdminArea('Punjab, India'))?.id, 'IN-PB');
  assert.equal((await findAdminArea('Punjab, Pakistan'))?.id, 'PK-PB');
  // A qualifier may name the unit itself.
  assert.equal((await findAdminArea('Washington, DC'))?.id, 'US-DC');
});

test('"Washington" is the state; "Washington County" is a county near the camera', async () => {
  const state = await findAdminArea('Washington', { near: AUSTIN });
  assert.equal(state?.id, 'US-WA');
  const fromAustin = await findAdminArea('Washington County', { near: AUSTIN });
  assert.equal(fromAustin.kind, 'county');
  assert.equal(fromAustin.name, 'Washington County');
  assert.equal(fromAustin.region, 'Texas');
  assert.ok(fromAustin.candidates > 20, 'dozens of Washington Counties');
  const fromPortland = await findAdminArea('Washington County', {
    near: PORTLAND,
  });
  assert.equal(fromPortland.region, 'Oregon');
  const arkansas = await findAdminArea('Washington County, Arkansas', {
    near: PORTLAND,
  });
  assert.equal(arkansas.region, 'Arkansas');
  assert.equal(arkansas.candidates, 1);
  assert.equal(
    (await findAdminArea('Washington County, AR'))?.region,
    'Arkansas',
  );
});

test('Travis County with and without its state', async () => {
  for (const query of [
    'Travis County',
    'Travis County, Texas',
    'Travis County, TX',
    'Travis County Texas',
    'travis county, texas, usa',
  ]) {
    const unit = await findAdminArea(query, { near: PORTLAND });
    assert.equal(unit?.id, '48453', query);
    assert.equal(unit.name, 'Travis County');
    assert.equal(unit.region, 'Texas');
    assert.equal(unit.source, 'us-census');
  }
  assert.equal(await findAdminArea('Travis County, Ohio'), null);
  assert.equal(await findAdminArea('Travis County Courthouse'), null);
  // Every qualifier must place the county, not name something in it.
  assert.equal(await findAdminArea('Travis County Courthouse, Texas'), null);
  assert.equal(
    await findAdminArea('Orange County Great Park, California'),
    null,
  );
});

test('county equivalents: parishes, boroughs, independent cities, and non-US counties', async () => {
  const orleans = await findAdminArea('Orleans Parish', { near: AUSTIN });
  assert.equal(orleans?.id, '22071');
  assert.equal(orleans.region, 'Louisiana');
  assert.equal((await findAdminArea('Orleans Parish, LA'))?.id, '22071');
  // The wrong county word still finds the only unit with that name.
  assert.equal(
    (await findAdminArea('Anchorage Borough'))?.name,
    'Anchorage Municipality',
  );
  // Outside the US a county is an admin-1 unit.
  assert.equal((await findAdminArea('County Cork'))?.country, 'Ireland');
  assert.equal(
    (await findAdminArea('Kent County, England'))?.country,
    'United Kingdom',
  );
  assert.equal(
    (await findAdminArea('Kent County', { near: AUSTIN }))?.region,
    'Texas',
  );
});

test('a bare name that is also a country or a large city is left to a geocoder', async () => {
  for (const query of ['New York', 'Georgia', 'Madrid']) {
    assert.equal(await findAdminArea(query), null, query);
  }
  // Admin wording settles it.
  assert.equal((await findAdminArea('New York State'))?.id, 'US-NY');
  assert.equal((await findAdminArea('State of New York'))?.id, 'US-NY');
  assert.equal((await findAdminArea('State of Mexico'))?.country, 'Mexico');
  // City-states are the city itself.
  assert.equal((await findAdminArea('Berlin'))?.id, 'DE-BE');
  assert.equal((await findAdminArea('Vienna'))?.country, 'Austria');
  // A country qualifier places a name; it does not make a city a state.
  assert.equal(await findAdminArea('New York, USA'), null);
  assert.equal(await findAdminArea('Madrid, Spain'), null);
  // A namesake city abroad: ambiguous alone, settled by naming the country.
  const santaFe = { lat: 35.687, lon: -105.938 };
  assert.equal(await findAdminArea('Santa Fe', { near: santaFe }), null);
  assert.equal(await findAdminArea('Victoria'), null);
  assert.equal((await findAdminArea('Victoria, Australia'))?.id, 'AU-VIC');
});

test('bare names: only prominent units, no generic words, codes as codes', async () => {
  // Places a geocoder knows better than a small admin unit of that name.
  for (const query of [
    'Long Island',
    'Santa Barbara',
    'Kent',
    'Hamilton',
    'Milan',
  ])
    assert.equal(await findAdminArea(query, { near: AUSTIN }), null, query);
  for (const query of ['North', 'Central', 'Capital', 'Lakes'])
    assert.equal(await findAdminArea(query), null, query);
  // Two-letter codes must be written as codes, and not the city ones.
  assert.equal(await findAdminArea('tx'), null);
  assert.equal(
    await findAdminArea('LA', { near: { lat: 34.05, lon: -118.24 } }),
    null,
  );
  assert.equal(await findAdminArea('NY'), null);
  assert.equal((await findAdminArea('OK'))?.id, 'US-OK');
});

test('non-admin asks never match', async () => {
  for (const query of [
    'Texas Capitol',
    'the Texas State Capitol',
    'Zilker Park',
    'Ohio State',
    'Texas State',
    'Alps',
    '',
    null,
  ]) {
    assert.equal(await findAdminArea(query), null, String(query));
  }
});

test('geocoder-confirmed lookup: the named unit that contains the point', async () => {
  // Atlanta — the geocoder said "state", so the US state wins over the country.
  const georgia = await findAdminAreaAt(['Georgia'], 33.749, -84.388, 'state');
  assert.equal(georgia?.id, 'US-GA');
  // Tbilisi — Georgia the country has no admin-1 unit of that name.
  assert.equal(await findAdminAreaAt(['Georgia'], 41.7, 44.8, 'state'), null);
  const newYork = await findAdminAreaAt(['New York'], 42.9, -75.5, 'state');
  assert.equal(newYork?.id, 'US-NY');
  assert.equal(
    (
      await findAdminAreaAt(
        ['Ontario Province', 'Ontario'],
        43.6532,
        -79.3832,
        'state',
      )
    )?.id,
    'CA-ON',
  );
  // Natural Earth still carries the historical NP-BA Bagmati Zone. An ask
  // for today's province must not silently select that incompatible geometry.
  assert.equal(
    await findAdminAreaAt(
      ['Bagmati Province', 'Bagmati'],
      27.7172,
      85.324,
      'state',
    ),
    null,
  );
  // A county the geocoder typed, named without the county word.
  const travis = await findAdminAreaAt(
    ['Travis', 'Travis County'],
    30.33,
    -97.78,
    'county',
  );
  assert.equal(travis?.id, '48453');
  // A county the geocoder typed stays a county even where a state shares
  // its name: Manhattan, the Big Island, Arkansas County.
  assert.equal(
    (await findAdminAreaAt(['New York County'], 40.783, -73.966, 'county'))?.id,
    '36061',
  );
  assert.equal(
    (await findAdminAreaAt(['Hawaii County'], 19.6, -155.5, 'county'))?.name,
    'Hawaii County',
  );
  // A geocoded point outside the named unit is not that unit.
  assert.equal(await findAdminAreaAt(['Texas'], 35.0, -106.6, 'state'), null);
  // Outside the US a geocoder "county" is an admin-1 unit (Kent).
  assert.equal(
    (await findAdminAreaAt(['Kent'], 51.2, 0.7, 'county'))?.country,
    'United Kingdom',
  );
});

test('multipolygons: every island is a part, and containment follows the parts', async () => {
  const hawaii = await findAdminArea('Hawaii');
  assert.ok(
    hawaii.polygons.length >= 7,
    `Hawaii parts ${hawaii.polygons.length}`,
  );
  assert.ok(polygonsContain(hawaii.polygons, 19.6, -155.5), 'Big Island');
  assert.ok(polygonsContain(hawaii.polygons, 20.8, -156.3), 'Maui');
  assert.ok(polygonsContain(hawaii.polygons, 21.45, -158.0), 'Oahu');
  assert.ok(
    !polygonsContain(hawaii.polygons, 21.0, -157.3),
    'the channel between',
  );
  // The main ring is the largest part (the Big Island).
  assert.equal(hawaii.ring, hawaii.polygons[0][0]);

  // Alaska is cut at the antimeridian: its box stays on one side of the globe.
  const alaska = await findAdminArea('Alaska');
  const [west, , east] = alaska.bbox;
  assert.ok(east - west < 60, `Alaska box width ${east - west}°`);
  assert.ok(alaska.polygons.length > 10, 'Aleutians and the southeast islands');
});

test('holes: Berlin is cut out of Brandenburg', async () => {
  const brandenburg = await findAdminArea('Brandenburg');
  assert.ok(
    brandenburg.polygons.some((part) => part.length > 1),
    'Brandenburg has a hole',
  );
  assert.ok(!polygonsContain(brandenburg.polygons, 52.52, 13.405), 'Berlin');
  assert.ok(polygonsContain(brandenburg.polygons, 52.39, 13.06), 'Potsdam');
  const berlin = await findAdminArea('Berlin');
  assert.ok(polygonsContain(berlin.polygons, 52.52, 13.405));
});

test('holes: an independent city is cut out of its county', async () => {
  const fairfax = await findAdminArea('Fairfax County, Virginia');
  assert.ok(fairfax.polygons[0].length > 1, 'Fairfax County has holes');
  assert.ok(
    !polygonsContain(fairfax.polygons, 38.846, -77.306),
    'Fairfax city',
  );
  assert.ok(polygonsContain(fairfax.polygons, 38.9, -77.2), 'Fairfax County');
  const city = await findAdminArea('Fairfax city, Virginia');
  assert.ok(polygonsContain(city.polygons, 38.846, -77.306));
  assert.equal((await findAdminArea('Carson City'))?.region, 'Nevada');
  for (const query of ['New York City', 'Mexico City', 'Quebec City, Canada'])
    assert.equal(await findAdminArea(query), null, query);
});

test('rings decode from deltas and are open', () => {
  assert.deepEqual(decodeRing([-97743, 30267, 10, -5, -3, 8], 3), [
    [-97.743, 30.267],
    [-97.733, 30.262],
    [-97.736, 30.27],
  ]);
});

test('names normalize across accents, punctuation and "Saint"', () => {
  assert.equal(normalizeAdminName('Québec'), 'quebec');
  assert.equal(normalizeAdminName('  The State of TEXAS '), 'state of texas');
  assert.equal(normalizeAdminName('Saint Louis County'), 'st louis county');
  assert.equal(normalizeAdminName('St. Louis County'), 'st louis county');
  assert.equal(normalizeAdminName('Schleswig-Holstein'), 'schleswig holstein');
});

test('packs: public-domain provenance, schema, and size budgets', () => {
  const admin1 = JSON.parse(readFileSync(ADMIN1, 'utf8'));
  const counties = JSON.parse(readFileSync(COUNTIES, 'utf8'));
  for (const pack of [admin1, counties]) {
    assert.match(pack.meta.license, /public domain/i);
    assert.match(pack.meta.sha256, /^[0-9a-f]{64}$/);
    assert.equal(pack.meta.script, 'scripts/build-admin-packs.mjs');
    for (const feature of pack.features) {
      assert.ok(feature.name, 'named');
      assert.ok(feature.polygons.length >= 1, `${feature.name} has a part`);
      for (const poly of feature.polygons)
        for (const ring of poly) {
          assert.equal(ring.length % 2, 0);
          assert.ok(ring.length >= 8, `${feature.name}: ring has 4+ vertices`);
        }
    }
  }
  assert.ok(
    admin1.features.length > 4500,
    `${admin1.features.length} states/provinces`,
  );
  assert.ok(
    counties.features.length > 3200,
    `${counties.features.length} counties`,
  );
  assert.ok(statSync(ADMIN1).size <= 4 * 1024 * 1024, 'admin-1 pack ≤ 4 MB');
  assert.ok(statSync(COUNTIES).size <= 2 * 1024 * 1024, 'county pack ≤ 2 MB');
});

test('county queries compare US and international names before choosing a geography', async () => {
  const england = { lat: 54.78, lon: -1.58 };
  const nc = { lat: 36.0, lon: -78.9 };
  assert.equal(
    (await findAdminArea('County Durham', { near: england }))?.country,
    'United Kingdom',
  );
  assert.equal(
    (await findAdminArea('County Durham'))?.country,
    'United Kingdom',
    'exact alias survives parsing',
  );
  assert.equal(
    (await findAdminArea('Durham County', { near: nc }))?.region,
    'North Carolina',
  );
  assert.equal(
    (await findAdminArea('County Durham, England', { near: nc }))?.country,
    'United Kingdom',
  );
  assert.equal(
    (await findAdminArea('County Durham, USA', { near: england }))?.region,
    'North Carolina',
  );
  assert.equal(
    (await findAdminArea('Durham County, NC', { near: england }))?.region,
    'North Carolina',
  );
  // Durham is also a city: without county wording leave city geocoding intact.
  assert.equal(await findAdminArea('Durham, NC', { near: england }), null);
  assert.equal(
    (await findAdminAreaAt(['Durham, NC'], nc.lat, nc.lon, 'county'))?.region,
    'North Carolina',
  );
});

test('countries resolve aliases, keep substantial islands and disambiguate Georgia by scope and geography', async () => {
  for (const names of [
    ['USA', 'United States', 'America'],
    ['UK', 'United Kingdom', 'Britain'],
    ['Iran', 'Islamic Republic of Iran'],
    ['Czechia', 'Czech Republic'],
    ['Ivory Coast', "Côte d'Ivoire"],
    ['South Korea', 'Korea'],
    ['Russia', 'Russian Federation'],
    ['Switzerland'],
    ['France'],
  ]) {
    const resolved = await Promise.all(
      names.map((name) => findAdminArea(name, { near: AUSTIN })),
    );
    assert.ok(
      resolved.every((r) => r?.kind === 'country'),
      names.join('/'),
    );
    assert.equal(new Set(resolved.map((r) => r.id)).size, 1);
  }
  assert.equal(
    (await findAdminArea('Georgia', { near: AUSTIN })).kind,
    'state',
  );
  assert.equal(
    (await findAdminArea('Georgia', { near: { lat: 41.7, lon: 44.8 } })).kind,
    'country',
  );
  assert.equal(
    (await findAdminArea('the country of Georgia', { near: AUSTIN })).kind,
    'country',
  );
  assert.equal(await findAdminArea('New York', { near: AUSTIN }), null);
  assert.equal(
    (await findAdminAreaAt(['Iran'], 35.69, 51.39, 'country')).kind,
    'country',
  );
  assert.equal(
    await findAdminAreaAt(['Iran'], 46.9, 7.4, 'country'),
    null,
    'name alone cannot override a mismatched geocoded point',
  );
  const japan = await findAdminArea('Japan');
  for (const [lat, lon] of [
    [35.68, 139.69],
    [43.06, 141.35],
    [33.59, 130.4],
    [33.56, 133.53],
  ])
    assert.ok(polygonsContain(japan.polygons, lat, lon));
  const usa = await findAdminArea('USA');
  for (const [lat, lon] of [
    [30.27, -97.74],
    [61.22, -149.9],
    [19.7, -155.1],
  ])
    assert.ok(
      polygonsContain(usa.polygons, lat, lon),
      'USA includes mainland, Alaska and Hawaii',
    );
  const bytes = statSync(
    new URL('./local_data/natural_earth/countries.json', import.meta.url),
  ).size;
  assert.ok(bytes < 1_000_000);
});

test('UK constituent countries retain their own identity and extent from any camera', async () => {
  const targets = [
    ['Scotland', 'SCT', [55.95, -3.19], [54.6, 61]],
    ['England', 'ENG', [51.5, -0.12], [49.8, 55.9]],
    ['Wales', 'WLS', [51.48, -3.18], [51.3, 53.6]],
    ['Northern Ireland', 'NIR', [54.6, -5.93], [53.9, 55.4]],
  ];
  for (const [name, id, point, extent] of targets) {
    const unit = await findAdminArea(name, { near: AUSTIN });
    assert.equal(unit.id, id);
    assert.equal(unit.name, name);
    assert.equal(unit.kind, 'country');
    assert.ok(
      unit.bbox[1] >= extent[0] && unit.bbox[3] <= extent[1],
      `${name}: ${unit.bbox}`,
    );
    assert.ok(polygonsContain(unit.polygons, ...point));
    for (const [other, , otherPoint] of targets)
      if (other !== name)
        assert.equal(polygonsContain(unit.polygons, ...otherPoint), false);
    assert.equal((await findAdminAreaAt([name], ...point, 'country')).id, id);
    assert.equal(await findAdminAreaAt([name], 30.27, -97.74, 'country'), null);
  }
  assert.equal((await findAdminArea('UK', { near: AUSTIN })).id, 'GBR');
  assert.equal(
    (await findAdminArea('County Durham, England', { near: AUSTIN })).country,
    'United Kingdom',
  );
});
