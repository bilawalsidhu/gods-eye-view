// src/data/groundSnap.test.mjs — the tile-skin snap at its two sampling edges.
//
// `heightFor`'s cache/hold/drift logic runs inside the flights and military
// layers, but the SAMPLE itself has two edges that were each a field failure
// and that nothing else pins:
//  - a scene with NO duck-typed tileset (globe/OSM fallback) must still let the
//    one-shot sample fire — `_tilesReady` may not block the path forever;
//  - a `scene.sampleHeight` that THROWS (no depth textures, scene mid-teardown)
//    is a miss that earns retry backoff, never an escaping exception in the
//    middle of the per-tick fleet update.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { createGroundSnap } from './groundSnap.js';

/** A viewer whose primitives list holds no Cesium3DTileset. */
const noTilesetViewer = (sampleHeight) => ({
  scene: { primitives: { length: 0, get: () => null }, sampleHeight },
});

const atAustin = Cesium.Cartesian3.fromDegrees(-97.7431, 30.2672, 100);

test('a scene with no tileset (globe/OSM fallback) still samples and caches', () => {
  let samples = 0;
  const snap = createGroundSnap();
  const viewer = noTilesetViewer(() => (samples += 1, 138.0));

  assert.equal(
    snap.heightFor(viewer, 'ADF001', atAustin),
    138.0,
    'the snap answers from the rendered skin even without a Google tileset',
  );
  assert.equal(samples, 1);
  // One-shot per contact: the cached snap answers the next tick directly.
  assert.equal(snap.heightFor(viewer, 'ADF001', atAustin), 138.0);
  assert.equal(samples, 1, 'the cache stops the pick render from repeating');
});

test('a throwing sampleHeight is a COLD miss with backoff, not a crash', () => {
  let samples = 0;
  const snap = createGroundSnap();
  const viewer = noTilesetViewer(() => {
    samples += 1;
    throw new Error('depth textures unavailable');
  });

  assert.doesNotThrow(() => snap.heightFor(viewer, 'RCH777', atAustin));
  assert.equal(samples, 1, 'the sample was attempted exactly once');
  assert.equal(
    snap.heightFor(viewer, 'RCH777', atAustin),
    null,
    'no evidence means the model stays hidden rather than guessing a height',
  );
  assert.equal(samples, 1, 'the miss earned a retry backoff instead of a per-tick re-probe');

  snap.forget('RCH777');
  assert.equal(snap.heightFor(viewer, 'RCH777', atAustin), null);
  assert.equal(samples, 2, 'forget() drops the backoff so eviction/re-arm can try again');
});
