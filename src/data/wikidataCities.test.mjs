// src/data/wikidataCities.test.mjs — lookups over fixture and shipped places packs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  citiesWithin,
  foldName,
  indexCities,
  lonHalfSpan,
} from './wikidataCities.js';

const ROWS = [
  ['São Paulo', -23.55, -46.633, 11451999, 'BR', 'Q174'],
  ['Austin', 30.267, -97.743, 961855, 'US', 'Q16559'],
  ['Round Rock', 30.508, -97.679, 119468, 'US', 'Q128269'],
  ['Zürich', 47.374, 8.541, 421878, 'CH', 'Q72'],
];

test('names compare without case or accents', () => {
  assert.equal(foldName('São Paulo'), 'sao paulo');
  assert.equal(foldName('  ZÜRICH '), 'zurich');
  assert.equal(foldName(null), '');
});

test('a lookup reads the cells around a point and measures each place', () => {
  const cells = indexCities(ROWS);
  const near = citiesWithin(cells, 30.27, -97.74, 40).sort(
    (a, b) => a.distanceKm - b.distanceKm,
  );
  assert.deepEqual(
    near.map((city) => city.name),
    ['Austin', 'Round Rock'],
  );
  assert.ok(near[0].distanceKm < 1);
  assert.equal(near[1].country, 'US');
  assert.deepEqual(citiesWithin(cells, 0, 0, 50), []);
});

test('findPlace finds a city by its name without accents', async () => {
  // A fresh module, so its pack cache starts empty.
  const { findPlace } = await import(`./wikidataCities.js?case=${Date.now()}`);
  const fetchImpl = async (url) => ({
    ok: true,
    json: async () =>
      String(url).includes('cities.json') ? { meta: {}, rows: ROWS } : null,
  });
  const found = await findPlace('sao paulo, Brazil', {}, fetchImpl);
  assert.equal(found?.wikidata, 'Q174');
  assert.equal(await findPlace('Atlantis', {}, fetchImpl), null);
});

test('names fold letters that carry no separate accent', () => {
  assert.equal(foldName('Łódź'), 'lodz');
  assert.equal(foldName('Tromsø'), 'tromso');
  assert.equal(foldName('Đà Nẵng'), 'da nang');
  assert.equal(foldName('Diyarbakır'), 'diyarbakir');
  assert.equal(foldName('Straße'), 'strasse');
});

const PARIS = [
  ['Paris', 48.857, 2.352, 2145906, 'FR', 'Q90'],
  ['Paris', 33.661, -95.556, 24476, 'US', 'Q830149'],
];

async function freshPack(rows) {
  const module = await import(
    `./wikidataCities.js?case=${Date.now()}-${Math.random()}`
  );
  const fetchImpl = async () => ({
    ok: true,
    json: async () => ({ meta: {}, rows }),
  });
  return { ...module, fetchImpl };
}

test('findPlace takes a country qualifier and prefers a namesake in view', async () => {
  const { findPlace, fetchImpl } = await freshPack(PARIS);
  const texas = { latitude: 33.2, longitude: -96.0 };
  assert.equal((await findPlace('Paris', {}, fetchImpl)).wikidata, 'Q90');
  assert.equal(
    (await findPlace('Paris', { near: texas }, fetchImpl)).wikidata,
    'Q830149',
  );
  assert.equal(
    (await findPlace('Paris, United States', {}, fetchImpl)).wikidata,
    'Q830149',
  );
  assert.equal(
    (await findPlace('paris, us', {}, fetchImpl)).wikidata,
    'Q830149',
  );
  // A qualifier the packs cannot place is ignored.
  assert.equal(
    (await findPlace('Paris, Texas', { near: texas }, fetchImpl)).wikidata,
    'Q830149',
  );
});

test('a small place in view comes before a far bigger city of its name', async () => {
  const module = await import(`./wikidataCities.js?small-${Date.now()}`);
  // A village called Paris near Austin, in the 30_-100 detail tile.
  const village = ['Paris', 30.4, -97.6, 1200, 'US', 'Q-village'];
  const fetchImpl = async (url) => {
    const file = url.pathname.split('/').at(-1);
    const body =
      file === 'cities.json'
        ? { meta: {}, rows: PARIS }
        : file === 'index.json'
          ? { tiles: { '30_-100': 1 } }
          : { rows: file === '30_-100.json' ? [village] : [] };
    return { ok: true, json: async () => body };
  };
  const find = (name, near) =>
    module.findPlace(name, { near, includeSmallPlaces: true }, fetchImpl);
  const austin = { latitude: 30.27, longitude: -97.74 };
  assert.equal((await find('Paris', austin)).wikidata, 'Q-village');
  assert.ok((await find('Paris', austin)).distanceKm < 20);
  // A bigger namesake inside a wider search: the nearer village still wins.
  assert.equal(
    (
      await module.findPlace(
        'Paris',
        { near: austin, radiusKm: 600, includeSmallPlaces: true },
        fetchImpl,
      )
    ).wikidata,
    'Q-village',
  );
  // Only when small places are asked for.
  assert.equal(
    (await module.findPlace('Paris', { near: austin }, fetchImpl)).wikidata,
    'Q90',
  );
  // A qualifier still decides.
  assert.equal((await find('Paris, France', austin)).wikidata, 'Q90');
  // Nowhere near the village: the largest city of the name.
  assert.equal(
    (await find('Paris', { latitude: 0, longitude: 0 })).wikidata,
    'Q90',
  );
  assert.equal(
    (await module.findPlace('Paris', {}, fetchImpl)).wikidata,
    'Q90',
  );
  // Paris, Texas is nearer a view over it than the village is.
  const texas = { latitude: 33.6, longitude: -95.6 };
  assert.equal(
    (
      await module.findPlace(
        'Paris',
        { near: texas, radiusKm: 600, includeSmallPlaces: true },
        fetchImpl,
      )
    ).wikidata,
    'Q830149',
  );
});

test('a circle that reaches a pole spans every longitude', () => {
  assert.equal(lonHalfSpan(89, 150), 180);
  assert.ok(lonHalfSpan(60, 150) < 3);
  const cells = indexCities([['Pole camp', 89.9, 179, 1, '', 'Q1']]);
  assert.equal(citiesWithin(cells, 89, 0, 150).length, 1);
});

test('a country qualifier that matches no namesake finds nothing', async () => {
  const { findPlace, fetchImpl } = await freshPack([
    ...PARIS,
    ['Berlin', 52.52, 13.405, 3755251, 'DE', 'Q64'],
  ]);
  assert.equal(await findPlace('Paris, Germany', {}, fetchImpl), null);
  assert.equal(
    (await findPlace('Paris, France', {}, fetchImpl)).wikidata,
    'Q90',
  );
});

test('a lookup wraps at the antimeridian', () => {
  const cells = indexCities([['Taveuni', -16.8, -179.9, 15000, 'FJ', 'Q2']]);
  assert.equal(citiesWithin(cells, -16.8, 179.9, 40).length, 1);
});

test('small places use the shipped detail tile only when requested', async () => {
  const { findPlace, placesNear } = await import('./wikidataCities.js?detail');
  const fetched = [];
  const fetchPack = async (url) => {
    fetched.push(url.pathname.split('/').at(-1));
    return new Response(await readFile(url));
  };
  const near = { latitude: 30.343, longitude: -97.557 };
  const options = { near, radiusKm: 20 };
  assert.equal(await findPlace('Manor, US', options, fetchPack), null);
  assert.deepEqual(fetched, ['cities.json']);

  const manor = await findPlace(
    'Manor, US',
    { ...options, includeSmallPlaces: true },
    fetchPack,
  );
  assert.equal(manor?.wikidata, 'Q973072');
  assert.equal(manor?.distanceKm, 0);
  assert.deepEqual(fetched, ['cities.json', 'index.json', '30_-100.json']);

  const [closest] = await placesNear({ ...near, limit: 1 }, fetchPack);
  assert.deepEqual(closest, manor);
  assert.equal(
    await findPlace(
      'Manor, France',
      {
        ...options,
        includeSmallPlaces: true,
      },
      fetchPack,
    ),
    null,
  );
  assert.equal(fetched.length, 3);
});

test('a detail row whose name has no letter is not offered', async () => {
  const { placesNear } = await import('./wikidataCities.js?unnamed');
  const fetchPack = async (url) => new Response(await readFile(url));
  const near = await placesNear(
    { latitude: 12.126, longitude: -86.281, radiusKm: 1, limit: Infinity },
    fetchPack,
  );
  assert.equal(
    near.some((place) => place.wikidata === 'Q138762349'),
    false,
  );
  assert.ok(near.every((place) => /\p{L}/u.test(place.name)));
});

test('a small place that is a city of the same name nearby is listed once', async () => {
  const { placesNear } = await import('./wikidataCities.js?twins');
  const fetchPack = async (url) => new Response(await readFile(url));
  // Perth, Western Australia: the cities pack's Perth (Q3183) and a smaller
  // listing of it (Q14229145) 1 km apart; villages near Perth name neither
  // twice.
  const near = await placesNear(
    { latitude: -31.952, longitude: 115.861, radiusKm: 20, limit: Infinity },
    fetchPack,
  );
  const perths = near.filter((place) => place.name === 'Perth');
  assert.deepEqual(
    perths.map((place) => place.wikidata),
    ['Q3183'],
  );
});

test('the detail tile cache keeps the 64 most recently used tiles', async () => {
  const { placesNear } = await import('./wikidataCities.js?lru');
  const index = JSON.parse(
    await readFile(
      new URL('./local_data/wikidata_places/index.json', import.meta.url),
    ),
  );
  const keys = Object.keys(index.tiles).slice(0, 66);
  const fetched = [];
  const fetchPack = async (url) => {
    fetched.push(url.pathname.split('/').at(-1));
    return new Response(await readFile(url));
  };
  // The middle of each tile, with a radius inside it.
  const around = (key) => {
    const [lat, lon] = key.split('_').map(Number);
    return { latitude: lat + 2.5, longitude: lon + 2.5, radiusKm: 1 };
  };
  for (const key of keys.slice(0, 65)) await placesNear(around(key), fetchPack);
  const tileReads = () =>
    fetched.filter((name) => /^-?\d+_-?\d+\.json$/.test(name));
  assert.equal(tileReads().length, 65);
  // The first tile was the least recently used, so it is read again; the
  // most recent one is still kept.
  await placesNear(around(keys[64]), fetchPack);
  assert.equal(tileReads().length, 65);
  await placesNear(around(keys[0]), fetchPack);
  assert.equal(tileReads().length, 66);
});

test('a tile that cannot be read leaves the other places and the cities', async () => {
  const { placesNear } = await import('./wikidataCities.js?failing');
  const fetchPack = async (url) =>
    /_-100\.json$/.test(url.pathname)
      ? new Response('', { status: 503 })
      : new Response(await readFile(url));
  // Around Austin, on the corner of the 30_-100 and 30_-95 tiles.
  const near = await placesNear(
    { latitude: 30.27, longitude: -97.74, radiusKm: 300, limit: Infinity },
    fetchPack,
  );
  assert.ok(near.some((place) => place.name === 'Austin'));
  assert.ok(near.some((place) => place.longitude > -95));
});

test('a lookup asked for the whole globe reads only the tiles near its centre', async () => {
  const { placesNear, PLACE_TILE_KM } =
    await import('./wikidataCities.js?globe');
  const fetched = [];
  const fetchPack = async (url) => {
    fetched.push(url.pathname.split('/').at(-1));
    return new Response(await readFile(url));
  };
  const near = await placesNear(
    { latitude: 30.27, longitude: -97.74, radiusKm: 20000, limit: 50 },
    fetchPack,
  );
  const tileReads = fetched
    .filter((name) => /^-?\d+_-?\d+\.json$/.test(name))
    .sort();
  // 500 km around Austin: latitude 25.8 to 34.8, longitude -103 to -92.5.
  assert.equal(PLACE_TILE_KM, 500);
  assert.deepEqual(tileReads, [
    '25_-100.json',
    '25_-105.json',
    '25_-95.json',
    '30_-100.json',
    '30_-105.json',
    '30_-95.json',
  ]);
  assert.equal(near.length, 50);
  assert.ok(near.every((place) => place.distanceKm <= PLACE_TILE_KM));
  // Cities still count to the full radius.
  const far = await placesNear(
    { latitude: 30.27, longitude: -97.74, radiusKm: 20000, limit: Infinity },
    fetchPack,
  );
  assert.ok(far.some((place) => place.wikidata === 'Q90'));
  // Places from the tiles it read stop at 500 km too: Tahoka, Texas
  // (Q982084), a town of about 2,500, is 500.6 km away.
  assert.ok(!far.some((place) => place.wikidata === 'Q982084'));
  assert.ok(
    far
      .filter((place) => place.distanceKm > PLACE_TILE_KM)
      .every((place) => place.population >= 15000),
  );
  assert.equal(
    fetched.filter((name) => /^-?\d+_-?\d+\.json$/.test(name)).length,
    tileReads.length,
  );
});
