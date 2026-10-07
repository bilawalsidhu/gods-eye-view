// Bundled US Census places and Who's On First neighborhoods: lazy loading,
// name matching, disambiguation, and pack integrity.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { gunzipSync, gzipSync } from 'node:zlib';
import {
  CACHE_LIMITS,
  cachedPackFiles,
  decodePolyline,
  exactPlaceName,
  findNeighborhoodArea,
  findNeighborhoodAreaAt,
  findPlaceArea,
  findPlaceAreaAt,
  normalizePlaceName,
  packLoads,
  parsePlaceQuery,
} from './placeBoundaries.js';
import { decodeRing, polygonsContain } from './adminBoundaries.js';
import {
  partIsValid,
  placeAliases,
  simplifyPlace,
} from '../../scripts/build-census-places.mjs';

const PLACES = new URL('./local_data/us_census_places/', import.meta.url);
const WOF = new URL('./local_data/wof_neighborhoods/', import.meta.url);
const WOF_LICENSES = new URL(
  '../../scripts/wof-open-licenses.json',
  import.meta.url,
);
const readJson = (url) => JSON.parse(readFileSync(url, 'utf8'));

const AUSTIN = { lat: 30.2672, lon: -97.7431 };
const LONDON = { lat: 51.51, lon: -0.13 };
const PARIS = { lat: 48.857, lon: 2.352 };
const BROOKLYN = { lat: 40.71, lon: -73.96 };

// Runs first: nothing loads until a lookup needs it, and a lookup loads only
// the index plus the state files or tiles around its point.
test('packs load lazily: the index, then only the state or tiles asked about', async () => {
  assert.deepEqual(packLoads, {
    placeIndex: 0,
    placeStates: [],
    neighborhoodIndex: 0,
    neighborhoodTiles: [],
  });
  assert.equal(parsePlaceQuery('Austin, TX').name, 'austin');
  assert.equal(packLoads.placeIndex, 0, 'parsing is free');
  await findPlaceArea('Austin', { near: AUSTIN });
  assert.equal(packLoads.placeIndex, 1);
  assert.deepEqual(packLoads.placeStates, ['TX']);
  await findPlaceArea('Springfield, Illinois');
  await findPlaceArea('Round Rock', { near: AUSTIN });
  assert.deepEqual(packLoads.placeStates, ['TX', 'IL'], 'loaded once each');
  assert.equal(packLoads.neighborhoodIndex, 0, 'a place ask never loads hoods');
  // Alaska's box crosses the antimeridian without covering the world.
  assert.equal(await findPlaceArea('Notting Hill', { near: LONDON }), null);
  assert.deepEqual(packLoads.placeStates, ['TX', 'IL'], 'no state near London');
  const adak = await findPlaceArea('Adak', {
    near: { lat: 51.88, lon: -176.65 },
  });
  assert.equal(adak?.regionCode, 'AK');

  await findNeighborhoodArea('Notting Hill', { near: LONDON });
  assert.equal(packLoads.neighborhoodIndex, 1);
  const londonTiles = packLoads.neighborhoodTiles.length;
  assert.ok(londonTiles >= 1 && londonTiles <= 8, `${londonTiles} tiles`);
  const index = readJson(new URL('index.json', WOF));
  assert.ok(index.tiles.length > 100, 'the pack is split');
});

test('names fold case, accents and punctuation but keep every script', () => {
  assert.equal(normalizePlaceName('São Paulo'), 'sao paulo');
  assert.equal(normalizePlaceName('Saint Louis'), 'st louis');
  assert.equal(normalizePlaceName('St. Louis'), 'st louis');
  assert.equal(normalizePlaceName('The Mission'), 'mission');
  assert.equal(normalizePlaceName('Ноттинг-Хилл'), 'ноттинг хилл');
  assert.equal(normalizePlaceName('ル・マレ'), 'ル マレ');
  assert.equal(normalizePlaceName('平和里'), '平和里');
  // Kana voicing marks are letters, not accents: バ stays distinct from ハ.
  assert.notEqual(normalizePlaceName('バ'), normalizePlaceName('ハ'));
  // Marks outside Latin are part of the spelling.
  const devanagari = ['क', 'का', 'कु', 'की'].map(normalizePlaceName);
  assert.equal(new Set(devanagari).size, 4, 'Devanagari vowel signs kept');
  assert.notEqual(normalizePlaceName('Й'), normalizePlaceName('И'));
  assert.equal(normalizePlaceName('Бандра Й'), 'бандра й');
  // Latin accents fold; the exact spelling keeps them.
  assert.equal(normalizePlaceName('Zürich'), 'zurich');
  assert.equal(exactPlaceName('Zürich'), 'zürich');
});

test('a place type in the ask is kept: "City of Burbank" is not the CDP', async () => {
  assert.equal(parsePlaceQuery('City of Burbank, California').type, 'city');
  assert.equal(parsePlaceQuery('Burbank CDP').type, 'cdp');
  const nearSanJose = { lat: 37.33, lon: -121.93 };
  const city = await findPlaceArea('City of Burbank, California', {
    near: nearSanJose,
  });
  assert.equal(city?.id, '0608954');
  assert.equal(city.type, 'city');
  const cdp = await findPlaceArea('Burbank CDP, California', {
    near: nearSanJose,
  });
  assert.equal(cdp?.id, '0608968');
  // Two Burbanks in California, neither in view: the incorporated city is
  // the one a name means.
  const fromSacramento = await findPlaceArea('Burbank, California', {
    near: { lat: 38.58, lon: -121.49 },
  });
  assert.equal(fromSacramento?.id, '0608954');
  // Several CDPs of one name in a state, none in view: the geocoder decides.
  const cdps = await findPlaceArea('Bayview, California');
  assert.equal(cdps, null);
  // Over San Jose's Burbank the CDP is the one in view.
  const inView = await findPlaceArea('Burbank, California', {
    near: { lat: 37.3201, lon: -121.9308 },
  });
  assert.equal(inView?.id, '0608968');
});

test('the view radius bounds a bare name: Richmond city is not over SF', async () => {
  const richmondDistrict = { lat: 37.78, lon: -122.48 };
  assert.equal(
    await findPlaceArea('Richmond', { near: richmondDistrict, nearKm: 8 }),
    null,
  );
  const wide = await findPlaceArea('Richmond', { near: richmondDistrict });
  assert.equal(wide?.regionCode, 'CA', 'a wide view still reaches it');
});

test('pack caches keep the recently used files and reload evicted ones', async () => {
  const index = readJson(new URL('index.json', WOF));
  const limit = CACHE_LIMITS.tiles;
  const visited = [];
  for (const tile of index.tiles.slice(0, limit + 6)) {
    const [w, s, e, n] = tile.bbox;
    const centre = { lat: (s + n) / 2, lon: (w + e) / 2 };
    await findNeighborhoodArea('no such neighborhood', {
      near: centre,
      nearKm: 0.001,
    });
    visited.push(tile.key);
    assert.ok(cachedPackFiles().tiles.length <= limit, 'bounded');
  }
  const first = visited[0];
  assert.ok(!cachedPackFiles().tiles.includes(first), 'oldest evicted');
  const before = packLoads.neighborhoodTiles.filter((k) => k === first).length;
  const [w, s, e, n] = index.tiles[0].bbox;
  await findNeighborhoodArea('no such neighborhood', {
    near: { lat: (s + n) / 2, lon: (w + e) / 2 },
    nearKm: 0.001,
  });
  const after = packLoads.neighborhoodTiles.filter((k) => k === first).length;
  assert.equal(after, before + 1, 'reloaded after eviction');
  assert.ok(cachedPackFiles().tiles.includes(first));
});

test('a named place resolves by name and state, or near the view', async () => {
  for (const [query, options] of [
    ['Austin', { near: AUSTIN }],
    ['Austin, TX', {}],
    ['Austin, Texas', {}],
    ['Austin Texas', {}],
    ['Austin TX', {}],
    ['City of Austin', { near: AUSTIN }],
    ['Austin', { stateHint: 'TX' }],
    ['Austin, Texas, USA', {}],
  ]) {
    const place = await findPlaceArea(query, options);
    assert.equal(place?.id, '4805000', query);
    assert.equal(place.name, 'Austin');
    assert.equal(place.kind, 'place');
    assert.equal(place.source, 'us-census');
    assert.equal(place.regionCode, 'TX');
  }
  const austin = await findPlaceArea('Austin', { near: AUSTIN });
  assert.ok(austin.areaKm2 > 700 && austin.areaKm2 < 1000, `${austin.areaKm2}`);
  assert.ok(polygonsContain(austin.polygons, AUSTIN.lat, AUSTIN.lon));
  // A bare name with no view, a far view, or a place abroad is the geocoder's.
  // A place whose name ends in a state's is itself.
  const fort = await findPlaceArea('Fort Washington', {
    near: { lat: 38.73, lon: -77.0 },
  });
  assert.equal(fort?.regionCode, 'MD');
  assert.equal(fort.name, 'Fort Washington');
  const kc = await findPlaceArea('Kansas City Missouri');
  assert.equal(kc?.regionCode, 'MO');
  assert.equal(await findPlaceArea('Austin'), null);
  assert.equal(await findPlaceArea('Austin', { near: PARIS }), null);
  assert.equal(await findPlaceArea('Paris, France'), null);
  assert.equal(await findPlaceArea('Austin, Travis County'), null);
});

test('duplicate names ("Springfield") settle by state, then by the view', async () => {
  const byState = {
    'Springfield, Illinois': ['1772000', 'IL'],
    'Springfield, MA': ['2567000', 'MA'],
    'Springfield, Missouri': ['2970000', 'MO'],
  };
  for (const [query, [id, st]] of Object.entries(byState)) {
    const place = await findPlaceArea(query);
    assert.equal(place?.id, id, query);
    assert.equal(place.regionCode, st);
  }
  const nearMa = await findPlaceArea('Springfield', {
    near: { lat: 42.1, lon: -72.59 },
  });
  assert.equal(nearMa?.id, '2567000');
  const nearMo = await findPlaceArea('Springfield', {
    near: { lat: 37.2, lon: -93.29 },
  });
  assert.equal(nearMo?.id, '2970000');
  assert.equal(await findPlaceArea('Springfield'), null, 'bare: ambiguous');
  // Paris, Texas when the view is over it.
  const parisTx = await findPlaceArea('Paris', {
    near: { lat: 33.66, lon: -95.55 },
  });
  assert.equal(parisTx?.regionCode, 'TX');
});

test('consolidated governments answer to their everyday name', async () => {
  const nashville = await findPlaceArea('Nashville', {
    near: { lat: 36.16, lon: -86.78 },
  });
  assert.equal(nashville?.name, 'Nashville');
  assert.match(nashville.fullName, /metropolitan government/);
  assert.deepEqual(placeAliases('Urban Honolulu'), ['Honolulu']);
  assert.deepEqual(placeAliases('Austin'), []);
});

test('geocoder-confirmed places must hold the point', async () => {
  const at = await findPlaceAreaAt(
    ['Austin, Texas', 'Austin'],
    AUSTIN.lat,
    AUSTIN.lon,
  );
  assert.equal(at?.id, '4805000');
  assert.equal(await findPlaceAreaAt(['Austin'], 32.78, -96.8), null, 'Dallas');
  assert.equal(await findPlaceAreaAt(['Paris'], PARIS.lat, PARIS.lon), null);
});

test('triangles survive: Quesada CDP is a three-vertex ring', async () => {
  const quesada = await findPlaceArea('Quesada, Texas');
  assert.equal(quesada?.id, '4860098');
  assert.equal(quesada.ring.length, 3);
  const triangle = [
    [
      [0, 0],
      [0.01, 0],
      [0, 0.01],
      [0, 0],
    ],
  ];
  const kept = simplifyPlace([triangle]);
  assert.equal(kept.polygons[0][0].length, 3);
  assert.equal(kept.valid, true);
});

test('crossing rings are repaired, touching rings are allowed', () => {
  const bowtie = [
    [0, 0],
    [10, 10],
    [10, 0],
    [0, 10],
  ];
  assert.equal(partIsValid([bowtie]), false);
  const square = [
    [0, 0],
    [10, 0],
    [10, 10],
    [0, 10],
  ];
  assert.equal(partIsValid([square]), true);
  // A hole touching its outer ring at one vertex is valid.
  const hole = [
    [0, 0],
    [4, 6],
    [6, 4],
  ];
  assert.equal(partIsValid([square, hole]), true);
  const crossingHole = [
    [5, 5],
    [15, 6],
    [6, 7],
  ];
  assert.equal(partIsValid([square, crossingHole]), false);
  // At 0.001° the outer ring loses the 0.0008° bulge that holds the tip of
  // a hole, so the hole would poke through it (the Austin failure).
  const outer = [
    [0, 0],
    [0.1, 0],
    [0.1, 0.1],
    [0.07, 0.1],
    [0.05, 0.1008],
    [0.03, 0.1],
    [0, 0.1],
    [0, 0],
  ];
  const tip = [
    [0.045, 0.099],
    [0.05, 0.1005],
    [0.055, 0.099],
    [0.045, 0.099],
  ];
  const params = {
    toleranceFactor: 1,
    minToleranceDeg: 0.001,
    maxToleranceDeg: 0.001,
    decimals: 4,
    minPartKm2: 0,
    minPartShare: 0,
    minHoleKm2: 0,
    minRingVertices: 3,
    maxRepairSteps: 8,
  };
  const repaired = simplifyPlace([[outer, tip]], params);
  assert.equal(repaired.repaired, true, 'the first simplification crossed');
  assert.equal(repaired.valid, true);
  assert.equal(repaired.decimals, 4);
});

/** Integer rings of a place pack feature. */
function placeParts(feature, decimals) {
  const d = feature.d ?? decimals;
  return feature.polygons.map((poly) =>
    poly.map((ring) =>
      decodeRing(ring, d).map(([x, y]) => [
        Math.round(x * 10 ** d),
        Math.round(y * 10 ** d),
      ]),
    ),
  );
}

test('places pack: every state file, unique ids, sane and valid rings', () => {
  const index = readJson(new URL('index.json', PLACES));
  const files = readdirSync(PLACES).filter((f) => /^[A-Z]{2}\.json$/.test(f));
  assert.deepEqual(
    files.sort(),
    index.states.map((s) => `${s.st}.json`).sort(),
  );
  const listed = readFileSync(new URL('files.js', PLACES), 'utf8');
  for (const s of index.states) assert.ok(listed.includes(`'./${s.st}.json'`));
  const ids = new Set();
  let total = 0;
  for (const state of index.states) {
    const bytes = readFileSync(new URL(`${state.st}.json`, PLACES));
    assert.ok(gunzipSync(gzipSync(bytes)).equals(bytes), 'gzip roundtrip');
    const pack = JSON.parse(bytes);
    assert.equal(pack.features.length, state.count);
    for (const feature of pack.features) {
      assert.ok(!ids.has(feature.geoid), `duplicate ${feature.geoid}`);
      ids.add(feature.geoid);
      const parts = placeParts(feature, index.meta.decimals);
      assert.ok(parts.length >= 1);
      for (const part of parts) {
        assert.ok(partIsValid(part), `${feature.geoid} ${feature.name}`);
        for (const ring of part)
          for (const [x, y] of ring) {
            const f = 10 ** (feature.d ?? index.meta.decimals);
            assert.ok(Math.abs(x / f) <= 180 && Math.abs(y / f) <= 90);
          }
      }
    }
    total += pack.features.length;
  }
  assert.equal(total, 32_629);
});

const WOF_LICENSE_POLICY = readJson(WOF_LICENSES);
const ALLOWED_WOF_LICENSES = new Set(WOF_LICENSE_POLICY.licenses);
const licenceAllowed = (value) =>
  typeof value === 'string' && ALLOWED_WOF_LICENSES.has(value);

test('the WOF licence policy accepts only exact reviewed registry strings', () => {
  for (const accepted of WOF_LICENSE_POLICY.licenses)
    assert.equal(licenceAllowed(accepted), true, accepted);
  for (const rejected of [
    '',
    null,
    0,
    'Unknown',
    'Restricted',
    'CC BY-NC 4.0',
    'CC BY-SA 4.0',
    'CC BY 5.0 (unreviewed)',
    'CC BY Restricted',
    'CC BY Unknown',
    'Creative Commons NonCommercial',
    'ODbL 1.0',
    'cc by 4.0',
    'CC BY 4.0 ',
    ' CC BY 4.0',
    'CC  BY 4.0',
    'CC\tBY 4.0',
  ])
    assert.equal(licenceAllowed(rejected), false, JSON.stringify(rejected));
});

test('the Zetashapes raw registry spelling is admitted by pinned provenance', () => {
  const review = WOF_LICENSE_POLICY.reviewedSources.zs;
  assert.deepEqual(
    {
      name: review.name,
      registryCommit: review.registryCommit,
      registrySha256: review.registrySha256,
      rawLicenseType: review.rawLicenseType,
      licenseTextSha256: review.licenseTextSha256,
    },
    {
      name: 'Zetashapes',
      registryCommit: 'e17af153c144fe6e08aa8db2607b4bf8aecd448d',
      registrySha256:
        'd8a5dd873d26eee11583de4438185c046dec33848d5bde27047ca4bff44d9c39',
      rawLicenseType: 'Public domain',
      licenseTextSha256:
        '91757f96f74f6dfb4a7206486b78586da0d039e9611e224fc793c7167dcfe615',
    },
  );
  assert.equal(licenceAllowed(review.rawLicenseType), true);
  assert.match(review.decision, /TIGER\/Line/);
  assert.match(review.decision, /Flickr/);
});

test('neighborhood pack ships only explicitly allowed and credited sources', () => {
  const index = readJson(new URL('index.json', WOF));
  const sources = index.meta.sources;
  const credits = readFileSync(new URL('ATTRIBUTION.md', WOF), 'utf8');
  for (const [key, source] of Object.entries(sources)) {
    assert.equal(
      licenceAllowed(source.license),
      true,
      `${key}: ${source.license}`,
    );
    assert.notEqual(key, 'unknown');
    assert.ok(credits.includes(`\`${key}\``), `${key} credited`);
  }
  for (const excluded of [
    'amsgis',
    'tmpgov',
    'ssuberlin',
    'minitenders',
    'stpaulgov',
    'mapzen',
  ])
    assert.equal(sources[excluded], undefined, excluded);
  const listed = readFileSync(new URL('files.js', WOF), 'utf8');
  const ids = new Set();
  const used = {};
  for (const tile of index.tiles) {
    assert.ok(listed.includes(`'./${tile.key}.json'`), tile.key);
    const bytes = readFileSync(new URL(`${tile.key}.json`, WOF));
    assert.ok(gunzipSync(gzipSync(bytes)).equals(bytes), 'gzip roundtrip');
    const { features } = JSON.parse(bytes);
    assert.equal(features.length, tile.count);
    for (const [id, name, , type, bbox, , source, rings] of features) {
      assert.ok(!ids.has(id), `duplicate ${id}`);
      ids.add(id);
      assert.ok(name);
      assert.ok(['neighbourhood', 'macrohood', 'microhood'].includes(type));
      assert.ok(sources[source], `${id} source ${source} is listed`);
      used[source] = (used[source] || 0) + 1;
      assert.ok(bbox[0] >= tile.bbox[0] && bbox[3] <= tile.bbox[3]);
      for (const poly of rings)
        for (const encoded of poly) {
          const ring = decodePolyline(encoded, index.meta.precision);
          assert.ok(new Set(ring.map(String)).size >= 3, `${id} ring`);
          for (const [lon, lat] of ring)
            assert.ok(Math.abs(lon) <= 180 && Math.abs(lat) <= 90, `${id}`);
        }
    }
  }
  for (const [key, source] of Object.entries(sources))
    assert.equal(used[key], source.records, key);
  assert.equal(ids.size, 61_755);
});

test('neighborhoods resolve near the view, in any script', async () => {
  const cases = [
    ['Notting Hill', LONDON, '85789533'],
    ['Ноттинг-Хилл', LONDON, '85789533'],
    ['Le Marais', PARIS, '1158894289'],
    ['the Marais', PARIS, '1158894289'],
    ['ル・マレ', PARIS, '1158894289'],
    ['Williamsburg', BROOKLYN, '85857853'],
    ['平和里', { lat: 24.142, lon: 120.672 }, '85924987'],
  ];
  for (const [query, near, id] of cases) {
    const hood = await findNeighborhoodArea(query, { near });
    assert.equal(hood?.id, id, query);
    assert.equal(hood.kind, 'neighborhood');
    assert.equal(hood.source, 'wof');
    assert.ok(hood.ring.length >= 3);
  }
  // Williamsburg, Virginia is not Brooklyn's; a qualifier defers to a geocoder.
  assert.equal(
    await findNeighborhoodArea('Williamsburg, Virginia', { near: BROOKLYN }),
    null,
  );
  assert.equal(
    await findNeighborhoodArea('Notting Hill', { near: PARIS }),
    null,
  );
  assert.equal(await findNeighborhoodArea('Notting Hill'), null, 'no view');
  const at = await findNeighborhoodAreaAt(['Notting Hill'], 51.509, -0.196);
  assert.equal(at?.id, '85789533');
  assert.equal(await findNeighborhoodAreaAt(['Notting Hill'], 0, 0), null);
});

test('polyline decoding matches the encoder', () => {
  // [[-120.2, 38.5], [-120.95, 40.7]] in lon,lat order at precision 5.
  const ring = decodePolyline('~ps|U_p~iFnnqC_ulL');
  assert.deepEqual(ring, [
    [-120.2, 38.5],
    [-120.95, 40.7],
  ]);
});
