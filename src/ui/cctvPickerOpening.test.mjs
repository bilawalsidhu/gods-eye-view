// src/ui/cctvPickerOpening.test.mjs — the picker and the opening camera.
// The opening camera follows the view until someone picks one. The picker
// shows it as its own option; a native select fires no change for the
// option it already shows, so FOCUS keeps that camera, and leaving the list
// without a choice lets it follow the view.
import '../testSupport/registerDom.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { createPinia } from 'pinia';
import { createApp, nextTick } from 'vue';
import cctvLayer, {
  _setCctvCoverageStateForTest,
  _setCctvOverlayHostForTest,
  reopenNearestCamera,
} from '../data/cctv.js';
import { bindFakeDraw } from '../testSupport/fakeDrawPort.mjs';
import { CctvControls } from './cctvControls.js';
import { useCctvStore } from './stores/cctv.js';
import CctvPanel from './views/panels/CctvPanel.vue';

const TRAFALGAR = [51.508, -0.128];
const CAMBRIDGE = [51.513, -0.129];

function record(id, [lat, lon]) {
  return {
    camera: {
      id,
      name: `Camera ${id}`,
      city: 'London',
      lat,
      lon,
      headingDeg: 41,
      pitchDeg: -5,
      fovDeg: 56,
      rangeM: 210,
      mountHeightM: 100,
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
    position: Cesium.Cartesian3.fromDegrees(lon, lat, 100),
  };
}

function viewerAt([lat, lon]) {
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

/** A settled move: the view is now over `[lat, lon]`. */
function settleOver(viewer, [lat, lon]) {
  viewer.eye = { lat, lon, height: 300 };
  return reopenNearestCamera();
}

/**
 * CCTV opened at Trafalgar Square, then a settled move re-opened it at
 * Cambridge Circus; the panel is connected to the layer.
 */
async function reopenedAtCambridge(t) {
  _setCctvOverlayHostForTest({
    setEntries() {},
    setVisible() {},
    clearSource() {},
  });
  // Activation builds the frame image and asks for ground heights; this test
  // has no server. happy-dom's request timeout would hold the run open 30 s.
  const originalImage = globalThis.Image;
  const originalFetch = globalThis.fetch;
  const originalTimeout = AbortSignal.timeout;
  globalThis.Image = class {};
  globalThis.fetch = async () => {
    throw new TypeError('no server in this test');
  };
  AbortSignal.timeout = () => new AbortController().signal;
  const trafalgar = record('a-trafalgar', TRAFALGAR);
  const cambridge = record('b-cambridge', CAMBRIDGE);
  // enable() assigned the opening camera without activating it.
  trafalgar.activationDone = false;
  const viewer = viewerAt(TRAFALGAR);
  _setCctvCoverageStateForTest({
    viewer,
    records: [trafalgar, cambridge],
    activeCameraId: 'a-trafalgar',
    enabled: true,
    openingCameraProvisional: true,
  });

  document.body.replaceChildren();
  const host = document.body.appendChild(document.createElement('div'));
  const pinia = createPinia();
  const app = createApp(CctvPanel).use(pinia);
  app.mount(host);
  const select = document.getElementById('cctv-camera-select');
  const controls = new CctvControls({
    elements: {
      _cctvPanel: document.getElementById('cctv-panel'),
      _cctvSelect: select,
      _cctvFocusBtn: document.getElementById('cctv-focus-btn'),
    },
    cctv: cctvLayer,
    actions: {
      isEnabled: () => true,
      toggleEnabled: async () => true,
      runExplicitFocus(select, focus) {
        const cameraId = select();
        if (cameraId) focus(cameraId);
      },
      setParams: (params) => cctvLayer.setParams(params),
      setPanelCollapsed() {},
      syncViewport() {},
    },
    store: useCctvStore(pinia),
  });
  controls.connect();
  t.after(() => {
    controls.destroy();
    app.unmount();
    globalThis.Image = originalImage;
    globalThis.fetch = originalFetch;
    AbortSignal.timeout = originalTimeout;
    _setCctvOverlayHostForTest();
    _setCctvCoverageStateForTest({ enabled: false });
  });

  assert.equal(settleOver(viewer, CAMBRIDGE), true);
  await nextTick();
  assert.equal(cctvLayer.getUIState().activeCameraId, 'b-cambridge');
  return { viewer, select };
}

test('the opening camera shows as its own option', async (t) => {
  const { select } = await reopenedAtCambridge(t);
  assert.equal(select.value, 'b-cambridge');
  const shown = select.options[select.selectedIndex];
  assert.equal(shown.hidden, false);
  assert.equal(shown.disabled, false);
  assert.equal(
    [...select.options].filter((option) => option.value === 'b-cambridge')
      .length,
    1,
    'the list shows the camera once',
  );
  assert.ok([...select.options].every((option) => !option.hidden));
});

test('FOCUS on the shown camera keeps it after a pan', async (t) => {
  const { viewer, select } = await reopenedAtCambridge(t);
  const focus = document.getElementById('cctv-focus-btn');
  assert.equal(focus.disabled, false);
  focus.click();
  // The click handler waits for the layer switch before it picks.
  await new Promise((resolve) => setTimeout(resolve, 0));
  await nextTick();

  assert.equal(settleOver(viewer, TRAFALGAR), false);
  assert.equal(cctvLayer.getUIState().activeCameraId, 'b-cambridge');
  assert.equal(select.value, 'b-cambridge');
});

test('leaving the picker without a pick lets the camera follow a pan', async (t) => {
  const { viewer, select } = await reopenedAtCambridge(t);
  select.focus();
  select.blur();
  await nextTick();

  assert.equal(settleOver(viewer, TRAFALGAR), true);
  await nextTick();
  assert.equal(cctvLayer.getUIState().activeCameraId, 'a-trafalgar');
  assert.equal(select.value, 'a-trafalgar');
});
