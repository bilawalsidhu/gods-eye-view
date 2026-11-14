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
  const frames = [];
  const overlay = createAlprOverlay({
    state,
    requestFrame: (step) => frames.push(step),
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
    /** Run the sampling step queued for the next animation frame, if any. */
    frame() {
      const step = frames.shift();
      step?.();
      return Boolean(step);
    },
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

test('repeated paints of a still view never rewrite marker properties', (t) => {
  // Each Entity write raises definitionChanged; paint used to hide then show
  // every overlay camera's native marker on every frame.
  const h = harness(t, 3);
  h.overlay.sync(h.records);
  h.paint();
  let changes = 0;
  for (const entity of h.entities.values)
    entity.definitionChanged.addEventListener(() => changes++);
  for (let i = 0; i < 5; i++) h.paint();
  assert.equal(changes, 0);
  assert.equal(h.entities.getById('camera:0').billboard.show.getValue(), true);
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

/** A photoreal scene: no globe, the rendered surface read by depth samples. */
function photoreal(h, heightAt = () => 172) {
  const scene = h.state.viewer.scene;
  h.state.viewer.camera.directionWC = Cesium.Cartesian3.UNIT_X;
  scene.globe.show = false;
  scene.sampleHeightSupported = true;
  scene.primitives = { length: 0, get: () => null };
  const sampled = [];
  scene.sampleHeight = (carto) => {
    sampled.push(carto);
    return heightAt(Cesium.Math.toDegrees(carto.latitude));
  };
  return sampled;
}

const anchorHeight = (h, id) =>
  Cesium.Cartographic.fromCartesian(
    h.entities.getById(id).gevAlprCanvasPosition,
  ).height;

/** Run sampling frames until none is queued, waiting out the 250 ms look-again. */
function settle(t, h) {
  for (let i = 0; i < 400; i++) if (!h.frame()) t.mock.timers.tick(250);
}

test('a still view replaces floor anchors with the rendered surface, within the floor window', (t) => {
  // Floors come from ~111 m cells; on a slope a badge floated above the mesh.
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const h = harness(t, 2, { floor: 150 });
  const sampled = photoreal(h, (latitude) => (latitude > 30.00005 ? 400 : 172));
  h.overlay.sync(h.records);
  h.paint();
  assert.ok(
    Math.abs(anchorHeight(h, 'camera:0') - 151.5) < 0.01,
    'floor anchor first',
  );
  assert.equal(h.frame(), true, 'the paint queued a sampling frame');
  assert.equal(
    sampled.length,
    0,
    'no depth samples while the camera may still be moving',
  );
  settle(t, h);
  assert.ok(
    Math.abs(anchorHeight(h, 'camera:0') - 173.5) < 0.01,
    'rendered surface once still',
  );
  assert.ok(
    Math.abs(anchorHeight(h, 'camera:1') - 151.5) < 0.01,
    'a rooftop-height sample is rejected',
  );
  assert.equal(sampled.length, 2);
  h.paint();
  settle(t, h);
  assert.equal(sampled.length, 2, 'each anchor is checked once');
});

test('a paint never samples the surface; frames take one sample each', (t) => {
  // Sampling inside paint() put up to six depth renders into one frame, and
  // the first of them compiles shaders: a freeze of 0.8 to 1.9 s at load.
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const h = harness(t, 8);
  const sampled = photoreal(h);
  h.overlay.sync(h.records);
  h.paint();
  h.paint();
  assert.equal(sampled.length, 0, 'no sample inside a paint');
  assert.equal(h.draw.length, 0, 'unanchored cameras keep their native badge');
  for (let taken = 1; taken <= 8; taken++) {
    assert.equal(h.frame(), true);
    assert.equal(sampled.length, taken, 'one sample per frame');
  }
  for (const record of h.records)
    assert.ok(Math.abs(anchorHeight(h, record.id) - 172) < 0.01);
  h.paint();
  assert.ok(h.draw.length > 0, 'anchored cameras paint on the overlay');
});

test('a terrain globe is read from its mesh, never depth-sampled', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const h = harness(t, 3, { floor: 150 });
  const sampled = photoreal(h);
  const scene = h.state.viewer.scene;
  scene.globe.show = true;
  scene.globe.tilesLoaded = true;
  let reads = 0;
  scene.globe.getHeight = () => {
    reads++;
    return 172;
  };
  h.overlay.sync(h.records);
  h.paint();
  settle(t, h);
  assert.equal(sampled.length, 0);
  assert.equal(reads, 3);
  // The same anchor the depth sample gave: the surface plus the marker lift.
  for (const record of h.records)
    assert.ok(Math.abs(anchorHeight(h, record.id) - 173.5) < 0.01);
});

test('surface answers outlive rebuilt markers and a re-enable, until the map changes', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const h = harness(t, 4, { floor: 150 });
  const sampled = photoreal(h);
  h.overlay.sync(h.records);
  h.paint();
  settle(t, h);
  assert.equal(sampled.length, 4);
  const before = h.records.map((record) => anchorHeight(h, record.id));

  // A refresh or a toggle removes the entities and builds new ones.
  const rebuild = () => {
    h.overlay.clear();
    h.entities.removeAll();
    for (const record of h.records)
      h.entities.add({
        id: record.id,
        billboard: { image: 'fallback', show: true },
        polyline: { show: true },
        polygon: { show: true },
      });
    h.overlay.sync(h.records);
    h.paint();
    settle(t, h);
  };
  rebuild();
  h.state.enabled = false;
  h.overlay.clear();
  h.state.enabled = true;
  rebuild();
  assert.equal(sampled.length, 4, 'no camera is sampled again');
  assert.deepEqual(
    h.records.map((record) => anchorHeight(h, record.id)),
    before,
  );

  // A camera that moved is a different question.
  h.records[0] = { ...h.records[0], latitude: h.records[0].latitude + 0.001 };
  rebuild();
  assert.equal(sampled.length, 5);

  h.mapChanged();
  h.paint();
  settle(t, h);
  assert.equal(sampled.length, 9, 'a new map surface is sampled afresh');
});
