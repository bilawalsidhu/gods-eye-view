import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';
import { createPolicyHelpers } from './policyHelpers.js';
import { createSelection } from './selection.js';
import { bindFakeCesiumCamera } from '../../testSupport/fakeCameraPort.mjs';

const PAD = { id: 'pad-39a', lon: -80.604, lat: 28.608 };

/** A launches layer's state on a viewer whose flights are kept. */
function rig() {
  const spheres = [];
  const viewer = bindFakeCesiumCamera({
    camera: {
      heading: 0,
      // A site focus first lets go of a mission's zoom anchor.
      lookAtTransform: () => {},
      flyToBoundingSphere: (sphere) => spheres.push(sphere),
    },
  });
  const state = { _viewer: viewer, _enabled: true, _selectedLaunchId: null };
  const parts = {
    replay: { stopMissionReplay: () => {} },
    rendering: { selectLaunchEntity: () => {} },
    panel: { missionHoverPreviewRange: () => 250_000 },
  };
  return {
    spheres,
    selection: createSelection({
      state,
      services: { geometry: {} },
      parts,
      source: {},
    }),
    policy: createPolicyHelpers({ state, services: {}, parts, source: {} }),
  };
}

/** The flight's centre, in degrees and metres. */
function centreOf(sphere) {
  const c = Cesium.Cartographic.fromCartesian(sphere.center);
  return {
    lon: Cesium.Math.toDegrees(c.longitude),
    lat: Cesium.Math.toDegrees(c.latitude),
    height: c.height,
  };
}

for (const [name, fly] of [
  ['a launch site focus', (r) => r.selection.focusLaunchSite(PAD)],
  ['a roster preview', (r) => r.policy.previewMissionFromRoster(PAD)],
])
  test(`${name} flies to the pad at sea level`, () => {
    const r = rig();
    fly(r);
    assert.equal(r.spheres.length, 1);
    const centre = centreOf(r.spheres[0]);
    assert.ok(Math.abs(centre.lon - PAD.lon) < 1e-9, `lon ${centre.lon}`);
    assert.ok(Math.abs(centre.lat - PAD.lat) < 1e-9, `lat ${centre.lat}`);
    assert.ok(Math.abs(centre.height) < 1e-6, `height ${centre.height}`);
  });
