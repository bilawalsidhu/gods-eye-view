import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadWarendorfSourcesFromCatalog } from '../../server/providers/cctv/sources.js';

test('Warendorf catalog registers the Marktplatz webcam on official hosts only', (t) => {
  t.mock.method(console, 'log', () => {});
  const cameras = loadWarendorfSourcesFromCatalog();
  assert.deepEqual(
    cameras.map((camera) => camera.id),
    ['warendorf-marktplatz-rathaus'],
  );
  for (const camera of cameras) {
    assert.ok(
      /^https?:\/\/(webcam\.warendorf\.de|www\.kreis-warendorf\.de)\//.test(
        camera.url,
      ),
      camera.url,
    );
    assert.equal(camera.snapshotUrl, camera.url);
    assert.equal(camera.sourceKind, 'municipal-webcam');
    assert.equal(camera.poseSource, 'curated');
    assert.match(camera.license, /^Public municipal webcam data/);
  }
});

test('Warendorf loader tolerates a missing catalog file', (t) => {
  t.mock.method(console, 'warn', () => {});
  assert.deepEqual(
    loadWarendorfSourcesFromCatalog({ sourceRoot: '/nonexistent' }),
    [],
  );
});

test('Warendorf loader skips malformed rows without throwing', (t) => {
  t.mock.method(console, 'log', () => {});
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gev-warendorf-'));
  fs.mkdirSync(path.join(dir, 'config'));
  fs.writeFileSync(
    path.join(dir, 'config', 'cctv_sources.warendorf.json'),
    JSON.stringify([
      {
        id: { toString: null },
        url: 'https://www.kreis-warendorf.de/a.jpg',
        lat: 51.9,
        lon: 7.9,
      },
      {
        id: 'ok',
        url: 'https://www.kreis-warendorf.de/a.jpg',
        lat: 51.9,
        lon: 7.9,
      },
      {
        id: 'text-coords',
        url: 'https://www.kreis-warendorf.de/a.jpg',
        lat: '51.9',
        lon: '7.9',
      },
      {
        id: 'null-island',
        url: 'https://www.kreis-warendorf.de/a.jpg',
        lat: 0,
        lon: 0,
      },
      {
        id: 'off-host',
        url: 'https://evil.example/a.jpg',
        lat: 51.9,
        lon: 7.9,
      },
    ]),
  );
  const cameras = loadWarendorfSourcesFromCatalog({ sourceRoot: dir });
  assert.deepEqual(
    cameras.map((camera) => camera.id),
    ['ok'],
  );
});
