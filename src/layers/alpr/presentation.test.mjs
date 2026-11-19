import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { fakeInput, fakeInputUnderLabel } from '../../input/testDoubles.mjs';
import { setClickCardHitTest } from '../../data/pickRegistry.js';
import { fakeDrawPort } from '../../testSupport/fakeDrawPort.mjs';
import { bindFakeCesiumScene } from '../../testSupport/fakeCesiumScene.mjs';
import { createAlprMarkerSet } from './markerState.js';
import { createAlprPresentation } from './presentation.js';

/** One camera drawn and painted at (100, 100), over a viewer whose clicks a
 *  label may take. */
function harness(t) {
  const previousImage = globalThis.Image;
  const project = Cesium.SceneTransforms.worldToWindowCoordinates;
  globalThis.Image = class {
    complete = true;
    naturalWidth = 128;
  };
  Cesium.SceneTransforms.worldToWindowCoordinates = () => ({ x: 100, y: 100 });
  const record = {
    id: 'camera:0',
    latitude: 30,
    longitude: -97,
    directionDeg: 90,
  };
  const drawPort = fakeDrawPort();
  const markers = createAlprMarkerSet();
  markers.attach(drawPort.icons({ id: 'alpr-cameras:test:markers' }));
  const viewer = {
    camera: {
      positionWC: Cesium.Cartesian3.fromDegrees(-97, 30, 500),
      pickEllipsoid: () => Cesium.Cartesian3.fromDegrees(-97, 30),
    },
    scene: {
      canvas: { clientWidth: 800, clientHeight: 600 },
      globe: { show: true, getHeight: () => 150 },
      pick: () => null,
    },
  };
  const { unbind } = bindFakeCesiumScene(viewer, { draw: drawPort });
  const fake = fakeInputUnderLabel(viewer);
  const state = {
    viewer,
    enabled: true,
    selectedId: null,
    markers,
    records: [record],
    recordById: new Map([[record.id, record]]),
    renderRevision: 0,
    lastAnchorSampleAt: 0,
  };
  let selected = null;
  let paint;
  const presentation = createAlprPresentation({
    state,
    source: { label: 'Test cameras' },
    services: {
      render: { governorRequestRender() {} },
      context: {
        clearSelectedEntityContextForLayer() {
          selected = null;
        },
        getSelectedEntityContext: () => selected,
        registerEntityContext() {},
        removeEntityContextsForLayer() {},
        selectEntityContext(carrier) {
          selected = { id: carrier.id, layerId: 'alpr-cameras' };
        },
      },
      groundFloor: { cachedGroundFloor: () => 150 },
      overlays: {
        registerPaintLane(_lane, painter) {
          paint = painter;
          return { setActive() {}, requestPaint() {}, unregister() {} };
        },
        keyholeAlpha: () => 1,
      },
    },
  });
  presentation.initOverlay();
  presentation.installInteraction(viewer);
  t.after(() => {
    presentation.destroyOverlay();
    fake.destroy();
    unbind();
    if (previousImage === undefined) delete globalThis.Image;
    else globalThis.Image = previousImage;
    Cesium.SceneTransforms.worldToWindowCoordinates = project;
  });
  presentation.renderRecords();
  const ctx = {
    globalAlpha: 1,
    save() {},
    restore() {},
    beginPath() {},
    moveTo() {},
    lineTo() {},
    closePath() {},
    stroke() {},
    fill() {},
    createLinearGradient: () => ({ addColorStop() {} }),
    drawImage() {},
  };
  paint({ ctx, width: 800, height: 600 });
  return { state, fake, at: { x: 100, y: 100 } };
}

test('a click on a mission label over a camera never selects it, and keeps the selected camera', (t) => {
  const h = harness(t);
  h.fake.label.over = true;
  h.fake.click(h.at);
  assert.equal(h.state.selectedId, null, 'the camera under the label');

  // Off the label, the same click selects the camera.
  h.fake.label.over = false;
  h.fake.click(h.at);
  assert.equal(h.state.selectedId, 'camera:0');

  // The label on top is its own click: the selection stays.
  h.fake.label.over = true;
  h.fake.click(h.at);
  assert.equal(h.state.selectedId, 'camera:0', 'the selection stays');
});

// The card or label painted on top takes the click: ALPR does not even pick
// under another layer's card, so no camera is selected or released there.
test("another layer's card over an ALPR camera keeps the click", (t) => {
  let picks = 0;
  const viewer = {
    scene: {
      canvas: new EventTarget(),
      pick: () => {
        picks++;
        return null;
      },
    },
  };
  const input = fakeInput(viewer);
  const noop = () => {};
  const state = {
    enabled: true,
    viewer,
    clickSubscription: null,
    markers: { icons: null },
    recordById: new Map(),
    selectedId: null,
  };
  const presentation = createAlprPresentation({
    state,
    services: {
      render: { governorRequestRender: noop },
      context: {
        clearSelectedEntityContextForLayer: noop,
        getSelectedEntityContext: () => null,
        registerEntityContext: noop,
        removeEntityContextsForLayer: noop,
        selectEntityContext: noop,
      },
      groundFloor: { cachedGroundFloor: () => null },
    },
  });
  presentation.installInteraction(viewer);
  let top = { sourceId: 'earthquake-card', entryId: 'earthquake-card:ak1' };
  setClickCardHitTest(() => top);
  t.after(() => {
    setClickCardHitTest(null);
    state.clickSubscription?.();
    input.destroy();
  });
  input.tap({ x: 10, y: 10 });
  assert.equal(picks, 0, 'covered: the scene under the card is not picked');
  top = null;
  input.tap({ x: 10, y: 10 });
  assert.ok(picks > 0, 'open map: the click reaches the scene');
});
