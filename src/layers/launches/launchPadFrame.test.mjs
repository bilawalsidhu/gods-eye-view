import test from 'node:test';
import assert from 'node:assert/strict';
import * as geo from '../../geo/index.js';
import { appClock } from '../../time/clock.js';
import { createLaunchPad } from './launchPad.js';
test('selected pad frame uses neutral geometry and the physical orbit epoch', () => {
  const launch = { id: 'qa', lon: -80.6, lat: 28.6 };
  let tick,
    created = 0,
    epoch;
  const state = {
    _viewer: {
      camera: {
        positionWC: geo.cartesian3.fromDegrees(launch.lon, launch.lat, 500),
        positionCartographic: { height: 500 },
      },
    },
    _enabled: true,
    _dataSource: { show: true },
    _selectedLaunchId: 'qa',
    _launches: [launch],
    _launchPadZoneRemover: null,
    _lastMissionRingRotationMs: 0,
    _missionRingDate: new Date(0),
    _launchPadZonePrimitive: null,
    _launchPadZoneLaunchId: null,
  };
  const renderer = {
    on: (event, fn) => {
      assert.equal(event, 'preRender');
      tick = fn;
      return () => {};
    },
    createPad: () => {
      created++;
      return { show: true };
    },
    removePrimitive: () => {},
  };
  const parts = {
    orbitRendering: {
      updateMissionOrbitPrimitiveFrames: (date) => {
        epoch = date.getTime();
      },
    },
    policyHelpers: {
      launchPadZoneVisible: ({ cameraDistanceM }) => cameraDistanceM < 1000,
    },
  };
  try {
    appClock.freeze(123000);
    createLaunchPad({
      state,
      services: {},
      parts,
      source: {},
      getRenderer: () => renderer,
    }).initLaunchPadZonePrimitive();
    tick();
    assert.equal(created, 1);
    assert.equal(state._launchPadZonePrimitive.show, true);
    assert.equal(epoch, 123000);
  } finally {
    appClock.reset();
  }
});
