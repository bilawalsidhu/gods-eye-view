import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadWarendorfSourcesFromCatalog } from '../../server/providers/cctv/sources.js';

test('Warendorf catalog registers the three municipal webcams on official hosts only', (t) => {
  t.mock.method(console, 'log', () => {});
  const cameras = loadWarendorfSourcesFromCatalog();
  assert.deepEqual(
    cameras.map((camera) => camera.id),
    [
      'warendorf-marktplatz-rathaus',
      'warendorf-kreishaus-zulassung',
      'beckum-zulassungsstelle',
    ],
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
