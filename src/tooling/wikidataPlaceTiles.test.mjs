// The Wikidata places pack is written by scripts/wikidataPlaceTiles.mjs. Its
// rows come from a Wikidata query that cannot be repeated offline, so this
// checks the steps after it: the shipped rows, sorted and filtered as the
// build does, give back every shipped file byte for byte, and hash to the
// value the pack's README records.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  keepBuiltIfUnchanged,
  keepPackBuiltIfUnchanged,
  placeTileFiles,
  tileKey,
  withoutCities,
  withoutNearTwins,
} from '../../scripts/wikidataPlaceTiles.mjs';

const PACK = new URL('../data/local_data/wikidata_places/', import.meta.url);
const CITIES = new URL(
  '../data/local_data/wikidata_cities/cities.json',
  import.meta.url,
);

test('a tile is named by its south-west corner', () => {
  assert.equal(tileKey(30.343, -97.557), '30_-100');
  assert.equal(tileKey(-0.5, 0), '-5_0');
  assert.equal(tileKey(10.682, -71.036), '10_-75');
  // In the tiles the lookups read: the top row, and -180 for 180.
  assert.equal(tileKey(90, 180), '85_-180');
});

test('re-tiles the shipped rows deterministically', async () => {
  const index = JSON.parse(await readFile(new URL('index.json', PACK), 'utf8'));
  const rows = [];
  for (const key of Object.keys(index.tiles)) {
    const tile = JSON.parse(
      await readFile(new URL(`${key}.json`, PACK), 'utf8'),
    );
    rows.push(...tile.rows);
  }
  assert.equal(rows.length, 137662);
  // As scripts/build-wikidata-cities.mjs orders and filters its rows.
  rows.sort((a, b) => b[3] - a[3] || a[5].localeCompare(b[5]));
  const cityIds = JSON.parse(await readFile(CITIES, 'utf8')).rows.map(
    (row) => row[5],
  );
  const kept = withoutNearTwins(withoutCities(rows, cityIds));
  assert.equal(
    kept.length,
    rows.length,
    'the shipped rows are already filtered',
  );
  const readme = await readFile(new URL('README.md', PACK), 'utf8');
  const digest = createHash('sha256')
    .update(JSON.stringify(kept))
    .digest('hex');
  assert.ok(readme.includes(`\`${digest}\``), 'README rows hash');
  const files = placeTileFiles(kept, index.meta);
  const shipped = (await readdir(PACK)).filter((name) => name !== 'README.md');
  assert.deepEqual([...files.keys()].sort(), shipped.sort());
  for (const [name, text] of files)
    assert.equal(text, await readFile(new URL(name, PACK), 'utf8'), name);
});

test('a place the cities pack holds is left out of the tiles', () => {
  const rows = [
    ['Palmares', 8.1, -82.1, 11000, 'CR', 'Q1542741'],
    ['Smallville', 8.2, -82.2, 2000, 'CR', 'Q1'],
  ];
  assert.deepEqual(
    withoutCities(rows, ['Q1542741']).map((row) => row[5]),
    ['Q1'],
  );
});

test('one place listed twice nearby keeps its larger listing', () => {
  const rows = [
    ['Orange', 41.278, -73.026, 14280, 'US', 'Q1'],
    ['Orange', 41.28, -73.02, 13950, 'US', 'Q2'],
    // Across a border: a namesake, kept.
    ['Orange', 41.281, -73.03, 3000, 'CA', 'Q3'],
    // Far away: another place.
    ['Orange', 33.79, -117.85, 2000, 'US', 'Q4'],
    ['Zábřeh', 49.88, 16.87, 13320, 'CZ', 'Q5'],
    ['Zabreh', 49.881, 16.871, 1200, 'CZ', 'Q6'],
  ];
  assert.deepEqual(
    withoutNearTwins(rows).map((row) => row[5]),
    ['Q1', 'Q3', 'Q4', 'Q5'],
  );
});

test('twins are found where longitude cells narrow, and across 180°', () => {
  const rows = [
    // 1.98 km apart at 70° N, two longitude cells apart.
    ['Nord', 70, 10.049, 9000, 'NO', 'Q1'],
    ['Nord', 70, 10.101, 2000, 'NO', 'Q2'],
    // Either side of the antimeridian, under 2 km apart.
    ['Kai', -16.5, 179.995, 5000, 'FJ', 'Q3'],
    ['Kai', -16.5, -179.995, 1000, 'FJ', 'Q4'],
  ];
  assert.deepEqual(
    withoutNearTwins(rows).map((row) => row[5]),
    ['Q1', 'Q3'],
  );
});

test('a rebuild of unchanged rows keeps the earlier build stamp', () => {
  const earlier = `${JSON.stringify({ meta: { built: '2026-01-01T00:00:00.000Z', count: 2 }, rows: [1, 2] })}\n`;
  const same = `${JSON.stringify({ meta: { built: '2026-11-18T00:00:00.000Z', count: 2 }, rows: [1, 2] })}\n`;
  const changed = `${JSON.stringify({ meta: { built: '2026-11-18T00:00:00.000Z', count: 3 }, rows: [1, 2, 3] })}\n`;
  assert.equal(keepBuiltIfUnchanged(same, earlier), earlier);
  assert.equal(keepBuiltIfUnchanged(changed, earlier), changed);
  assert.equal(keepBuiltIfUnchanged(same, undefined), same);
  assert.equal(keepBuiltIfUnchanged(same, 'not json'), same);
});

test('the places index keeps its build stamp only when no tile changed', () => {
  const rows = [
    ['Aa', 31, -98, 2000, 'US', 'Q1'],
    ['Bb', 41, -88, 1500, 'US', 'Q2'],
  ];
  const meta = (built) => ({
    source: 's',
    license: 'l',
    built,
    minPopulation: 1000,
    maxPopulation: 15000,
    columns: [],
  });
  const earlier = placeTileFiles(rows, meta('2026-01-01T00:00:00.000Z'));
  const built = (files) => JSON.parse(files.get('index.json')).meta.built;
  const rebuild = (newRows) =>
    keepPackBuiltIfUnchanged(
      placeTileFiles(newRows, meta('2026-11-18T00:00:00.000Z')),
      earlier,
    );
  assert.equal(built(rebuild(rows)), '2026-01-01T00:00:00.000Z');
  // Same row count in every tile, new population: a new stamp.
  const changed = [['Aa', 31, -98, 2100, 'US', 'Q1'], rows[1]];
  assert.equal(built(rebuild(changed)), '2026-11-18T00:00:00.000Z');
  // A tile of the earlier build left out: a new stamp.
  assert.equal(built(rebuild([rows[0]])), '2026-11-18T00:00:00.000Z');
});
