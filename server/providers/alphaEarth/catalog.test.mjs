import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile } from 'node:fs/promises';

import {
  cogUrl,
  createAlphaEarthCatalog,
  normalizeIndexRow,
} from './catalog.js';

const ROW = {
  path: 's3://us-west-2.opendata.source.coop/tge-labs/aef/v1/annual/2024/10N/abc-0000000000-0000000000.tiff',
  year: 2024n,
  crs: 'EPSG:32610',
  utm_west: 500000,
  utm_south: 5079040,
  utm_east: 581920,
  utm_north: 5160960,
  wgs84_west: -123,
  wgs84_south: 45.86,
  wgs84_east: -121.95,
  wgs84_north: 46.6,
};

test('index rows normalise to HTTPS-addressable records', () => {
  const record = normalizeIndexRow(ROW);
  assert.equal(record.year, 2024);
  assert.equal(record.zone, 10);
  assert.equal(record.south, false);
  assert.equal(
    cogUrl(record),
    'https://data.source.coop/tge-labs/aef/v1/annual/2024/10N/abc-0000000000-0000000000.tiff',
  );
});

test('rows outside the mirror, without UTM or with bad bounds are dropped', () => {
  assert.equal(normalizeIndexRow({ ...ROW, path: 'https://elsewhere/x.tiff' }), null);
  assert.equal(normalizeIndexRow({ ...ROW, path: ROW.path.replace('.tiff', '.vrt') }), null);
  assert.equal(normalizeIndexRow({ ...ROW, crs: 'EPSG:4326' }), null);
  assert.equal(normalizeIndexRow({ ...ROW, utm_west: 'x' }), null);
  assert.equal(normalizeIndexRow(null), null);
});

test('the catalog loads once, finds by year and box, and persists to disk', async () => {
  const cacheDir = await mkdtemp(path.join(os.tmpdir(), 'aef-catalog-'));
  let fetches = 0;
  const fetchRows = async () => {
    fetches += 1;
    return [ROW, { ...ROW, year: 2018n }, { ...ROW, crs: 'bogus' }];
  };
  const catalog = createAlphaEarthCatalog({ fetchRows, cacheDir });
  const [years] = await Promise.all([catalog.years(), catalog.ready()]);
  assert.deepEqual(years, [2018, 2024]);
  assert.equal(fetches, 1);
  const inside = { west: -122.5, south: 46, east: -122.4, north: 46.1 };
  assert.equal((await catalog.find(2024, inside)).length, 1);
  assert.equal((await catalog.find(2020, inside)).length, 0);
  assert.equal(
    (await catalog.find(2024, { west: 0, south: 0, east: 1, north: 1 })).length,
    0,
  );
  const disk = JSON.parse(
    await readFile(path.join(cacheDir, 'alpha-earth-index.json'), 'utf8'),
  );
  assert.equal(disk.records.length, 2);

  const restarted = createAlphaEarthCatalog({
    fetchRows: async () => assert.fail('disk copy should be used'),
    cacheDir,
  });
  assert.deepEqual(await restarted.years(), [2018, 2024]);
});

test('an expired disk copy is refreshed and a failed load can retry', async () => {
  const cacheDir = await mkdtemp(path.join(os.tmpdir(), 'aef-catalog-'));
  let clock = 0;
  await createAlphaEarthCatalog({
    fetchRows: async () => [ROW],
    cacheDir,
    now: () => clock,
  }).ready();
  clock = 8 * 24 * 3600_000;
  let attempts = 0;
  const catalog = createAlphaEarthCatalog({
    fetchRows: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('offline');
      return [ROW];
    },
    cacheDir,
    now: () => clock,
  });
  await assert.rejects(catalog.ready(), /offline/);
  assert.deepEqual(await catalog.years(), [2024]);
  assert.equal(attempts, 2);
});
