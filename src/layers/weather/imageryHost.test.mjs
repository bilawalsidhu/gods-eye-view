import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveImageryHost,
  imageryHostStatus,
  NO_IMAGERY_HOST,
} from './imageryHost.js';

test('only a missing host suspends weather; 3D Tiles has no height gate', () => {
  assert.equal(imageryHostStatus({ kind: 'tileset' }), null);
  assert.equal(imageryHostStatus({ kind: 'globe' }), null);
  assert.equal(imageryHostStatus({ kind: 'none' }), NO_IMAGERY_HOST);
});

test('visible globe takes precedence over a tileset', () => {
  const viewer = { imageryLayers: {}, scene: { globe: { show: true } } };
  assert.deepEqual(
    resolveImageryHost({ viewer, tileset: { imageryLayers: {} } }),
    { collection: viewer.imageryLayers, kind: 'globe' },
  );
});
test('hidden globe uses the supplied tileset imagery collection', () => {
  const tileset = { imageryLayers: {} };
  const viewer = { scene: { globe: { show: false } } };
  assert.deepEqual(resolveImageryHost({ viewer, tileset }), {
    collection: tileset.imageryLayers,
    kind: 'tileset',
  });
});
test('hidden globe without an imagery-capable tileset has no host', () => {
  for (const tileset of [null, {}])
    assert.deepEqual(
      resolveImageryHost({
        viewer: { scene: { globe: { show: false } } },
        tileset,
      }),
      { collection: null, kind: 'none' },
    );
});
