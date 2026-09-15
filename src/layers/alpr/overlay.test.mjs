import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { createAlprOverlay } from './overlay.js';
import { directionWedgePositions, alprLabelDetails } from './visuals.js';

function harness(t, count = 2) {
  const previousImage = globalThis.Image;
  const project = Cesium.SceneTransforms.worldToWindowCoordinates;
  globalThis.Image = class {
    complete = true;
    naturalWidth = 128;
  };
  Cesium.SceneTransforms.worldToWindowCoordinates = () => ({ x: 100, y: 100 });
  const records = Array.from({ length: count }, (_, i) => ({
    id: `camera:${i}`,
    latitude: 30 + i / 10000,
    longitude: -97,
    directionDeg: 90,
  }));
  const entities = new Cesium.EntityCollection();
  for (const record of records)
    entities.add({
      id: record.id,
      billboard: { image: 'fallback', show: true },
      polyline: { show: true },
      polygon: { show: true },
    });
  const state = {
    enabled: true,
    selectedId: null,
    dataSource: { entities },
    viewer: {
      camera: { positionWC: Cesium.Cartesian3.fromDegrees(-97, 30, 500) },
      scene: { globe: { show: true, getHeight: () => 150 } },
    },
  };
  let paint,
    mapListener,
    active,
    removed = 0,
    paints = 0;
  const overlay = createAlprOverlay({
    state,
    services: {
      groundFloor: { cachedGroundFloor: () => null },
      overlays: {
        registerPaintLane(_lane, painter) {
          paint = painter;
          return {
            setActive(value) {
              active = value;
            },
            requestPaint() {
              paints++;
            },
            unregister() {
              removed++;
            },
          };
        },
        keyholeAlpha: () => 1,
        subscribeMapStack(fn) {
          mapListener = fn;
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
    Cesium.SceneTransforms.worldToWindowCoordinates = project;
  });
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
  return {
    state,
    records,
    overlay,
    entities,
    draw,
    paint: (occluder) => paint({ ctx, width: 800, height: 600, occluder }),
    mapChanged() {
      mapListener({ detail: { status: 'ready' } });
    },
    get active() {
      return active;
    },
    get removed() {
      return removed;
    },
    get paints() {
      return paints;
    },
  };
}

test('a selected camera without a bearing gets its badge and brackets, never a fabricated wedge', (t) => {
  const h = harness(t, 1);
  h.records[0].directionDeg = null;
  h.state.selectedId = h.records[0].id;
  h.overlay.sync(h.records);
  h.paint();
  assert.equal(h.draw.length, 2);
  assert.ok(h.draw[0].endsWith('alpr-marker-selected.png'));
  assert.ok(h.draw[1].endsWith('alpr-marker-selected-brackets.png'));
  assert.equal(h.overlay.pick({ x: 100, y: 100 }), 'camera:0');
  assert.equal(h.entities.getById('camera:0').billboard.show.getValue(), true);
  assert.equal(
    h.entities.getById('camera:0').billboard.color.getValue().alpha,
    0.01,
  );
  assert.equal(directionWedgePositions(h.records[0]), null);
});

test('the overlay bounds its cohort and promotes selection while leaving farther cameras native', (t) => {
  const h = harness(t, 70);
  h.state.selectedId = 'camera:69';
  h.overlay.sync(h.records);
  h.paint();
  const hidden = h.entities.values.filter((e) => e.gevAlprNativeAppearance);
  assert.equal(hidden.length, 64);
  assert.ok(hidden.some((e) => e.id === 'camera:69'));
  assert.equal(
    h.overlay.pick({ x: 100, y: 100 }),
    'camera:69',
    'selected glyph paints and picks on top',
  );
  const firstGlyph = h.draw.findIndex((value) => value !== 'wedge');
  assert.equal(firstGlyph, 64, 'all wedges paint before any glyph');
});

test('surface changes invalidate cached anchors, and disable/disposal release painting and hits', (t) => {
  const h = harness(t, 1);
  h.overlay.sync(h.records);
  h.paint();
  const entity = h.entities.getById('camera:0');
  const first = entity.gevAlprCanvasPosition;
  h.paint();
  assert.equal(
    entity.gevAlprCanvasPosition,
    first,
    'stable anchor across frames',
  );
  h.state.viewer.scene.globe.show = false;
  h.mapChanged();
  assert.equal(entity.gevAlprCanvasPosition, null);
  h.state.enabled = false;
  h.overlay.clear();
  assert.equal(h.active, false);
  assert.equal(h.overlay.pick({ x: 100, y: 100 }), null);
  assert.equal(entity.billboard.show.getValue(), true);
  assert.equal(entity.billboard.color, undefined);
  assert.equal(entity.position, undefined);
  h.overlay.destroy();
  assert.equal(h.removed, 1);
});

test('an unresolved surface preserves the native marker; the horizon removes overlay hits', (t) => {
  const h = harness(t, 1);
  h.state.viewer.scene.globe.getHeight = () => -15000;
  h.overlay.sync(h.records);
  h.paint();
  assert.equal(h.entities.getById('camera:0').billboard.show.getValue(), true);
  assert.equal(h.draw.length, 0);
  h.state.viewer.scene.globe.getHeight = () => 150;
  h.paint({ isPointVisible: () => false });
  assert.equal(h.overlay.pick({ x: 100, y: 100 }), null);
  assert.equal(h.draw.length, 0);
});

test('adapter labels never claim a custom source is public OSM data', () => {
  assert.deepEqual(
    alprLabelDetails(
      { manufacturer: 'Vendor', operator: 'Vendor' },
      { label: 'Custom directory' },
    ),
    ['Source: Custom directory', 'VENDOR'],
  );
});
