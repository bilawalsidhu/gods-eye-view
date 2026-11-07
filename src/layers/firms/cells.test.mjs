import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';
import { createFirmsHeatmapLayer } from '../../data/firmsHeatmap.js';
import { unregisterSpriteCollection } from '../../data/spriteOrder.js';
import { fakeInput } from '../../input/testDoubles.mjs';
import { bindRenderer } from '../../render/rendererOf.js';
import { bindFakeCesiumScene } from '../../testSupport/fakeCesiumScene.mjs';

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

/** Enough canvas for the glow sprites. */
const canvasStub = () => ({
  width: 0,
  height: 0,
  getContext: () => ({
    createRadialGradient: () => ({ addColorStop() {} }),
    fillRect() {},
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
  const ports = bindFakeCesiumScene(viewer);
  const { draw } = ports;
  // A renderer with no query or frame: the layer reads the viewer's scene.
  if (sceneFromViewer) {
    ports.unbind();
    bindRenderer(viewer, { draw, camera: ports.camera });
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
  return {
    layer,
    viewer,
    cells,
    cleanup() {
      layer.destroy(viewer);
      unregisterSpriteCollection('firms');
      input.destroy();
      Cesium.SceneTransforms.worldToWindowCoordinates = saved.project;
      for (const key of ['window', 'document'])
        if (saved[key] === undefined) delete globalThis[key];
        else globalThis[key] = saved[key];
    },
  };
}

test('far out, the heat cells are clamped rectangles in one draw set, shown with the layer', async () => {
  const h = harness(
    [raw(30.5, -98.2, 1500), raw(30.6, -98.3, 20), raw(-12.1, 131.4, 5)],
    12_000_000,
  );
  try {
    h.layer.init(h.viewer);
    assert.equal(h.cells().show, false, 'hidden until enabled');
    await h.layer.enable(h.viewer);
    const cells = h.cells();
    assert.equal(cells.show, true);
    assert.equal(cells.spec.clampTo, 'both');
    const items = [...cells.items.values()];
    // Global band: 2° cells; the two Texas fires share one.
    assert.equal(items.length, 2);
    const texas = items.find((item) => item.geometry.rect.west === -100);
    assert.deepEqual(texas.geometry, {
      kind: 'rectangle',
      rect: { west: -100, south: 30, east: -98, north: 32 },
    });
    assert.equal(texas.height, 'clampGround');
    // The hottest cell: red at the top of the alpha ramp.
    assert.deepEqual(texas.fill, [1, 0, 0, 0.66]);
    const other = items.find((item) => item !== texas);
    assert.equal(other.fill.length, 4);
    assert.ok(other.fill[3] >= 0.16 && other.fill[3] < 0.66);

    h.layer.disable();
    assert.equal(h.cells().show, false, 'hidden with the layer');
    h.layer.destroy(h.viewer);
    assert.equal(h.cells(), undefined, 'destroy disposes the set');
  } finally {
    h.cleanup();
  }
});

test('close in, detections replace the cells', async () => {
  const h = harness([raw(30.5, -98.2, 1500)], 12_000_000);
  try {
    h.layer.init(h.viewer);
    await h.layer.enable(h.viewer);
    assert.equal(h.cells().items.size, 1);
    h.viewer.camera.positionCartographic = Cesium.Cartographic.fromDegrees(
      -97.7,
      30.2,
      500_000,
    );
    h.viewer.camera.positionWC = Cesium.Cartesian3.fromDegrees(
      -97.7,
      30.2,
      500_000,
    );
    // A frame past the LOD check's throttle, however fast the start was.
    const now = performance.now;
    performance.now = () => now.call(performance) + 10_000;
    try {
      h.viewer.scene.preRender.raiseEvent();
    } finally {
      performance.now = now;
    }
    assert.equal(h.cells().items.size, 0, 'no cells in a detections band');
  } finally {
    h.cleanup();
  }
});

test("with no query or frame port, the layer still follows the camera through the viewer's scene", async () => {
  const h = harness([raw(30.5, -98.2, 1500)], 12_000_000, {
    sceneFromViewer: true,
  });
  try {
    h.layer.init(h.viewer);
    await h.layer.enable(h.viewer);
    assert.equal(h.cells().items.size, 1);
    h.viewer.camera.positionCartographic = Cesium.Cartographic.fromDegrees(
      -97.7,
      30.2,
      500_000,
    );
    h.viewer.camera.positionWC = Cesium.Cartesian3.fromDegrees(
      -97.7,
      30.2,
      500_000,
    );
    // A frame past the LOD check's throttle, however fast the start was.
    const now = performance.now;
    performance.now = () => now.call(performance) + 10_000;
    try {
      h.viewer.scene.preRender.raiseEvent();
    } finally {
      performance.now = now;
    }
    assert.equal(h.cells().items.size, 0, 'no cells in a detections band');
  } finally {
    h.cleanup();
  }
});
