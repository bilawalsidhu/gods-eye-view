import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';
import { createFirmsHeatmapLayer } from '../../data/firmsHeatmap.js';
import { fakeInput } from '../../input/testDoubles.mjs';
import { bindRenderer } from '../../render/rendererOf.js';
import { bindFakeCesiumScene } from '../../testSupport/fakeCesiumScene.mjs';
import { fakeGlobePort } from '../../testSupport/fakeGlobePort.mjs';
// Ports built over a viewer of the test's own, with no renderer bound: the
// adapter's factories load as `./render/cesium/unbound` loads them.
import '../../render/cesium/unbound.js';

const raw = (lat, lon, frp) => ({
  lat,
  lon,
  frp,
  confidence: 'h',
  brightness: 340,
  daynight: 'D',
  acqDate: '2026-08-03',
  acqTime: '0412',
  instrument: 'VIIRS',
  satellite: 'N20',
});

/** Enough canvas for the glow sprites and the heat raster. */
const canvasStub = () => ({
  width: 0,
  height: 0,
  getContext: () => ({
    createRadialGradient: () => ({ addColorStop() {} }),
    fillRect() {},
    createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
    putImageData() {},
  }),
  toDataURL: () => 'data:image/png;base64,iVBORw0KGgo=',
});

function harness(fires, heightM, { sceneFromViewer = false } = {}) {
  const saved = {
    window: globalThis.window,
    document: globalThis.document,
    project: Cesium.SceneTransforms.worldToWindowCoordinates,
  };
  globalThis.window = new EventTarget();
  globalThis.document = { createElement: canvasStub };
  // Headless: every position projects to the canvas middle.
  Cesium.SceneTransforms.worldToWindowCoordinates = () => ({ x: 400, y: 300 });
  const primitives = [];
  const viewer = {
    camera: {
      moveEnd: new Cesium.Event(),
      positionWC: Cesium.Cartesian3.fromDegrees(-97.7, 30.2, heightM),
      directionWC: new Cesium.Cartesian3(0, 0, -1),
      positionCartographic: Cesium.Cartographic.fromDegrees(
        -97.7,
        30.2,
        heightM,
      ),
    },
    get canvas() {
      return this.scene?.canvas;
    },
    scene: {
      canvas: { clientWidth: 800, clientHeight: 600 },
      preRender: new Cesium.Event(),
      primitives: {
        add: (value) => (primitives.push(value), value),
        remove: (value) => {
          const at = primitives.indexOf(value);
          if (at >= 0) primitives.splice(at, 1);
          value.destroy?.();
          return at >= 0;
        },
        contains: () => false,
      },
    },
  };
  let ports = bindFakeCesiumScene(viewer);
  const { draw } = ports;
  // The heatmap drapes through the globe port.
  const globe = fakeGlobePort();
  {
    const { unbind, ...bound } = ports;
    unbind();
    ports = { ...bound, unbind: bindRenderer(viewer, { ...bound, globe }) };
  }
  // A renderer with no query or frame: the Cesium adapter builds them over
  // the viewer's scene, as it does for a viewer with no renderer.
  if (sceneFromViewer) {
    ports.unbind();
    bindRenderer(viewer, { draw, camera: ports.camera, globe });
    Object.assign(viewer.scene, {
      preUpdate: new Cesium.Event(),
      postRender: new Cesium.Event(),
      requestRender() {},
      forceRender() {},
      pick: () => undefined,
      drillPick: () => [],
      camera: viewer.camera,
    });
    viewer.camera.pickEllipsoid = () => undefined;
    viewer.clock = { currentTime: Cesium.JulianDate.now() };
  }
  const input = fakeInput(viewer);
  const layer = createFirmsHeatmapLayer({
    id: 'firms',
    name: 'FIRMS',
    feed: { getSnapshot: async () => ({ fires, fetchedAt: Date.now() }) },
    overlayHost: { setEntries() {}, setVisible() {}, clearSource() {} },
  });
  const cells = () =>
    [...draw.sets.values()].find(
      (record) => !record.disposed && record.spec.id.endsWith(':cells'),
    );
  const icons = () =>
    [...draw.sets.values()].find(
      (record) => !record.disposed && record.spec.id.endsWith(':icons'),
    );
  return {
    layer,
    viewer,
    cells,
    icons,
    globe,
    cleanup() {
      layer.destroy(viewer);
      input.destroy();
      Cesium.SceneTransforms.worldToWindowCoordinates = saved.project;
      for (const key of ['window', 'document'])
        if (saved[key] === undefined) delete globalThis[key];
        else globalThis[key] = saved[key];
    },
  };
}

/** Put the camera at `heightM` and run a frame past the LOD check's throttle. */
function moveTo(h, heightM) {
  h.viewer.camera.positionCartographic = Cesium.Cartographic.fromDegrees(
    -97.7,
    30.2,
    heightM,
  );
  h.viewer.camera.positionWC = Cesium.Cartesian3.fromDegrees(
    -97.7,
    30.2,
    heightM,
  );
  const now = performance.now;
  performance.now = () => now.call(performance) + 10_000;
  try {
    h.viewer.scene.preRender.raiseEvent();
  } finally {
    performance.now = now;
  }
}

test('far out, one heatmap is draped through the globe port and the markers under it are hidden', async () => {
  const h = harness(
    [raw(30.5, -98.2, 1500), raw(30.6, -98.3, 20), raw(-12.1, 131.4, 5)],
    12_000_000,
  );
  try {
    h.layer.init(h.viewer);
    await h.layer.enable(h.viewer);
    assert.equal(h.cells().items.size, 0, 'no heat rectangles any more');
    const [heat] = h.globe.imagery.list();
    assert.equal(h.globe.imagery.list().length, 1);
    assert.equal(heat.spec.kind, 'single-image');
    assert.deepEqual(heat.spec.rectangle, {
      west: -180,
      south: -90,
      east: 180,
      north: 90,
    });
    assert.equal(heat.show, true);
    assert.equal(heat.alpha, 1, 'past the hand-off: all heat');
    // The nearest band's markers stay built for the hand-off, hidden.
    assert.equal(h.icons().items.size, 3);
    assert.equal(h.icons().show, false);

    h.layer.disable();
    assert.equal(heat.show, false, 'hidden with the layer');
    h.layer.destroy(h.viewer);
    assert.equal(h.globe.imagery.list().length, 0, 'destroy takes it down');
    assert.equal(h.icons(), undefined);
  } finally {
    h.cleanup();
  }
});

for (const sceneFromViewer of [false, true]) {
  const title = sceneFromViewer
    ? "with no query or frame port, the layer still follows the camera through ports built over the viewer's scene"
    : 'zooming in cross-fades the heatmap out and the markers in';
  test(title, async () => {
    const h = harness([raw(30.5, -98.2, 1500)], 12_000_000, {
      sceneFromViewer,
    });
    try {
      h.layer.init(h.viewer);
      await h.layer.enable(h.viewer);
      const [heat] = h.globe.imagery.list();
      assert.equal(heat.alpha, 1);
      assert.equal(h.icons().show, false);
      // Half way through the hand-off (3,600 to 5,400 km): both show.
      moveTo(h, 4_500_000);
      assert.equal(heat.alpha, 0.5);
      assert.equal(h.icons().show, true);
      assert.equal([...h.icons().items.values()][0].alpha, 0.5);
      // Close in: markers alone; the heatmap stays mapped at alpha 0.
      moveTo(h, 500_000);
      assert.equal(heat.alpha, 0);
      assert.equal(heat.show, true);
      assert.equal(h.icons().show, true);
      assert.equal([...h.icons().items.values()][0].alpha, 1);
    } finally {
      h.cleanup();
    }
  });
}
