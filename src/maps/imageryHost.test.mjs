import test from 'node:test';
import assert from 'node:assert/strict';
import { NO_IMAGERY_HOST, resolveImageryHost } from './imageryHost.js';

test('a shown globe hosts imagery on the viewer collection', () => {
  const imageryLayers = { id: 'globe' };
  const host = resolveImageryHost({
    viewer: { scene: { globe: { show: true } }, imageryLayers },
    tileset: { imageryLayers: { id: 'tiles' } },
  });
  assert.deepEqual(host, { collection: imageryLayers, kind: 'globe' });
});

test('a hidden globe hands imagery to the tileset collection', () => {
  const imageryLayers = { id: 'tiles' };
  const host = resolveImageryHost({
    viewer: { scene: { globe: { show: false } }, imageryLayers: {} },
    tileset: { imageryLayers, isDestroyed: () => false },
  });
  assert.deepEqual(host, { collection: imageryLayers, kind: 'tileset' });
});

test('no globe and no tileset means nowhere to drape', () => {
  assert.deepEqual(
    resolveImageryHost({
      viewer: { scene: { globe: { show: false } }, imageryLayers: {} },
      tileset: null,
    }),
    { collection: null, kind: 'none' },
  );
  assert.deepEqual(resolveImageryHost({}), { collection: null, kind: 'none' });
  assert.deepEqual(
    resolveImageryHost({
      viewer: { scene: { globe: { show: false } } },
      tileset: { imageryLayers: {}, isDestroyed: () => true },
    }),
    { collection: null, kind: 'none' },
  );
  assert.match(NO_IMAGERY_HOST, /globe map/);
});
