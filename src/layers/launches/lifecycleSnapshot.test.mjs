import { createFakeEngine } from '../../globe/testing/fakeEngine.js';
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
      state: { _engine: createFakeEngine() },
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

test('missions begin their entry flight while the satellite catalog loads', async () => {
  let resolve;
  const pending = new Promise((done) => {
    resolve = done;
  });
  let flew = false;
  const lifecycle = createLifecycle({
    state: { _engine: createFakeEngine() },
    services: { render: {} },
    getRenderer: () => ({ setVisible() {} }),
    parts: {
      orbitRendering: { syncMissionOrbitPrimitiveVisibility() {} },
      selection: {
        focusFullGlobe() {
          flew = true;
        },
        setSelectedMission() {},
      },
      ingestion: { captureSatelliteDependency: () => pending },
    },
  });
  const enabling = lifecycle.methods._enableBody();
  assert.equal(flew, true);
  resolve();
  await enabling;
});

test('detaching retains the active replay heading before replacing its track', () => {
  const state = {
    _renderer: { destroy() {} },
    _replayCameraLaunchId: 'mission',
    _replayTracks: new Map([['mission', { lastCameraHeading: 1.2 }]]),
    _missionOverlayRecords: new Map(),
    _satelliteTelemetry: new Map(),
  };
  const noop = () => {};
  const lifecycle = createLifecycle({
    state,
    services: { render: {} },
    parts: {
      launchPad: { destroyLaunchPadZonePrimitive: noop },
      orbitRendering: { removeMissionOrbitPrimitives: noop },
      overlays: {
        clearMissionOverlaySources: noop,
        destroyReplayVehicleOverlay: noop,
      },
      rendering: { removeMissionElements: noop },
    },
  });
  lifecycle.methods.detachRenderer();
  assert.equal(state._replayTracks.size, 0);
  assert.equal(state._replayCameraHeading, 1.2);
});
