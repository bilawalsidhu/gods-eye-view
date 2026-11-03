import assert from 'node:assert/strict';
import test from 'node:test';
import { createAircraftSceneBinding } from './sceneBinding.js';
import { LayerBindings } from '../../ui/layerBindings.js';
import { createEngineEvent } from '../../globe/contract.js';

test('resuming an aircraft on Cesium preserves the pending share navigation', (t) => {
  const previous = globalThis.window;
  globalThis.window = new EventTarget();
  t.after(() => {
    globalThis.window = previous;
  });
  const trackedEntityChanged = createEngineEvent();
  let generation = 1;
  const shell = new LayerBindings({
    viewer: { trackedEntityChanged },
    services: {},
    operations: {
      _stampNavigation() {
        generation++;
      },
    },
  });
  shell.observeCamera();
  t.after(() => shell.stop());
  const renderer = {
    fleet: { attach() {}, setVisible() {}, restoreOrder() {} },
    models: { setVisible() {} },
  };
  let restored;
  const binding = createAircraftSceneBinding({
    id: 'flights',
    flightState: {
      initialized: true,
      _trackedIcao: 'a00000',
      _preloadModel: {},
    },
    services: { renderer: { create: () => renderer } },
    parts: {
      snapshots: { presentRecords() {} },
      tracking: {
        _trackFlight(id, options) {
          restored = { id, ...options };
          trackedEntityChanged.raiseEvent({
            gevSelectionOrigin: options.origin,
          });
        },
      },
    },
  });
  binding.attachRenderer({});
  assert.equal(restored.id, 'a00000');
  assert.equal(restored.resume, true);
  assert.equal(
    generation,
    1,
    'restored tracking cannot supersede and clear itself',
  );
  for (const origin of ['user', 'voice', 'programmatic']) {
    trackedEntityChanged.raiseEvent({ gevSelectionOrigin: origin });
  }
  assert.equal(generation, 4, 'new tracking still takes navigation authority');
});
