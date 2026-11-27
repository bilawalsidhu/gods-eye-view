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
import {
  rendererOf,
  provideUnboundCamera,
  provideUnboundGlobe,
  provideUnboundQuery,
} from '../../render/rendererOf.js';
import { MAX_CANVAS_FRUSTUMS, REMEMBERED_SURFACE_ANSWERS } from './policy.js';

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
  let floorAt = typeof floor === 'function' ? floor : () => floor;
  const drawPort = fakeDrawPort();
  const markers = createAlprMarkerSet();
  markers.attach(drawPort.icons({ id: 'alpr-cameras:test:markers' }));
  const iconSet = drawPort.set('alpr-cameras:test:markers');
  const build = () => {
    for (const record of records)
      Object.assign(alprMarkers.write(markers.add(record.id)), {
        record,
        position: Cesium.Cartesian3.fromDegrees(
          record.longitude,
          record.latitude,
        ),
      });
    markers.flush();
  };
  build();
  const state = {
    enabled: true,
    selectedId: null,
    markers,
    viewer: {
      camera: { positionWC: Cesium.Cartesian3.fromDegrees(-97, 30, 500) },
      scene: { globe: { show: true, getHeight: () => 150 } },
    },
  };
  const ports = bindFakeCesiumScene(state.viewer, { draw: drawPort });
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
      groundFloor: {
        cachedGroundFloor: (latitude, longitude) =>
          floorAt(latitude, longitude),
      },
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
    ports.unbind?.();
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
    ports,
    /** A marker's carrier, and the icon last sent for it. */
    carrier: (id) => markers.get(id),
    icon: (id) => iconSet.items.get(id),
    draw,
    paint: (occluder) => paint({ ctx, width: 800, height: 600, occluder }),
    /** Run the steps queued for the next frame, as a browser would. */
    frame() {
      const steps = frames.splice(0);
      for (const step of steps) step();
      return steps.length > 0;
    },
    setFloor(value) {
      floorAt = typeof value === 'function' ? value : () => value;
    },
    /** Drop the markers and build them again, as turning the layer on does. */
    rebuildMarkers() {
      markers.clear();
      build();
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
  assert.equal(h.icon('camera:0').show, true);
  assert.equal(h.icon('camera:0').color[3], 0.01, 'a faint pick target');
  assert.equal(
    h.icon('camera:0').meta,
    h.carrier('camera:0'),
    'a pick hands point-and-ask the context carrier',
  );
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

/** A photoreal scene: the globe hidden, the rendered surface read by depth samples. */
function photoreal(h, heightAt = () => 172) {
  const scene = h.state.viewer.scene;
  h.state.viewer.camera.directionWC = Cesium.Cartesian3.UNIT_X;
  scene.globe.show = false;
  scene.sampleHeightSupported = true;
  rendererOf(h.state.viewer).globe = {
    isSettled: () => true,
    isGlobeVisible: () => scene.globe.show,
  };
  const sampled = [];
  scene.sampleHeight = (carto) => {
    sampled.push(carto);
    return heightAt(Cesium.Math.toDegrees(carto.latitude));
  };
  return sampled;
}

const anchorHeight = (h, id) =>
  Cesium.Cartographic.fromCartesian(
    alprMarkers.read(h.carrier(id))?.canvasPosition,
  ).height;

/** Run sampling frames until none is queued, waiting out the 250 ms look-again. */
function settle(t, h, rounds = 400) {
  for (let i = 0; i < rounds; i++) if (!h.frame()) t.mock.timers.tick(250);
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
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const h = harness(t, 8);
  const sampled = photoreal(h);
  h.overlay.sync(h.records);
  h.paint();
  h.paint();
  assert.equal(sampled.length, 0, 'no sample inside a paint');
  assert.equal(h.draw.length, 0, 'unanchored cameras keep their native badge');
  const paints = h.paints;
  for (let taken = 1; taken <= 8; taken++) {
    assert.equal(h.frame(), true);
    assert.equal(sampled.length, taken, 'one sample per frame');
  }
  for (const record of h.records)
    assert.ok(Math.abs(anchorHeight(h, record.id) - 172) < 0.01);
  assert.ok(h.paints > paints, 'a found anchor asks for a paint');
  h.paint();
  assert.ok(h.draw.length > 0, 'anchored cameras paint on the overlay');
});

test('a drawn globe is read from its terrain, never depth-sampled', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const h = harness(t, 3, { floor: 150 });
  const sampled = photoreal(h);
  const scene = h.state.viewer.scene;
  scene.globe.show = true;
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

  // Turning the layer off drops the markers; turning it on builds new ones.
  const rebuild = () => {
    h.overlay.clear();
    h.rebuildMarkers();
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

test('anchors wait for the surface heights answer from: the globe’s terrain while shown, else the shown 3D tiles', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const h = harness(t, 1, { floor: 150 });
  const scene = h.state.viewer.scene;
  h.state.viewer.camera.directionWC = Cesium.Cartesian3.UNIT_X;
  scene.sampleHeightSupported = true;
  let samples = 0;
  scene.sampleHeight = () => (samples++, 172);
  // The renderer's own `surface` rule; a non-base tileset still streaming
  // over a hidden globe leaves it unsettled.
  let surface = false;
  const asked = new Set();
  rendererOf(h.state.viewer).globe = {
    isSettled: (kind) => (asked.add(kind), kind === 'surface' ? surface : true),
    isGlobeVisible: () => false,
  };
  h.overlay.sync(h.records);
  h.paint();
  settle(t, h, 8);
  assert.equal(samples, 0, 'no samples while the surface streams');
  assert.deepEqual([...asked], ['surface']);
  surface = true;
  settle(t, h);
  assert.ok(samples > 0, 'sampled once it has loaded');
});

test('without height sampling no sample is spent, and the terrain anchors only while the globe is drawn', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  for (const shown of [true, false]) {
    const h = harness(t, 1);
    let samples = 0;
    h.state.viewer.scene.sampleHeight = () => (samples++, 172);
    const renderer = rendererOf(h.state.viewer);
    renderer.capabilities = new Set();
    renderer.globe = { isSettled: () => true, isGlobeVisible: () => shown };
    h.overlay.sync(h.records);
    h.paint();
    settle(t, h);
    h.paint();
    assert.equal(samples, 0, 'nothing sampled without the capability');
    assert.equal(
      Boolean(alprMarkers.read(h.carrier('camera:0'))?.canvasPosition),
      shown,
      shown ? 'anchored on the terrain' : 'no terrain under hidden globe',
    );
  }
});

/** Turn the layer off, then on again: markers are built afresh. */
function toggle(h, between = () => {}) {
  h.state.enabled = false;
  h.overlay.clear();
  h.markers.clear();
  between();
  h.state.enabled = true;
  h.rebuildMarkers();
  h.overlay.sync(h.records);
  h.paint();
}

const near = (value, expected) =>
  value !== null && Math.abs(value - expected) < 0.01;

test('an unchecked answer is restored on a rebuild and checked once more', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const h = harness(t, 1);
  const sampled = photoreal(h);
  h.overlay.sync(h.records);
  h.paint();
  assert.equal(h.frame(), true);
  assert.equal(sampled.length, 1);
  assert.ok(near(anchorHeight(h, 'camera:0'), 172), 'anchored by the sample');
  toggle(h);
  assert.ok(near(anchorHeight(h, 'camera:0'), 172), 'restored, not sampled');
  assert.equal(sampled.length, 1);
  settle(t, h);
  assert.equal(sampled.length, 2, 'one check');
  assert.ok(near(anchorHeight(h, 'camera:0'), 173.5));
});

test('surface answers keep the cameras used last', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const h = harness(t, REMEMBERED_SURFACE_ANSWERS + 1, { floor: 150 });
  const sampled = photoreal(h);
  const answer = (from, to) => {
    h.overlay.sync(h.records.slice(from, to));
    h.paint();
    settle(t, h, 2 * MAX_CANVAS_FRUSTUMS);
  };
  for (let i = 0; i < REMEMBERED_SURFACE_ANSWERS; i += MAX_CANVAS_FRUSTUMS)
    answer(i, i + MAX_CANVAS_FRUSTUMS);
  assert.equal(sampled.length, REMEMBERED_SURFACE_ANSWERS);
  h.rebuildMarkers();
  answer(0, 1);
  assert.equal(sampled.length, REMEMBERED_SURFACE_ANSWERS, 'camera:0 restored');
  // One answer more drops the camera used longest ago: camera:1, not camera:0.
  answer(REMEMBERED_SURFACE_ANSWERS, REMEMBERED_SURFACE_ANSWERS + 1);
  h.rebuildMarkers();
  answer(0, 2);
  assert.equal(sampled.length, REMEMBERED_SURFACE_ANSWERS + 2);
  const last = Cesium.Math.toDegrees(sampled.at(-1).latitude);
  assert.equal(Math.round((last - 30) * 10000), 1, 'camera:1 is asked again');
});

test('a map change heard while the layer is off drops the old surface answers', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const h = harness(t, 1, { floor: 150 });
  photoreal(h);
  const scene = h.state.viewer.scene;
  h.overlay.sync(h.records);
  h.paint();
  settle(t, h);
  assert.ok(near(anchorHeight(h, 'camera:0'), 173.5), 'photoreal answer');
  let reads = 0;
  scene.globe.getHeight = () => (reads++, 152);
  toggle(h, () => {
    scene.globe.show = true;
    h.mapChanged();
  });
  settle(t, h);
  assert.ok(reads > 0, 'the new terrain is read');
  assert.ok(near(anchorHeight(h, 'camera:0'), 153.5));
});

test('a drawn globe is read again on a rebuild, as finer terrain loads', (t) => {
  // A terrain globe can change under a camera with no map change: a finer
  // tile, or real terrain replacing a flat fallback.
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const h = harness(t, 1, { floor: 150 });
  const sampled = photoreal(h);
  const scene = h.state.viewer.scene;
  scene.globe.show = true;
  let terrain = 150;
  scene.globe.getHeight = () => terrain;
  h.overlay.sync(h.records);
  h.paint();
  settle(t, h);
  assert.ok(near(anchorHeight(h, 'camera:0'), 151.5));
  terrain = 165;
  toggle(h);
  settle(t, h);
  assert.ok(near(anchorHeight(h, 'camera:0'), 166.5));
  assert.equal(sampled.length, 0, 'never depth-sampled');
});

test('a surface sample outside the floor window is never restored as the anchor', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  // A roof sampled before the floor resolved, checked or not.
  for (const checked of [true, false]) {
    const h = harness(t, 1);
    photoreal(h, () => 400);
    h.overlay.sync(h.records);
    h.paint();
    if (checked) settle(t, h);
    else h.frame();
    assert.ok(near(anchorHeight(h, 'camera:0'), checked ? 401.5 : 400));
    h.setFloor(150);
    toggle(h);
    assert.ok(near(anchorHeight(h, 'camera:0'), 151.5), 'the floor');
    settle(t, h);
    assert.ok(near(anchorHeight(h, 'camera:0'), 151.5), 'the roof is rejected');
  }
});

test('a rejected sample puts the badge on its floor, and that is remembered', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const h = harness(t, 1);
  const sampled = photoreal(h, () => 400);
  h.overlay.sync(h.records);
  h.paint();
  h.frame();
  assert.ok(near(anchorHeight(h, 'camera:0'), 400), 'provisional');
  h.setFloor(150);
  settle(t, h);
  assert.ok(near(anchorHeight(h, 'camera:0'), 151.5));
  const taken = sampled.length;
  toggle(h);
  settle(t, h);
  assert.ok(near(anchorHeight(h, 'camera:0'), 151.5));
  assert.equal(sampled.length, taken, 'nothing sampled again');
});

test('a camera whose sample keeps missing does not take every sample', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  // camera:0, nearest, and camera:1 have no floor; camera:2 has one.
  const index = (latitude) => Math.round((latitude - 30) * 10000);
  const h = harness(t, 3, {
    floor: (latitude) => (index(latitude) === 2 ? 150 : null),
  });
  const sampled = photoreal(
    h,
    (latitude) => [undefined, 172, 165][index(latitude)],
  );
  h.overlay.sync(h.records);
  h.paint();
  let most = 0;
  for (let i = 0; i < 60; i++) {
    const before = sampled.length;
    if (!h.frame()) t.mock.timers.tick(250);
    most = Math.max(most, sampled.length - before);
  }
  assert.equal(most, 1, 'one sample per frame at most');
  assert.ok(near(anchorHeight(h, 'camera:1'), 173.5), 'anchored and checked');
  assert.ok(near(anchorHeight(h, 'camera:2'), 166.5), 'checked');
});

test('a paint after the retry window still queues a sample', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const h = harness(t, 1, { floor: 150 });
  const sampled = photoreal(h);
  let settled = false;
  rendererOf(h.state.viewer).globe.isSettled = () => settled;
  h.overlay.sync(h.records);
  h.paint();
  settle(t, h, 200); // tiles stream for longer than the 15 s window
  assert.equal(sampled.length, 0);
  settled = true;
  h.paint();
  settle(t, h, 20);
  assert.equal(sampled.length, 1);
  assert.ok(near(anchorHeight(h, 'camera:0'), 173.5));
});

test('a globe port that cannot say whether the globe is drawn depth-samples, as without one', (t) => {
  // A Cesium scene made with `globe: false`: photoreal tiles only.
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const h = harness(t, 2, {
    floor: (latitude) => (latitude > 30.00005 ? 150 : null),
  });
  const scene = h.state.viewer.scene;
  h.state.viewer.camera.directionWC = Cesium.Cartesian3.UNIT_X;
  scene.globe = undefined;
  scene.sampleHeightSupported = true;
  scene.sampleHeight = () => 172;
  rendererOf(h.state.viewer).globe = { isSettled: () => true };
  h.overlay.sync(h.records);
  h.paint();
  settle(t, h);
  assert.ok(near(anchorHeight(h, 'camera:0'), 173.5), 'the floorless camera');
  assert.ok(near(anchorHeight(h, 'camera:1'), 173.5), 'the floor anchor');
});

test('a viewer no renderer is bound to reads its globe port too', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const h = harness(t, 1, { floor: 150 });
  const viewer = h.state.viewer;
  const { query, camera } = h.ports;
  h.ports.unbind();
  h.ports.unbind = null;
  const only = (port) => (host) =>
    host === viewer ? { port, dispose() {} } : null;
  provideUnboundQuery(only(query));
  provideUnboundCamera(only(camera));
  provideUnboundGlobe(
    only({ isGlobeVisible: () => false, isSettled: () => true }),
  );
  t.after(() => {
    provideUnboundQuery(null);
    provideUnboundCamera(null);
    provideUnboundGlobe(null);
  });
  viewer.camera.directionWC = Cesium.Cartesian3.UNIT_X;
  viewer.scene.globe.show = false;
  viewer.scene.globe.getHeight = () => 145; // the hidden terrain
  viewer.scene.sampleHeightSupported = true;
  viewer.scene.sampleHeight = () => 172; // the shown tiles
  h.overlay.sync(h.records);
  h.paint();
  settle(t, h);
  assert.ok(near(anchorHeight(h, 'camera:0'), 173.5));
});
