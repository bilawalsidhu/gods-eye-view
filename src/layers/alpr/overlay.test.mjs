import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { createAlprOverlay } from './overlay.js';
import { normalizeAlprNode } from './records.js';
import {
  directionWedgePositions,
  alprLabelDetails,
  markerScale,
} from './visuals.js';
import { alprMarkers, createAlprMarkerSet } from './markerState.js';
import { fakeDrawPort } from '../../testSupport/fakeDrawPort.mjs';
import { bindFakeCesiumScene } from '../../testSupport/fakeCesiumScene.mjs';

function harness(t, count = 2, { floor = null } = {}) {
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
  const drawPort = fakeDrawPort();
  const markers = createAlprMarkerSet();
  markers.attach(drawPort.icons({ id: 'alpr-cameras:test:markers' }));
  const iconSet = drawPort.set('alpr-cameras:test:markers');
  for (const record of records)
    Object.assign(alprMarkers.write(markers.add(record.id)), {
      record,
      position: Cesium.Cartesian3.fromDegrees(
        record.longitude,
        record.latitude,
      ),
    });
  markers.flush();
  const state = {
    enabled: true,
    selectedId: null,
    markers,
    viewer: {
      camera: { positionWC: Cesium.Cartesian3.fromDegrees(-97, 30, 500) },
      scene: { globe: { show: true, getHeight: () => 150 } },
    },
  };
  const { unbind } = bindFakeCesiumScene(state.viewer, { draw: drawPort });
  let paint,
    mapListener,
    active,
    removed = 0,
    paints = 0;
  const overlay = createAlprOverlay({
    state,
    services: {
      groundFloor: { cachedGroundFloor: () => floor },
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
    unbind();
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
    markers,
    iconSet,
    /** A marker's carrier, and the icon last sent for it. */
    carrier: (id) => markers.get(id),
    icon: (id) => iconSet.items.get(id),
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
  assert.equal(h.icon('camera:0').show, true);
  assert.equal(h.icon('camera:0').color[3], 0.01, 'a faint pick target');
  assert.equal(directionWedgePositions(h.records[0]), null);
});

test('the overlay bounds its cohort and promotes selection while leaving farther cameras native', (t) => {
  // Floor anchors, so every camera anchors in one paint.
  const h = harness(t, 70, { floor: 150 });
  h.state.selectedId = 'camera:69';
  h.overlay.sync(h.records);
  h.paint();
  const hidden = [...h.markers.values()].filter(
    (carrier) => alprMarkers.read(carrier)?.canvasOwned,
  );
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
  const carrier = h.carrier('camera:0');
  const first = alprMarkers.read(carrier)?.canvasPosition;
  h.paint();
  assert.equal(
    alprMarkers.read(carrier)?.canvasPosition,
    first,
    'stable anchor across frames',
  );
  h.state.viewer.scene.globe.show = false;
  h.mapChanged();
  assert.equal(alprMarkers.read(carrier)?.canvasPosition, null);
  h.state.enabled = false;
  h.overlay.clear();
  assert.equal(h.active, false);
  assert.equal(h.overlay.pick({ x: 100, y: 100 }), null);
  const icon = h.icon('camera:0');
  assert.equal(icon.show, true);
  assert.equal(icon.color, undefined, 'the native badge again');
  assert.equal(icon.pos, alprMarkers.read(carrier).position);
  h.overlay.destroy();
  assert.equal(h.removed, 1);
});

test('an unresolved surface preserves the native marker; the horizon removes overlay hits', (t) => {
  const h = harness(t, 1);
  h.state.viewer.scene.globe.getHeight = () => -15000;
  h.overlay.sync(h.records);
  h.paint();
  assert.equal(h.icon('camera:0').show, true);
  assert.equal(h.icon('camera:0').color, undefined);
  assert.equal(h.draw.length, 0);
  h.state.viewer.scene.globe.getHeight = () => 150;
  h.paint({ isPointVisible: () => false });
  assert.equal(h.overlay.pick({ x: 100, y: 100 }), null);
  assert.equal(h.draw.length, 0);
});

test('repeated paints of a still view never rewrite markers', (t) => {
  // Paint used to hide then show every overlay camera's native marker on
  // every frame.
  const h = harness(t, 3);
  h.overlay.sync(h.records);
  h.paint();
  h.paint();
  const writes = h.iconSet.writes;
  for (let i = 0; i < 5; i++) h.paint();
  assert.equal(h.iconSet.writes, writes);
  assert.equal(h.icon('camera:0').show, true);
});

test('a resync hands back only the cameras that leave the overlay', (t) => {
  const h = harness(t, 2, { floor: 150 });
  h.overlay.sync(h.records);
  h.paint();
  assert.equal(h.icon('camera:0').color[3], 0.01);
  assert.equal(h.icon('camera:1').color[3], 0.01);
  const writes = h.iconSet.writes;
  h.overlay.sync([h.records[0]]);
  h.markers.flush();
  assert.equal(h.icon('camera:1').color, undefined, 'native again');
  assert.equal(h.icon('camera:0').color[3], 0.01, 'still under the canvas');
  assert.equal(
    h.iconSet.writes,
    writes + 1,
    'one write, for the camera that left',
  );
  h.paint();
  assert.equal(h.iconSet.writes, writes + 1, 'the next paint writes nothing');
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

test('a mapped bearing that rounds up to a whole turn reads 0°, not 360°', () => {
  const direction = (tag) =>
    alprLabelDetails(
      normalizeAlprNode({
        type: 'node',
        id: 1,
        lat: 30,
        lon: -97,
        tags: { 'surveillance:type': 'ALPR', 'camera:direction': tag },
      }),
      { label: 'Custom directory' },
    ).find((line) => line.startsWith('DIRECTION'));
  assert.equal(direction('359.6'), 'DIRECTION 0°');
  assert.equal(direction('359.4'), 'DIRECTION 359°');
  assert.equal(direction('0.4'), 'DIRECTION 0°');
});

test('overlay glyphs and native badges shrink alike with distance', () => {
  assert.equal(markerScale(100), 1.15);
  assert.equal(markerScale(40_000), 0.45);
  assert.equal(markerScale(90_000), 0.45);
  assert.ok(Math.abs(markerScale(20_250) - 0.8) < 1e-9);
});

test('a still view replaces floor anchors with the rendered surface, within the floor window', (t) => {
  // Floors come from ~111 m cells; on a slope a badge floated above the mesh.
  const h = harness(t, 2, { floor: 150 });
  const scene = h.state.viewer.scene;
  const camera = h.state.viewer.camera;
  camera.directionWC = Cesium.Cartesian3.UNIT_X;
  scene.sampleHeightSupported = true;
  scene.primitives = { length: 0, get: () => null };
  let samples = 0;
  scene.sampleHeight = (carto) => {
    samples++;
    return Cesium.Math.toDegrees(carto.latitude) > 30.00005 ? 400 : 172;
  };
  h.overlay.sync(h.records);
  h.paint();
  const height = (id) =>
    Cesium.Cartographic.fromCartesian(
      alprMarkers.read(h.carrier(id))?.canvasPosition,
    ).height;
  assert.equal(
    samples,
    0,
    'no depth samples while the camera may still be moving',
  );
  assert.ok(Math.abs(height('camera:0') - 151.5) < 0.01, 'floor anchor first');
  h.paint();
  assert.ok(
    Math.abs(height('camera:0') - 173.5) < 0.01,
    'rendered surface once still',
  );
  assert.ok(
    Math.abs(height('camera:1') - 151.5) < 0.01,
    'a rooftop-height sample is rejected',
  );
  const taken = samples;
  h.paint();
  assert.equal(samples, taken, 'each anchor is checked once');
});

test('a bearing wedge is plain ECEF at the apex and its two far corners', () => {
  const record = { latitude: 30.26, longitude: -97.74, directionDeg: 90 };
  const wedge = directionWedgePositions(record, 150, (lat) =>
    lat > 30.26 ? 160 : null,
  );
  assert.equal(wedge.length, 3);
  const apex = Cesium.Cartesian3.fromDegrees(-97.74, 30.26, 150);
  assert.deepEqual({ ...wedge[0] }, { x: apex.x, y: apex.y, z: apex.z });
  const heights = wedge.map(
    (p) =>
      Cesium.Cartographic.fromCartesian(new Cesium.Cartesian3(p.x, p.y, p.z))
        .height,
  );
  // The corner north of the apex takes the sampled height; the other falls back.
  assert.ok(heights.some((h) => Math.abs(h - 160) < 1e-6));
  assert.ok(heights.slice(1).some((h) => Math.abs(h - 150) < 1e-6));
});
