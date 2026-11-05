import test from 'node:test';
import assert from 'node:assert/strict';
import * as geo from '../../../geo/index.js';
import { createAlprNavaraOverlay } from './navaraOverlay.js';

function harness(t, count = 2) {
  const previousImage = globalThis.Image;
  globalThis.Image = class {
    complete = true;
    naturalWidth = 128;
  };
  const records = Array.from({ length: count }, (_, i) => ({
    id: `camera:${i}`,
    latitude: 30 + i / 10000,
    longitude: -97,
    directionDeg: 90,
  }));
  const markers = new Map(
    records.map((record) => [
      record.id,
      {
        id: record.id,
        record,
        shown: true,
        canvasOwned: false,
        position: geo.cartesian3.fromDegrees(
          record.longitude,
          record.latitude,
          151.5,
        ),
      },
    ]),
  );
  const state = { enabled: true, selectedId: null };
  let paint,
    mapListener,
    active,
    samples = 0,
    removed = 0;
  const pose = {
    position: geo.cartesian3.fromDegrees(-97, 30, 500),
    direction: geo.cartesian3.UNIT_X,
  };
  const engine = {
    camera: { livePosition: pose.position, pose: () => pose },
    projector: {
      worldToWindow: () => ({ x: 100, y: 100 }),
      horizonVisible: () => true,
    },
    surface: {
      supported: true,
      tilesLoaded: () => true,
      terrainHeightSupported: false,
    },
  };
  const draw = [];
  const ctx = {
    globalAlpha: 1,
    save() {},
    restore() {},
    beginPath() {},
    moveTo() {},
    lineTo() {},
    closePath() {},
    stroke() {},
    fill() {
      draw.push('wedge');
    },
    createLinearGradient: () => ({ addColorStop() {} }),
    drawImage(image) {
      draw.push(image.src);
    },
  };
  const overlay = createAlprNavaraOverlay({
    engine,
    state,
    markers,
    sampleHeight(location) {
      samples++;
      return geo.math.toDegrees(location.latitude) > 30.00005 ? 400 : 172;
    },
    syncMarker() {},
    services: {
      groundFloor: { cachedGroundFloor: () => 150 },
      overlays: {
        registerPaintLane(_name, callback) {
          paint = callback;
          return {
            requestPaint() {},
            setActive(value) {
              active = value;
            },
            unregister() {
              removed++;
            },
          };
        },
        keyholeAlpha: () => 1,
        subscribeMapStack(callback) {
          mapListener = callback;
          return () => {
            mapListener = null;
          };
        },
      },
    },
  });
  overlay.init();
  t.after(() => {
    overlay.destroy();
    if (previousImage === undefined) delete globalThis.Image;
    else globalThis.Image = previousImage;
  });
  return {
    state,
    markers,
    records,
    overlay,
    engine,
    draw,
    paint: (frame = {}) =>
      paint({
        ctx,
        width: 800,
        height: 600,
        viewProjectionMatrix: [
          0,
          0,
          0,
          0,
          0,
          0,
          0,
          0,
          0,
          0,
          0,
          0,
          -0.75,
          2 / 3,
          0,
          1,
        ],
        ...frame,
      }),
    mapChanged: () => mapListener({ detail: { status: 'ready' } }),
    get samples() {
      return samples;
    },
    get active() {
      return active;
    },
    get removed() {
      return removed;
    },
  };
}

test('ALPR overlay retains the 64-camera budget, paints selection last and invents no bearing', (t) => {
  const h = harness(t, 70);
  h.records[69].directionDeg = null;
  h.state.selectedId = 'camera:69';
  h.overlay.sync(h.records);
  h.paint();
  assert.equal([...h.markers.values()].filter((m) => m.canvasOwned).length, 64);
  assert.equal(h.draw.filter((x) => x === 'wedge').length, 63);
  assert.ok(h.draw.at(-1).endsWith('alpr-marker-selected-brackets.png'));
  assert.equal(h.overlay.pick({ x: 100, y: 100 }), 'camera:69');
  assert.equal(h.markers.get('camera:69').gevAlprWedge, null);
});

test('ALPR projects from the host frame and skips fully clipped wedges, preserving edge strokes', (t) => {
  const h = harness(t, 1);
  h.engine.projector.worldToWindow = () => {
    throw new Error('A paint must not reread camera and DOM size per vertex');
  };
  h.overlay.sync(h.records);
  h.paint();
  assert.equal(h.overlay.pick({ x: 100, y: 100 }), 'camera:0');
  const matrix = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, -1.005, 0, 0, 1];
  h.draw.length = 0;
  h.paint({ viewProjectionMatrix: matrix });
  assert.ok(
    h.draw.includes('wedge'),
    'a stroke within 3px of the edge still paints',
  );
  matrix[12] = -2;
  h.draw.length = 0;
  h.paint({ viewProjectionMatrix: matrix });
  assert.equal(h.draw.length, 0, 'fully clipped artwork allocates no gradient');
  assert.equal(h.overlay.pick({ x: 100, y: 100 }), null);
  matrix[15] = -1;
  h.paint({ viewProjectionMatrix: matrix });
  assert.equal(h.draw.length, 0, 'points behind the camera never paint');
});

test('ALPR overlay samples two settled anchors per paint and rejects roof-height outliers', (t) => {
  const h = harness(t);
  h.overlay.sync(h.records);
  h.paint();
  assert.equal(h.samples, 0);
  h.paint();
  assert.equal(h.samples, 2);
  const height = (id) =>
    geo.cartographic.fromCartesian(h.markers.get(id).gevAlprCanvasPosition)
      .height;
  assert.ok(Math.abs(height('camera:0') - 173.5) < 0.01);
  assert.ok(Math.abs(height('camera:1') - 151.5) < 0.01);
  h.paint();
  assert.equal(h.samples, 2);
  h.mapChanged();
  assert.equal(h.markers.get('camera:0').gevAlprCanvasPosition, null);
});

test('ALPR overlay horizon and disposal remove hits, painting and ownership', (t) => {
  const h = harness(t);
  h.overlay.sync(h.records);
  h.paint();
  h.engine.projector.horizonVisible = () => false;
  h.paint();
  assert.equal(h.overlay.pick({ x: 100, y: 100 }), null);
  h.state.enabled = false;
  h.overlay.clear();
  assert.equal(h.active, false);
  assert.ok([...h.markers.values()].every((m) => !m.canvasOwned && m.shown));
  h.overlay.destroy();
  assert.equal(h.removed, 1);
});
