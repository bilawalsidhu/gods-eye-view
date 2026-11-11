import test from 'node:test';
import assert from 'node:assert/strict';
import { NO_IMAGERY_HOST, resolveImageryHost } from './imageryHost.js';
import { bindRenderer } from '../render/rendererOf.js';
import { createStubRenderer } from '../render/stub/index.js';
import { globeMapEngine } from './globeEngine.js';

/** A scene object bound to a stub renderer, its globe shown or hidden. */
function scene({ globeShown, capabilities } = {}) {
  const renderer = createStubRenderer(
    capabilities ? { capabilities } : undefined,
  );
  if (globeShown !== undefined) renderer.globe.setGlobeVisible(globeShown);
  const viewer = {};
  bindRenderer(viewer, renderer);
  return { viewer, renderer };
}

test('a shown globe hosts imagery on the globe port', () => {
  const { viewer, renderer } = scene({ globeShown: true });
  const host = resolveImageryHost({ viewer, tileset: { id: 'tiles' } });
  assert.deepEqual(host, { collection: renderer.globe.imagery, kind: 'globe' });
});

test('a hidden globe hands imagery to the shown base tileset', () => {
  const { viewer } = scene({ globeShown: false });
  const tileset = { id: 'tiles', isDestroyed: () => false };
  const host = resolveImageryHost({ viewer, tileset });
  assert.deepEqual(host, { collection: tileset, kind: 'tileset' });
});

test('without globe visibility, the map engine says whether the globe is shown', () => {
  const { viewer, renderer } = scene({ capabilities: [] });
  assert.equal(renderer.globe.isGlobeVisible, undefined);
  const tileset = { id: 'tiles' };
  globeMapEngine.setGlobeShown(viewer, false);
  assert.deepEqual(resolveImageryHost({ viewer, tileset }), {
    collection: tileset,
    kind: 'tileset',
  });
  // A globe stack shows the globe: a tileset kept from startup is not the host.
  globeMapEngine.setGlobeShown(viewer, true);
  assert.deepEqual(resolveImageryHost({ viewer, tileset }), {
    collection: renderer.globe.imagery,
    kind: 'globe',
  });
});

test('no globe and no tileset means nowhere to drape', () => {
  const { viewer } = scene({ globeShown: false });
  assert.deepEqual(resolveImageryHost({ viewer, tileset: null }), {
    collection: null,
    kind: 'none',
  });
  assert.deepEqual(resolveImageryHost({}), { collection: null, kind: 'none' });
  assert.deepEqual(
    resolveImageryHost({ viewer, tileset: { isDestroyed: () => true } }),
    { collection: null, kind: 'none' },
  );
  assert.match(NO_IMAGERY_HOST, /globe map/);
});
