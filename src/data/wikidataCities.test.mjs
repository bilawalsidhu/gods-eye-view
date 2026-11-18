// src/data/wikidataCities.test.mjs — lookups over the bundled Wikidata
// places packs, with the packs served from memory.
import test from 'node:test';
import assert from 'node:assert/strict';
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
