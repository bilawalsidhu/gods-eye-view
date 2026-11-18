import assert from 'node:assert/strict';
import test from 'node:test';
import { StyleManager } from './applicationShell.js';

test('an unavailable map stack reports the controller’s own reason, not always an ion token', async () => {
  const controller = {
    getStacks: () => [
      {
        id: 'photoreal',
        label: 'Google 3D',
        available: false,
        unavailableReason: 'Google 3D needs GOOGLE_MAPS_API_KEY',
      },
      { id: 'bing-aerial', label: 'Bing aerial', available: false },
    ],
    getActiveId: () => 'osm',
  };
  const shell = { mapStackController: controller };
  const photoreal = await StyleManager.prototype.setMapStack.call(
    shell,
    'photoreal',
  );
  assert.deepEqual(photoreal, {
    ok: false,
    error: 'Google 3D needs GOOGLE_MAPS_API_KEY',
    activeStack: 'osm',
  });
  const bing = await StyleManager.prototype.setMapStack.call(
    shell,
    'bing-aerial',
  );
  assert.equal(bing.error, 'Bing aerial requires a Cesium ion token');
});
