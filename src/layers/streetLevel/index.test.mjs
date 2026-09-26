import assert from 'node:assert/strict';
import test from 'node:test';
import { createStreetLevelLayer } from './index.js';

/** The smallest provider the core accepts; nothing here touches a viewer. */
function fakeProvider() {
  return {
    id: 'mapillary',
    name: 'Mapillary',
    label: 'MAPILLARY',
    requiresKeyId: null,
    pickPrefix: 'mly:',
    colors: { coverage: '#05cb63' },
    credit: { key: 'mapillary', html: 'Mapillary' },
    capabilities: {
      coverage: 'tiles',
      sequences: false,
      pano: true,
      capturedAt: true,
      creator: true,
      follow: true,
    },
    legend: [],
    externalUrl: (id) => `https://example.test/${id}`,
    create: () => ({
      status: async () => ({ configured: true }),
      init() {},
      activate() {},
      deactivate() {},
      destroy() {},
      refreshCoverage() {},
      setFilter() {},
      coverageStats: () => ({
        count: 0,
        zoom: null,
        kind: null,
        loading: false,
        hint: '',
        error: null,
        keyRequired: false,
      }),
      handlePick: () => false,
      nearestImage: async () => null,
      viewer: {
        mount: async () => {},
        open: async () => {},
        close() {},
        unmount() {},
        resize() {},
        onPose: () => () => {},
      },
    }),
  };
}

/** A map stack controller that can be switched between stacks. */
function fakeMapStack(initial) {
  let active = initial;
  const listeners = new Set();
  return {
    getActiveId: () => active,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    switchTo(id) {
      active = id;
      for (const listener of listeners) listener();
    },
    listenerCount: () => listeners.size,
  };
}

test('FOLLOW is available only while the Google 3D map stack is active', () => {
  const layer = createStreetLevelLayer({ providers: [fakeProvider()] });
  assert.equal(
    layer.getUIState().street.followAvailable,
    false,
    'unknown stack: off',
  );

  const stack = fakeMapStack('esri-imagery');
  layer.attachMapStackController(stack);
  assert.equal(layer.getUIState().street.followAvailable, false);
  layer.setFollow(true);
  assert.equal(layer.getUIState().street.follow, false, 'refused on Esri');

  stack.switchTo('photoreal');
  assert.equal(layer.getUIState().street.followAvailable, true);
  layer.setFollow(true);
  assert.equal(layer.getUIState().street.follow, true);

  stack.switchTo('osm');
  assert.equal(layer.getUIState().street.followAvailable, false);
  assert.equal(
    layer.getUIState().street.follow,
    false,
    'leaving Google 3D stops following',
  );
});

test('the layer lets go of the map stack when destroyed or re-attached', () => {
  const layer = createStreetLevelLayer({ providers: [fakeProvider()] });
  const first = fakeMapStack('photoreal');
  layer.attachMapStackController(first);
  assert.equal(first.listenerCount(), 1);
  const second = fakeMapStack('photoreal');
  layer.attachMapStackController(second);
  assert.equal(first.listenerCount(), 0);
  assert.equal(second.listenerCount(), 1);
  layer.destroy();
  assert.equal(second.listenerCount(), 0);
});
