import test from 'node:test';
import assert from 'node:assert/strict';
import { createLifecycle } from './lifecycle.js';

test('enable restores cached installation markers and geometry before a refresh', () => {
  const noop = () => {};
  const viewer = { camera: {} };
  const state = {
    viewer,
    records: [{ id: 'base' }],
    recordById: new Map(),
  };
  let markersVisible = false;
  let drawnShown = false;
  const parts = {
    namedMarkers: {
      enable: () => {
        markersVisible = true;
      },
      sync: noop,
      hide: () => {
        markersVisible = false;
      },
    },
    rendering: {
      attach: noop,
      detach: noop,
      setShown: (shown) => {
        drawnShown = shown;
      },
    },
    viewport: { clearUnavailableRetry: noop },
    ingestion: { setInstallationStatus: noop },
  };
  const lifecycle = createLifecycle({
    state,
    services: {
      picking: { registerPickOwner: noop, unregisterPickOwner: noop },
      context: { clearSelectedEntityContextForLayer: noop },
    },
    parts,
    source: {},
  }).methods;
  try {
    for (let cycle = 0; cycle < 2; cycle++) {
      lifecycle.enable();
      assert.equal(drawnShown, true);
      assert.equal(markersVisible, true);
      lifecycle.disable();
      assert.equal(drawnShown, false);
      assert.equal(markersVisible, false);
    }
  } finally {
    lifecycle.disable();
  }
});
