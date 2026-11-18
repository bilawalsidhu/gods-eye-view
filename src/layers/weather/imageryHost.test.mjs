import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveImageryHost,
  imageryHostStatus,
  NO_IMAGERY_HOST,
} from './imageryHost.js';
import { bindRenderer } from '../../render/rendererOf.js';
import { createStubRenderer } from '../../render/stub/index.js';

test('only a missing host suspends weather; 3D Tiles has no height gate', () => {
  assert.equal(imageryHostStatus({ kind: 'tileset' }), null);
  assert.equal(imageryHostStatus({ kind: 'globe' }), null);
  assert.equal(imageryHostStatus({ kind: 'none' }), NO_IMAGERY_HOST);
});

test('weather drapes on the map stack imagery host', () => {
  const renderer = createStubRenderer();
  const viewer = {};
  bindRenderer(viewer, renderer);
  const tileset = { id: 'tiles' };
  assert.deepEqual(resolveImageryHost({ viewer, tileset }), {
    collection: renderer.globe.imagery,
    kind: 'globe',
  });
  renderer.globe.setGlobeVisible(false);
  assert.deepEqual(resolveImageryHost({ viewer, tileset }), {
    collection: tileset,
    kind: 'tileset',
  });
  assert.deepEqual(resolveImageryHost({ viewer, tileset: null }), {
    collection: null,
    kind: 'none',
  });
});
