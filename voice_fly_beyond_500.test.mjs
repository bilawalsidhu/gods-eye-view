import assert from 'node:assert/strict';
import test from 'node:test';
import { createGevActionRunner } from './src/voice/gevActions.js';
import { bindFakeCesiumCamera } from './src/testSupport/fakeCameraPort.mjs';

test('fly_to_location reaches an air-quality station beyond the first 500 records', async () => {
  const rows = Array.from({ length: 600 }, (_, i) => ({
    id: `s${i}`,
    lat: 10 + i * 0.01,
    lon: 20,
    name: `Station ${i}`,
  }));
  // The layer's own signature: getAnalystRecords(maxCount = 500), as in
  // src/layers/airQuality/index.js; the analyst query asks for up to 250,000.
  const module = {
    getAnalystRecords: (maxCount = 500) => rows.slice(0, maxCount),
  };
  globalThis.window = globalThis.window || {
    clearTimeout,
    setTimeout,
    requestIdleCallback: null,
  };
  const viewer = {
    clock: { onTick: { addEventListener: () => () => {} } },
    scene: {
      canvas: {
        clientWidth: 100,
        clientHeight: 100,
        addEventListener() {},
        removeEventListener() {},
      },
      globe: { getHeight: () => 0 },
      tweens: [],
    },
    camera: {
      moveEnd: { addEventListener() {} },
      cancelFlight() {},
      flyToBoundingSphere() {},
      lookAtTransform() {},
    },
  };
  bindFakeCesiumCamera(viewer);
  const runner = createGevActionRunner({
    viewer,
    styleManager: {},
    dataManager: {
      layers: new Map([['air-quality', { module }]]),
      isEnabled: () => true,
      getAll: () => [],
    },
  });
  const far = await runner('fly_to_location', {
    entity: { layerId: 'air-quality', id: 's550', label: 'Station 550' },
  });
  // Now: ok false, error 'Station 550 is no longer loaded'.
  assert.equal(far.ok, true, far.error);
  assert.equal(far.latitude, 15.5);
});
