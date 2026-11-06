import test from 'node:test';
import assert from 'node:assert/strict';
import { createLifecycle } from './lifecycle.js';
test('missions preserve the satellite target before their focus flight releases it', async () => {
  const previous = globalThis.document;
  globalThis.document = { getElementById: () => null };
  try {
    let target = 25544,
      snapshot = null;
    const lifecycle = createLifecycle({
      state: { _engine: {} },
      services: { render: {} },
      getRenderer: () => ({ setVisible() {} }),
      parts: {
        orbitRendering: { syncMissionOrbitPrimitiveVisibility() {} },
        selection: {
          focusFullGlobe() {
            target = null;
          },
          setSelectedMission() {},
        },
        ingestion: {
          async captureSatelliteDependency() {
            snapshot = target;
          },
        },
      },
    });
    await lifecycle.methods._enableBody();
    assert.equal(target, null);
    assert.equal(
      snapshot,
      25544,
      'mission camera must not erase the restoration target',
    );
  } finally {
    if (previous === undefined) delete globalThis.document;
    else globalThis.document = previous;
  }
});
