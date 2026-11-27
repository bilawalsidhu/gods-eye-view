import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { entityFollowTarget } from './followed.js';
import { bindFakeDraw } from '../testSupport/fakeDrawPort.mjs';
import cctvLayer, {
  _setCctvCoverageStateForTest,
  _setCctvOverlayHostForTest,
} from './cctv.js';

function viewerFor() {
  const viewer = {
    isDestroyed: () => false,
    camera: {
      positionWC: Cesium.Cartesian3.fromDegrees(-97.7431, 30.2672, 4_000),
      positionCartographic: Cesium.Cartographic.fromDegrees(
        -97.7431,
        30.2672,
        4_000,
      ),
      heading: 0.4,
      pitch: -0.7,
      roll: 0.1,
      transform: Cesium.Matrix4.clone(Cesium.Matrix4.IDENTITY),
      flyToBoundingSphere() {},
    },
    scene: {
      canvas: { clientWidth: 1200, clientHeight: 800 },
      cartesianToCanvasCoordinates: () => undefined,
      primitives: { add: (p) => p, remove: () => true },
      requestRender() {},
    },
  };
  viewer.draw = bindFakeDraw(viewer, {
    camera: {
      pose: () => undefined,
      on: () => () => {},
      followed: entityFollowTarget({ id: 'sibling-track-owner' }, {}),
      follow(target) {
        this.followed = target;
      },
    },
  }).draw;
  return viewer;
}
const record = (id, index) => ({
  camera: {
    lat: 30.2672,
    lon: -97.7431 + index * 0.002,
    headingDeg: 41,
    pitchDeg: -5,
    fovDeg: 56,
    rangeM: 210,
    mountHeightM: 100,
    id,
    name: `Camera ${id}`,
    city: 'Austin',
    groundElevationM: 0,
  },
  coverageEntities: [],
  projection: null,
  activationDone: true,
  groundResolved: {},
  groundSamples: {},
  groundPrior: 0,
  frustumGeometry: null,
  frustumPositions: null,
  probeClampRangeM: null,
});

function checkActivation(origin, openingCamera) {
  const records = [record('a', 0), record('b', 1)];
  _setCctvOverlayHostForTest({
    setEntries() {},
    setVisible() {},
    clearSource() {},
  });
  const originalDocument = globalThis.document;
  const originalImage = globalThis.Image;
  globalThis.document = { createElement: () => ({ getContext: () => null }) };
  globalThis.Image = class {};
  const seen = [];
  let unsubscribe = () => {};
  try {
    _setCctvCoverageStateForTest({
      viewer: viewerFor(),
      records,
      activeCameraId: 'a',
      enabled: true,
    });
    unsubscribe = cctvLayer.subscribe((state) =>
      seen.push([state.activeCameraId, state.openingCamera]),
    );
    cctvLayer.setParams({ selectedCameraId: 'b' }, { origin });
    const changes = seen.filter(([id]) => id === 'b');
    assert.ok(changes.length);
    for (const [, opening] of changes) assert.equal(opening, openingCamera);
  } finally {
    unsubscribe();
    globalThis.document = originalDocument;
    globalThis.Image = originalImage;
    _setCctvOverlayHostForTest();
    _setCctvCoverageStateForTest({ enabled: false });
  }
}

test('a scene shot activating selectedCameraId is quiet (opens no card)', () => {
  checkActivation('scene', true);
});

test('a user activating selectedCameraId publishes a pick', () => {
  checkActivation('user', false);
});
