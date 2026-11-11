import { createFakeEngine } from '../../globe/testing/fakeEngine.js';
// CCTV icon thinning must use the camera's real vertical FOV. In a 16:9
// window with Cesium's default fov 60deg the vertical FOV is about 36deg;
// main read it from viewer.camera.frustum.fovy. Two cameras 17 m apart seen
// from 2 km: with fovy 36deg the cell is ~48 m (< VIEW_MIN_CELL_M, both shown),
// with the hard-coded pi/3 fallback it is ~86 m and one camera is hidden.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRendering } from './rendering.js';
import { isVideoFeedType } from '../../sources/cctvTypes.js';

const FOVY_16_9 = 2 * Math.atan(Math.tan(Math.PI / 6) / (16 / 9));

test('icon thinning uses the camera vertical FOV, not a pi/3 fallback', () => {
  const record = (id, lat, x) => ({
    camera: { id, lat, lon: 0, feedType: 'image' },
    billboard: { show: true, position: { x, y: 0, z: 0 } },
  });
  const a = record('cam-a', 10.0005, 0);
  const b = record('cam-b', 10.00065, 17);
  const pose = { fovy: FOVY_16_9 };
  const state = {
    _enabled: true,
    _records: [a, b],
    _viewRecords: [],
    _healthById: new Map(),
    _activeCameraId: null,
  };
  const renderer = {
    ready: true,
    viewport: () => ({ width: 1920, height: 1080 }),
    horizonTest: () => () => true,
    project: () => ({ x: 960, y: 540 }),
    distance: () => 2000,
    cameraPose: () => pose,
    fovy: () => pose.fovy,
    engine: createFakeEngine({ fovy: FOVY_16_9 }),
  };
  const { refreshHorizonCulling } = createRendering({
    state,
    services: {
      focus: {
        focusNowMs: (n) => n,
        getFocusTarget: () => null,
        focusPassIsNeeded: () => false,
        advanceSpriteFocus: () => ({ factor: 1 }),
        focusAlphaNeedsWrite: () => false,
      },
    },
    parts: { renderer, model: { isVideoFeedType } },
    source: {},
  });
  refreshHorizonCulling();
  assert.equal(a.billboard.show, true, 'cam-a shown');
  assert.equal(b.billboard.show, true, 'cam-b shown');
  assert.equal(state._viewRecords.length, 2);
});
