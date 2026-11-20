// An explicit pick of the camera that a settled move just re-opened must end
// the opening pick. That pick goes through setActiveCamera's UNCHANGED path
// (same camera, already activated); if that path keeps the provisional flag,
// the next settled move (a pan, or the landing of NEAREST's own flight)
// switches the camera away from the one the user chose.
import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';
import cctvLayer, {
  _setCctvCoverageStateForTest,
  _setCctvOverlayHostForTest,
  reopenNearestCamera,
} from './cctv.js';
import { bindFakeDraw } from '../testSupport/fakeDrawPort.mjs';

const BASE = {
  headingDeg: 41,
  pitchDeg: -5,
  fovDeg: 56,
  rangeM: 210,
  mountHeightM: 100,
  groundElevationM: 0,
  city: 'London',
};

function record(id, lat, lon) {
  return {
    camera: { ...BASE, id, name: `Camera ${id}`, lat, lon },
    coverageEntities: [],
    projection: null,
    activationDone: true,
    groundResolved: {},
    groundSamples: {},
    groundPrior: 0,
    frustumGeometry: null,
    frustumPositions: null,
    probeClampRangeM: null,
    position: Cesium.Cartesian3.fromDegrees(lon, lat, 100),
  };
}

function viewerAt(lat, lon) {
  const viewer = {
    isDestroyed: () => false,
    eye: { lat, lon, height: 300 },
    scene: {
      canvas: { clientWidth: 1200, clientHeight: 800 },
      cartesianToCanvasCoordinates: () => undefined,
      primitives: { add: (p) => p, remove: () => true },
      requestRender() {},
    },
  };
  // The layer reads the eye and flies through the renderer's camera port.
  viewer.draw = bindFakeDraw(viewer, {
    camera: {
      pose: () => ({ ...viewer.eye }),
      on: () => () => {},
      followed: null,
      flyToBounds() {},
    },
  }).draw;
  return viewer;
}

function moveViewer(viewer, lat, lon) {
  viewer.eye = { lat, lon, height: 300 };
}

function withReopenedLayer(fn) {
  _setCctvOverlayHostForTest({
    setEntries() {},
    setVisible() {},
    clearSource() {},
  });
  // Activation builds the projection canvas and frame image.
  const originalDocument = globalThis.document;
  const originalImage = globalThis.Image;
  globalThis.document = { createElement: () => ({ getContext: () => null }) };
  globalThis.Image = class {};
  try {
    const trafalgar = record('a-trafalgar', 51.508, -0.128);
    const cambridge = record('b-cambridge', 51.513, -0.129);
    // enable() assigned the opening camera without activating it.
    trafalgar.activationDone = false;
    const viewer = viewerAt(51.5081, -0.1281);
    _setCctvCoverageStateForTest({
      viewer,
      records: [trafalgar, cambridge],
      activeCameraId: 'a-trafalgar',
      enabled: true,
      openingCameraProvisional: true,
    });
    // A settled move next to Cambridge Circus re-opens there, still as the
    // opening pick.
    moveViewer(viewer, 51.5131, -0.1291);
    assert.equal(reopenNearestCamera(), true);
    assert.equal(cctvLayer.getUIState().activeCameraId, 'b-cambridge');
    fn(viewer);
  } finally {
    globalThis.document = originalDocument;
    globalThis.Image = originalImage;
    _setCctvOverlayHostForTest();
    _setCctvCoverageStateForTest({ enabled: false });
  }
}

for (const [name, pick] of [
  ['NEAREST (focusNearest)', () => cctvLayer.focusNearest({ focus: false })],
  ['selectCamera', () => cctvLayer.selectCamera('b-cambridge')],
  [
    'setParams({ selectedCameraId })',
    () => cctvLayer.setParams({ selectedCameraId: 'b-cambridge' }),
  ],
  [
    'focusNearestToPoint',
    () => cctvLayer.focusNearestToPoint(51.513, -0.129, { focus: false }),
  ],
]) {
  test(`an explicit ${name} pick of the re-opened camera ends the opening pick`, () => {
    withReopenedLayer((viewer) => {
      pick();
      assert.equal(cctvLayer.getUIState().activeCameraId, 'b-cambridge');
      // A later settled move (a pan, or the landing of the pick's own flight)
      // leaves the explicit choice alone.
      moveViewer(viewer, 51.5081, -0.1281);
      assert.equal(reopenNearestCamera(), false);
      assert.equal(cctvLayer.getUIState().activeCameraId, 'b-cambridge');
    });
  });
}

test('without a pick, the next settled move still follows the view', () => {
  withReopenedLayer((viewer) => {
    moveViewer(viewer, 51.5081, -0.1281);
    assert.equal(reopenNearestCamera(), true);
    assert.equal(cctvLayer.getUIState().activeCameraId, 'a-trafalgar');
  });
});
