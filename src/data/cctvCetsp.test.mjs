import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  cetspCameraToSource,
  loadCetspSourcesFromCatalog,
} from '../../server/providers/cctv/cetsp.js';
import { createCctvCatalog } from '../../server/providers/cctv/catalog.js';

const row = {
  id: 'cetsp-164',
  name: 'Av. Paulista × R. Peixoto Gomide (MASP)',
  lat: -23.560898,
  lon: -46.657096,
  url: 'https://cameras.cetsp.com.br/Cams/164/1.jpg',
};

test('curated catalog registers only frame 1 of CET camera folders', (t) => {
  t.mock.method(console, 'log', () => {});
  const cameras = loadCetspSourcesFromCatalog();
  assert.equal(cameras.length, 14);
  for (const camera of cameras) {
    const folder = /^cetsp-(\d+)$/.exec(camera.id)?.[1];
    assert.ok(folder, camera.id);
    assert.equal(
      camera.url,
      `https://cameras.cetsp.com.br/Cams/${folder}/1.jpg`,
    );
    assert.equal(camera.snapshotUrl, camera.url);
    assert.equal(camera.cityId, 'sao-paulo');
    assert.equal(camera.sourceKind, 'cetsp-public');
    assert.equal(camera.headingConfidence, 'low');
    assert.match(camera.license, /OpenStreetMap/);
  }
});

test('converter keeps the row and rebuilds the frame URL from the folder', () => {
  const camera = cetspCameraToSource(row);
  assert.equal(camera.id, 'cetsp-164');
  assert.equal(camera.lat, row.lat);
  assert.equal(camera.lon, row.lon);
  assert.equal(camera.name, row.name);
  assert.equal(camera.feedType, 'image');
  assert.equal(camera.url, row.url);
  assert.match(camera.credit, /CET-SP/);
});

test('off-host, odd-path and mismatched rows cannot enter the proxy registry', () => {
  for (const url of [
    'http://cameras.cetsp.com.br/Cams/164/1.jpg',
    'https://cameras.cetsp.com.br.evil.test/Cams/164/1.jpg',
    'https://user:pass@cameras.cetsp.com.br/Cams/164/1.jpg',
    'https://cameras.cetsp.com.br/Cams/164/1.jpg?x=1',
    'https://cameras.cetsp.com.br/Cams/164/2.jpg',
    'https://cameras.cetsp.com.br/Cams/../164/1.jpg',
    'https://cameras.cetsp.com.br/Cams/0/1.jpg',
    'https://cameras.cetsp.com.br/Imgs/sp.jpg',
    'http://127.0.0.1/private',
    '',
    null,
  ]) {
    assert.equal(cetspCameraToSource({ ...row, url }), null, String(url));
  }
  for (const invalid of [
    null,
    'cetsp-164',
    { ...row, id: 'cetsp-15' },
    { ...row, lat: '-23.56' },
    { ...row, lat: 0, lon: 0 },
    { ...row, lat: row.lon, lon: row.lat },
    { ...row, lat: NaN },
  ]) {
    assert.equal(cetspCameraToSource(invalid), null, JSON.stringify(invalid));
  }
});

test('loader tolerates a missing or malformed catalog file', (t) => {
  t.mock.method(console, 'warn', () => {});
  assert.deepEqual(
    loadCetspSourcesFromCatalog({ sourceRoot: '/nonexistent' }),
    [],
  );
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gev-cetsp-'));
  fs.mkdirSync(path.join(dir, 'config'));
  const file = path.join(dir, 'config', 'cctv_sources.cetsp.json');
  fs.writeFileSync(file, '{ not json');
  assert.deepEqual(loadCetspSourcesFromCatalog({ sourceRoot: dir }), []);
});

test('loader skips bad rows and duplicate folders', (t) => {
  t.mock.method(console, 'log', () => {});
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gev-cetsp-'));
  fs.mkdirSync(path.join(dir, 'config'));
  fs.writeFileSync(
    path.join(dir, 'config', 'cctv_sources.cetsp.json'),
    JSON.stringify([
      row,
      { ...row, name: 'duplicate' },
      { ...row, url: 'https://evil.example/a.jpg' },
      null,
    ]),
  );
  const cameras = loadCetspSourcesFromCatalog({ sourceRoot: dir });
  assert.deepEqual(
    cameras.map((camera) => [camera.id, camera.name]),
    [['cetsp-164', row.name]],
  );
});

/** Run one catalog refresh with CCTV_CETSP_ENABLED set to `flag` (undefined
 * leaves it unset), restoring the environment afterwards. */
async function runCatalogWithCetspFlag(t, flag) {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  t.mock.method(globalThis, 'fetch', async () => Response.json([]));
  const saved = process.env.CCTV_CETSP_ENABLED;
  try {
    if (flag === undefined) delete process.env.CCTV_CETSP_ENABLED;
    else process.env.CCTV_CETSP_ENABLED = flag;
    return await createCctvCatalog({ sourceRoot: process.cwd() })();
  } finally {
    if (saved === undefined) delete process.env.CCTV_CETSP_ENABLED;
    else process.env.CCTV_CETSP_ENABLED = saved;
  }
}

test('CCTV_CETSP_ENABLED=1 wires the CET-SP pack into the catalog', async (t) => {
  const sources = await runCatalogWithCetspFlag(t, '1');
  assert.equal(
    sources.filter((camera) => camera.cityId === 'sao-paulo').length,
    14,
  );
});

// CET publishes no reuse terms for the stills, so an install that has not
// opted in must never register them.
for (const [label, flag] of [
  ['an unset CCTV_CETSP_ENABLED', undefined],
  ['an empty CCTV_CETSP_ENABLED', ''],
  ['CCTV_CETSP_ENABLED=0', '0'],
  ['CCTV_CETSP_ENABLED=true', 'true'],
]) {
  test(`${label} leaves CET-SP out of the catalog`, async (t) => {
    const sources = await runCatalogWithCetspFlag(t, flag);
    assert.ok(sources.length > 0, 'the other packs still load');
    assert.ok(!sources.some((camera) => camera.url?.includes('cetsp.com.br')));
  });
}
