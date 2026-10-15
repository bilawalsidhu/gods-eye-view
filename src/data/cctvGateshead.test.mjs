import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  isGatesheadImageUrl,
  loadGatesheadSourcesFromCatalog,
  loadA19SourcesFromCatalog,
  loadAdditionalUtmcSourcesFromCatalog,
  createGatesheadSnapshotReader,
} from '../../server/providers/cctv/gateshead.js';

const url =
  'https://netrafficcams.co.uk/sites/default/files/images/cameras/GH_A167F1.jpg';
test('only exact registered public image-host paths are admitted', () => {
  assert.ok(isGatesheadImageUrl(url));
  for (const value of [
    null,
    'https://evil.example/a.jpg',
    url + '?redirect=evil',
    url + '#x',
    url.replace('https:', 'http:'),
    url.replace('.co.uk/', '.co.uk.evil.example/'),
    url.replace('//net', '//user@net'),
  ]) {
    assert.equal(isGatesheadImageUrl(value), false, String(value));
  }
});

test('additional UTMC pack uses unique published locations without duplicating the original packs', () => {
  const added = loadAdditionalUtmcSourcesFromCatalog();
  const original = [
    ...loadGatesheadSourcesFromCatalog(),
    ...loadA19SourcesFromCatalog(),
  ];
  const pages = new Set(original.map((c) => c.sourcePage));
  assert.ok(added.length >= 250 && added.length <= 500);
  assert.equal(new Set(added.map((c) => c.id)).size, added.length);
  assert.ok(
    added.every((c) => !pages.has(c.sourcePage) && isGatesheadImageUrl(c.url)),
  );
  assert.ok(added.some((c) => c.city === 'Newcastle'));
  assert.ok(added.some((c) => c.city === 'Durham'));
});

test('A19 pack contains 18 unique published corridor cameras with regional attribution', () => {
  const cameras = loadA19SourcesFromCatalog();
  assert.equal(cameras.length, 18);
  assert.equal(new Set(cameras.map((c) => c.id)).size, cameras.length);
  assert.ok(
    cameras.every(
      (c) =>
        /\bA19(?!\d)/.test(c.name) &&
        c.cityId === 'a19' &&
        isGatesheadImageUrl(c.url),
    ),
  );
  assert.ok(cameras.some((c) => c.name.includes('Tyne Tunnel')));
  assert.ok(cameras.some((c) => c.city === 'Sunderland'));
  assert.ok(
    !cameras.some((c) => /Peterlee|Northallerton|Nuneaton/.test(c.name)),
  );
});

test('catalog rejects bad coordinates, duplicate ids and untrusted hosts', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gev-gateshead-'));
  fs.mkdirSync(path.join(root, 'config'));
  const valid = {
    id: 'gateshead-312',
    name: 'Tyne Bridge',
    lat: 54.9655,
    lon: -1.6038,
    url,
  };
  fs.writeFileSync(
    path.join(root, 'config/cctv_sources.gateshead.json'),
    JSON.stringify({
      cameras: [
        valid,
        valid,
        { ...valid, id: 'gateshead-1', lat: null },
        { ...valid, id: 'gateshead-2', lon: 0 },
        { ...valid, id: 'gateshead-3', url: 'https://evil.example/a.jpg' },
      ],
    }),
  );
  const cameras = loadGatesheadSourcesFromCatalog({ sourceRoot: root });
  assert.equal(cameras.length, 1);
  assert.equal(cameras[0].feedType, 'image');
  assert.equal(cameras[0].headingConfidence, 'low');
  assert.match(cameras[0].provider, /snapshot/);
});

test('concurrent map and preview requests share a frame, then refresh after one minute', async () => {
  let time = 100000,
    reads = 0;
  const reader = createGatesheadSnapshotReader({
    now: () => time,
    readImage: async (target) => {
      reads++;
      assert.match(target, /gev_minute=/);
      return { ok: true, body: Buffer.from([reads]) };
    },
  });
  const [first, second] = await Promise.all([reader(url), reader(url)]);
  assert.equal(reads, 1);
  assert.equal(first, second);
  time += 59999;
  assert.equal(await reader(url), first);
  time += 1;
  assert.notEqual(await reader(url), first);
  assert.equal(reads, 2);
  await reader('http://127.0.0.1/private');
  assert.equal(reads, 2);
});

test('provider failures become unavailable and can recover without serving the old frame', async () => {
  let time = 0,
    attempts = 0;
  const reader = createGatesheadSnapshotReader({
    now: () => time,
    readImage: async () => {
      if (++attempts === 1) throw new Error('offline');
      return { ok: true };
    },
  });
  assert.equal(await reader(url), null);
  assert.equal(await reader(url), null);
  assert.equal(attempts, 1);
  time = 60000;
  assert.equal((await reader(url)).ok, true);
});

test('shipped Gateshead catalog has unique mapped public cameras including the Tyne Bridge', () => {
  const cameras = loadGatesheadSourcesFromCatalog();
  assert.equal(cameras.length, 61);
  assert.equal(new Set(cameras.map((c) => c.id)).size, cameras.length);
  assert.ok(cameras.some((c) => c.name.includes('Tyne Bridge')));
  assert.ok(
    cameras.every(
      (c) => c.cityId === 'gateshead' && isGatesheadImageUrl(c.url),
    ),
  );
});
