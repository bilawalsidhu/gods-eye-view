// src/ui/cctvPickerOpening.test.mjs — picking a camera and the opening camera.
// The opening camera follows the view until someone picks one. Context's
// Cameras list shows it as a row of its own; a pick from that list, from
// Nearby or with the layer row's Prev/Next ends automatic selection, even a
// pick of the camera already shown, and leaving the list without a pick lets
// the camera follow the view.
import '../testSupport/registerDom.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { createPinia } from 'pinia';
import { createApp, h, nextTick, ref } from 'vue';
import cctvLayer, {
  _setCctvCoverageStateForTest,
  _setCctvOverlayHostForTest,
  reopenNearestCamera,
} from '../data/cctv.js';
import { bindFakeDraw } from '../testSupport/fakeDrawPort.mjs';
import CameraList from './views/panels/CameraList.vue';
import NearbyLists from './views/panels/NearbyLists.vue';
import { useEntityCardStore } from './stores/entityCard.js';
import { usePanelChromeStore } from './stores/panelChrome.js';
import { contextRadiusKm, setContextRadiusKm } from './contextRadius.js';

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
 * Cambridge Circus; Context, centred on the view, lists the cameras.
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
  const radius = contextRadiusKm.value;
  setContextRadiusKm(10);
  const layer = {
    id: 'cctv',
    name: 'Cameras',
    enabled: true,
    stats: { count: 2 },
    module: cctvLayer,
  };
  const pinia = createPinia();
  const store = useEntityCardStore(pinia);
  const chrome = usePanelChromeStore(pinia);
  const owner = chrome.connect({});
  chrome.publish(owner, 'global-context-panel', { collapsed: false });
  const manager = {
    layers: new Map([['cctv', layer]]),
    isEnabled: (id) => id === 'cctv',
    getAll: () => [layer],
    subscribe: () => () => {},
  };
  store.connect({
    dataManager: () => manager,
    flyTo() {},
    canFollow: () => false,
  });
  const host = document.body.appendChild(document.createElement('div'));
  const listShown = ref(true);
  const app = createApp({
    render: () =>
      h(CameraList, {
        shown: listShown.value,
      }),
  }).use(pinia);
  store.setViewContextShown(true, 1);
  app.mount(host);
  let nearby = null;
  t.after(() => {
    nearby?.unmount();
    app.unmount();
    store.setViewContextShown(false, null);
    store.connect(null);
    chrome.detach(owner);
    setContextRadiusKm(radius);
    globalThis.Image = originalImage;
    globalThis.fetch = originalFetch;
    AbortSignal.timeout = originalTimeout;
    _setCctvOverlayHostForTest();
    _setCctvCoverageStateForTest({ enabled: false });
  });

  assert.equal(settleOver(viewer, CAMBRIDGE), true);
  // Context follows the centre of the view.
  store.setView({
    center: { lat: CAMBRIDGE[0], lon: CAMBRIDGE[1] },
    heightM: viewer.eye.height,
  });
  await nextTick();
  // The small camera catalog is indexed on the next timer turn.
  await new Promise((resolve) => setTimeout(resolve, 0));
  await nextTick();
  assert.equal(cctvLayer.getUIState().activeCameraId, 'b-cambridge');
  assert.equal(cctvLayer.getUIState().openingCamera, true);

  /** Nearby's lists around the view centre, mounted beside the list. */
  function mountNearby() {
    const lists = store.nearbyLayers(CAMBRIDGE[0], CAMBRIDGE[1], {
      radiusKm: contextRadiusKm.value,
      limit: 3,
    });
    const at = document.body.appendChild(document.createElement('div'));
    nearby = createApp({ render: () => h(NearbyLists, { lists }) }).use(pinia);
    nearby.mount(at);
    return at;
  }
  return { viewer, store, mountNearby, listShown };
}

const cameraList = '[data-list-card="cctv"]';
const rowNames = (root = document) =>
  [...root.querySelectorAll(`${cameraList} li .nearby-lists__name`)].map(
    (el) => el.textContent,
  );

test('the opening camera appears in the loaded camera catalog', async (t) => {
  await reopenedAtCambridge(t);
  assert.deepEqual(rowNames(), ['Camera a-trafalgar', 'Camera b-cambridge']);
});

test('picking the shown camera from the Cameras list keeps it after a pan', async (t) => {
  const { viewer, store } = await reopenedAtCambridge(t);
  await nextTick();
  const row = document.querySelector(
    `${cameraList} [data-list-key="b-cambridge"]`,
  );
  assert.ok(row, 'the currently active camera is in the catalog');
  row.click();
  await nextTick();
  assert.equal(store.card?.key, 'cctv:b-cambridge');
  assert.equal(cctvLayer.getUIState().openingCamera, false);

  assert.equal(settleOver(viewer, TRAFALGAR), false);
  assert.equal(cctvLayer.getUIState().activeCameraId, 'b-cambridge');
});

test("picking the shown camera from Nearby's Cameras group keeps it after a pan", async (t) => {
  const { viewer, store, mountNearby } = await reopenedAtCambridge(t);
  const nearby = mountNearby();
  const row = [...nearby.querySelectorAll('li button')].find((button) =>
    button.textContent.includes('Camera b-cambridge'),
  );
  assert.ok(row, "Nearby's Cameras group lists the shown camera");
  row.click();
  await nextTick();
  assert.equal(store.card?.key, 'cctv:b-cambridge');

  assert.equal(settleOver(viewer, TRAFALGAR), false);
  assert.equal(cctvLayer.getUIState().activeCameraId, 'b-cambridge');
});

test("stepping with the layer row's Prev/Next is a pick: a later pan keeps the camera", async (t) => {
  const { viewer } = await reopenedAtCambridge(t);
  const chip = (id) =>
    cctvLayer.getRowControls().chips.find((c) => c.id === id);
  chip('next-camera').onClick();
  assert.equal(cctvLayer.getUIState().activeCameraId, 'a-trafalgar');
  chip('previous-camera').onClick();
  assert.equal(cctvLayer.getUIState().activeCameraId, 'b-cambridge');
  assert.equal(cctvLayer.getUIState().openingCamera, false);

  assert.equal(settleOver(viewer, TRAFALGAR), false);
  assert.equal(cctvLayer.getUIState().activeCameraId, 'b-cambridge');
});

test('leaving the Cameras list without a pick lets the camera follow a pan', async (t) => {
  const { viewer, store, listShown } = await reopenedAtCambridge(t);
  await nextTick();
  listShown.value = false;
  await nextTick();
  assert.equal(store.card, null, 'no camera was opened');

  assert.equal(settleOver(viewer, TRAFALGAR), true);
  await nextTick();
  assert.equal(cctvLayer.getUIState().activeCameraId, 'a-trafalgar');
  assert.equal(cctvLayer.getUIState().openingCamera, true);
});
