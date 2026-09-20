import test from 'node:test';
import assert from 'node:assert/strict';
import { DroneReconController } from './droneRecon.js';

test('DroneReconController initializes and manages recon state', async () => {
  globalThis.Cesium = {
    Cartesian3: {
      fromDegrees: (lon, lat, alt) => ({ lon, lat, alt }),
    },
    Math: {
      toRadians: (deg) => (deg * Math.PI) / 180,
      toDegrees: (rad) => (rad * 180) / Math.PI,
    },
    HeadingPitchRange: function (h, p, r) { this.h = h; this.p = p; this.r = r; },
    Matrix4: { IDENTITY: [] },
  };

  let flyToCalled = false;
  let flyToOpts = null;
  const preUpdateListeners = new Set();

  const mockCamera = {
    flyTo: (opts) => {
      flyToCalled = true;
      flyToOpts = opts;
      opts.complete?.();
    },
    lookAt: () => {},
    lookAtTransform: () => {},
    positionCartographic: { longitude: 2.4, latitude: 0.6 },
  };

  const mockViewer = {
    camera: mockCamera,
    scene: {
      preUpdate: {
        addEventListener: (fn) => preUpdateListeners.add(fn),
        removeEventListener: (fn) => preUpdateListeners.delete(fn),
      },
    },
  };

  const messages = [];
  const mockAi = {
    appendMessage: (role, msg) => messages.push({ role, msg }),
    speak: () => {},
  };

  const cues = [];
  const controller = new DroneReconController({
    viewer: mockViewer,
    aiController: mockAi,
    playCue: (cue) => cues.push(cue),
  });

  assert.equal(controller.isActive(), false);

  // Start recon over Tokyo Tower
  const res = await controller.startRecon({
    targetName: 'Tokyo Tower',
    altitude: 800,
    narrate: true,
  });

  assert.equal(res.ok, true);
  assert.equal(controller.isActive(), true);
  assert.equal(cues.includes('recon'), true);
  assert.equal(flyToCalled, true);
  assert.equal(preUpdateListeners.size, 1);
  assert.ok(messages.length > 0);
  assert.ok(messages[0].msg.includes('Tokyo Tower'));

  // Stop recon
  controller.stop();
  assert.equal(controller.isActive(), false);
  assert.equal(preUpdateListeners.size, 0);
  assert.ok(messages[messages.length - 1].msg.includes('STANDDOWN'));
});
