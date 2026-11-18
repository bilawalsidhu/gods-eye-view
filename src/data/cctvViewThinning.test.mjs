// src/data/cctvViewThinning.test.mjs — the CCTV view pass: only cameras on or
// near the screen show, a zoomed-out view groups neighboring cameras, and the layer's UI state never rebuilds every camera for a listener
// that does not read the list.
import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { CAMERA_GREEN } from '../layers/cctv/policy.js';
import { createCameraGlyphCache } from '../layers/cctv/countMarkers.js';
import { createCameraCell } from './cctvCellCounts.js';
import { bindRenderer } from '../render/rendererOf.js';
import { DEFAULT_FOCUS_DEEMPHASIS_PARAMS } from './focusDeemphasis.js';
import { fakeCameraPort } from '../testSupport/fakeCameraPort.mjs';
import cctvLayer, {
  _cctvIconsForTest,
  bindCctvWorldClickGesture,
  applyCctvFocusDeemphasis,
  reopenNearestCamera,
  _setCctvCoverageStateForTest,
  _viewRecordIdsForTest,
  refreshCoverageStyles,
  refreshHorizonCulling,
} from './cctv.js';

const WIDTH = 800;
const HEIGHT = 600;

/** Records at the given [lon, lat] degrees near the origin. */
function recordsAt(lonLats) {
  const records = lonLats.map(([lon, lat], index) => {
    const position = Cesium.Cartesian3.fromDegrees(lon, lat, 10);
    return {
      camera: {
        id: `cam-${index}`,
        name: `Camera ${index}`,
        city: 'Test',
        lat,
        lon,
        headingDeg: 0,
        pitchDeg: -18,
        fovDeg: 44,
        rangeM: 145,
        mountHeightM: 8,
        absoluteHeightM: 10,
      },
      position: { x: position.x, y: position.y, z: position.z },
      coverageEntities: [],
      projection: null,
    };
  });
  return { records };
}

/**
 * A viewer looking straight down from `heightM` over `lonDeg` on the
 * equator, north up, through a camera port: the view pass projects the
 * cameras from its pose.
 */
function viewerAt(heightM, lonDeg = 0, flights = []) {
  const eye = Cesium.Cartesian3.fromDegrees(lonDeg, 0, heightM);
  const down = Cesium.Cartesian3.normalize(
    Cesium.Cartesian3.negate(eye, new Cesium.Cartesian3()),
    new Cesium.Cartesian3(),
  );
  const north = { x: 0, y: 0, z: 1 };
  const right = Cesium.Cartesian3.cross(down, north, new Cesium.Cartesian3());
  const { port } = fakeCameraPort({
    pose: {
      lon: lonDeg,
      lat: 0,
      height: heightM,
      position: { x: eye.x, y: eye.y, z: eye.z },
      direction: { x: down.x, y: down.y, z: down.z },
      up: north,
      right: { x: right.x, y: right.y, z: right.z },
      fovy: Math.PI / 3,
      aspectRatio: WIDTH / HEIGHT,
      near: 0.1,
      far: 5e8,
    },
  });
  port.flyToBounds = (bounds, options) => flights.push({ bounds, options });
  const viewer = {};
  bindings.push(
    bindRenderer(viewer, {
      camera: port,
      canvas: { clientWidth: WIDTH, clientHeight: HEIGHT },
    }),
  );
  return viewer;
}

/** The renderers bound for the running test, let go when it ends. */
const bindings = [];
let painter;
let paintRequests;
let measured;
let glyphWidth;
let inkHalfHeight;
let ctx;
const fonts = new EventTarget();
let rasters;
let spriteImages;

/** Model the sprite’s neutral highlights, dark fills and translucent edges. */
function markerCanvas() {
  const canvas = {};
  const context = {
    measureText(text) {
      measured++;
      return {
        width: text.length * glyphWidth,
        actualBoundingBoxAscent: inkHalfHeight,
        actualBoundingBoxDescent: inkHalfHeight,
      };
    },
    drawImage(image, x, y, width, height) {
      assert.equal(image.loaded, true);
      assert.deepEqual(
        [x, y, width, height],
        [0, 0, canvas.width, canvas.height],
      );
      canvas.source = image.src;
      const h = Math.floor(height / 2);
      canvas.ink = [2, 3, Math.floor(h * 1.5), h];
      rasters.push(canvas);
    },
    getImageData() {
      const data = new Uint8ClampedArray(canvas.width * canvas.height * 4);
      const [left, top, width, height] = canvas.ink;
      for (let y = top; y < top + height; y++) {
        for (let x = left; x < left + width; x++) {
          const shade = x === left ? 255 : 64;
          data.set(
            [shade, shade, shade, y === top ? 1 : 255],
            (y * canvas.width + x) * 4,
          );
        }
      }
      return { data };
    },
    putImageData({ data }) {
      const [left, top] = canvas.ink;
      const start = (top * canvas.width + left) * 4;
      canvas.stroke = [...data.slice(start, start + 4)];
      canvas.fill = [...data.slice(start + 4, start + 8)];
    },
  };
  canvas.getContext = () => context;
  return canvas;
}

function seedCoverage(options) {
  _setCctvCoverageStateForTest({
    ...options,
    registerPaintLane(_lane, paint) {
      painter = paint;
      return {
        requestPaint() {
          paintRequests++;
        },
        setActive() {},
        unregister() {},
      };
    },
  });
}

beforeEach(() => {
  spriteImages = [];
  globalThis.Image = class {
    constructor() {
      spriteImages.push(this);
    }
    finish() {
      this.loaded = true;
      this.onload();
    }
  };
  paintRequests = 0;
  measured = 0;
  glyphWidth = 8;
  inkHalfHeight = 4;
  rasters = [];
  globalThis.document = { fonts, createElement: markerCanvas };
  const stack = [];
  ctx = {
    font: 'initial',
    globalAlpha: 1,
    fillStyle: 'initial',
    strokeStyle: 'initial',
    textAlign: 'start',
    textBaseline: 'top',
    lineWidth: 1,
    glyphs: [],
    rings: [],
    labels: [],
    shapes: [],
    save() {
      stack.push({ ...this });
    },
    restore() {
      Object.assign(this, stack.pop());
    },
    beginPath() {},
    fill() {},
    drawImage(image, left, top, sw, sh, x, y, width, height) {
      assert.deepEqual([left, top, sw, sh], image.ink);
      assert.ok(Math.abs(width / height - sw / sh) < 1e-9);
      this.glyphs.push({
        image,
        x: x + width / 2,
        y: y + height / 2,
        width,
        height,
      });
    },
    stroke() {
      this.rings.push(this.strokeStyle);
    },
    roundRect(...args) {
      this.shapes.push(args);
    },
    fillText(text, x, y) {
      this.labels.push({
        text,
        x,
        y,
        color: this.fillStyle,
        alpha: this.globalAlpha,
        font: this.font,
      });
    },
  };
});

/** Reproject on each paint in CSS pixels, as the host does. */
function paint(overrides = {}) {
  ctx.glyphs.length =
    ctx.rings.length =
    ctx.labels.length =
    ctx.shapes.length =
      0;
  painter({
    ctx,
    width: WIDTH,
    height: HEIGHT,
    dpr: 1,
    viewProjectionMatrix: new Float64Array([
      0,
      0,
      0,
      0,
      2 / (30 * WIDTH),
      0,
      0,
      0,
      0,
      2 / (30 * HEIGHT),
      0,
      0,
      0,
      0,
      0,
      1,
    ]),
    occluder: { isPointVisible: () => true },
    overlapsHardUi: () => false,
    ...overrides,
  });
  return ctx.labels;
}

afterEach(() => {
  delete globalThis.Image;
  delete globalThis.document;
  for (const unbind of bindings.splice(0)) unbind();
});

function shownIds(records) {
  const icons = _cctvIconsForTest();
  return records
    .filter((record) => icons.item(record.camera.id)?.show === true)
    .map((record) => record.camera.id)
    .sort();
}

// Three cameras within ~110 m, and one ~22 km away.
const CLUSTER = [
  [0, 0],
  [0.001, 0],
  [0.0005, 0.0005],
  [0.2, 0],
];

/** Groups from the latest view pass. */
function markers() {
  return cctvLayer._cctvDrawnForTest().counts.markers;
}

/** Click the CSS position of the painted count with a camera underneath it. */
function clickMarker(marker) {
  const { x, y } = paint().find((label) => label.text === marker.text);
  const hit = { set: _cctvIconsForTest().setId, id: 'cam-0' };
  let fallback;
  const click = bindCctvWorldClickGesture({ onClick: (fn) => fn }, (event) => {
    fallback = event.drawHit;
  });
  const gesture = { travelPx: 0, durationMs: 20 };
  click({ drawHit: hit, screenPosition: { x, y }, gesture });
  assert.equal(fallback, undefined);
  click({
    drawHit: hit,
    screenPosition: { x: x + marker.width / 2 + 1, y },
    gesture,
  });
  assert.equal(fallback, hit);
}

test('a crowded cell shows its count and a singleton keeps its icon', () => {
  const { records } = recordsAt(CLUSTER);
  seedCoverage({ viewer: viewerAt(20_000), records });
  assert.equal(refreshHorizonCulling(), true);
  assert.deepEqual(shownIds(records), ['cam-3']);
  assert.deepEqual(_viewRecordIdsForTest(), ['cam-3']);
  assert.deepEqual(
    markers().map((item) => item.cell.count),
    [3],
  );
  assert.deepEqual(
    cctvLayer.getDetectableObjects().map((o) => o.sourceId),
    ['cam-3'],
  );
});

test('a pan keeps the same winners, and an unchanged view keeps its list', () => {
  const { records } = recordsAt(CLUSTER);
  seedCoverage({
    viewer: viewerAt(20_000),
    records,
  });
  refreshHorizonCulling();
  const before = cctvLayer.getUIState().cameraIndex;
  const list = _viewRecordIdsForTest();
  // A pan of a few to some 40 px (a pixel is about 30 m from 20 km up).
  for (const shiftM of [90, 330, 600, 1110]) {
    seedCoverage({
      viewer: viewerAt(20_000, shiftM / 111_320),
      records,
    });
    refreshHorizonCulling();
    assert.deepEqual(
      cctvLayer.getUIState().cameraIndex,
      before,
      `pan by ${shiftM} m`,
    );
  }
  seedCoverage({ viewer: viewerAt(20_000), records });
  refreshHorizonCulling();
  assert.equal(refreshHorizonCulling(), false, 'the same view changes nothing');
  assert.deepEqual(_viewRecordIdsForTest(), list);
});

test('a small zoom within one cell size keeps the same winners', () => {
  const { records } = recordsAt(CLUSTER);
  const shownAt = (heightM) => {
    seedCoverage({
      viewer: viewerAt(heightM),
      records,
    });
    refreshHorizonCulling();
    return cctvLayer.getUIState().cameraIndex;
  };
  // Cells come in power-of-two metre steps: about 1.5 km and 1.6 km cells at
  // these heights fall in the same step, so the same cameras win.
  assert.deepEqual(shownAt(20_500), shownAt(20_000));
});

test('the picker prefers the healthy camera and the marker stays at the mean', () => {
  const { records } = recordsAt(CLUSTER.slice(0, 2));
  // Whichever camera the id order would pick, the healthy one must win.
  let first;
  for (const id of ['cam-0', 'cam-1']) {
    seedCoverage({
      viewer: viewerAt(20_000),
      records,
      healthById: new Map([[id, { status: 'ok' }]]),
    });
    refreshHorizonCulling();
    assert.deepEqual(
      cctvLayer.getUIState().cameraIndex.map((c) => c.id),
      [id],
    );
    const { pos, height } = markers()[0];
    assert.equal(height, 40);
    const center = Cesium.Cartesian3.fromDegrees(0.0005, 0, 10);
    assert.ok(Cesium.Cartesian3.distance(pos, center) < 0.02);
    if (first) assert.deepEqual(pos, first);
    first = pos;
    records.reverse();
  }
});

test('the active camera always shows, even in a crowded cell', () => {
  const { records } = recordsAt(CLUSTER.slice(0, 3));
  for (const active of records) {
    seedCoverage({
      viewer: viewerAt(20_000),
      records,
      activeCameraId: active.camera.id,
    });
    refreshHorizonCulling();
    assert.deepEqual(
      markers().map((item) => item.cell.count),
      [2],
    );
    const icons = _cctvIconsForTest();
    assert.ok(
      icons.item(active.camera.id).show,
      `${active.camera.id} shows while active`,
    );
  }
});

test('close up, every camera near the screen shows and far-off ones hide', () => {
  // From 300 m up the screen spans some 460 m: the third camera is 1.1 km off.
  const { records } = recordsAt([
    [0, 0],
    [0.0001, 0],
    [0.01, 0],
  ]);
  seedCoverage({
    viewer: viewerAt(300),
    records,
  });
  refreshHorizonCulling();
  assert.deepEqual(shownIds(records), ['cam-0', 'cam-1']);
});

test('a disabled layer skips the view pass', () => {
  const { records } = recordsAt(CLUSTER);
  seedCoverage({
    viewer: viewerAt(20_000),
    records,
    enabled: false,
  });
  assert.equal(refreshHorizonCulling(), false);
  assert.deepEqual(_viewRecordIdsForTest(), []);
});

test('UI state builds the full camera list only when it is read', () => {
  const { records } = recordsAt(CLUSTER.slice(0, 2));
  seedCoverage({
    viewer: viewerAt(300),
    records,
  });
  refreshHorizonCulling();
  let built = 0;
  for (const record of records) {
    const camera = record.camera;
    record.camera = new Proxy(camera, {
      get(target, key) {
        if (key === 'calibration') built += 1;
        return target[key];
      },
    });
  }
  const first = cctvLayer.getUIState();
  assert.equal(built, 0, 'listeners that skip `cameras` cost nothing');
  assert.deepEqual(
    first.cameraIndex.map((camera) => camera.id),
    ['cam-0', 'cam-1'],
  );
  assert.equal(
    cctvLayer.getUIState().cameraIndex,
    first.cameraIndex,
    'the index keeps its identity while the view does',
  );
  assert.equal(first.cameras.length, 2);
  assert.ok(built > 0, 'reading `cameras` builds it');
  assert.equal(first.cameras, first.cameras, 'and builds it once');
});

test('the camera picker lists the view, with the active camera first', () => {
  const { records } = recordsAt([
    [0, 0],
    [0.01, 0],
    [0.0002, 0],
  ]);
  seedCoverage({
    viewer: viewerAt(300),
    records,
    activeCameraId: 'cam-1',
  });
  refreshHorizonCulling();
  const state = cctvLayer.getUIState();
  assert.deepEqual(
    state.cameraIndex.map((camera) => camera.id),
    ['cam-1', 'cam-0', 'cam-2'],
    'the off-screen active camera leads, then what is in view',
  );
  assert.equal(state.cameras.length, 3, 'the full list is still every camera');
});

test('panning a cell across the padded screen edge keeps its full count', () => {
  const { records } = recordsAt([
    [0.277, 0],
    [0.28, 0],
    [0.29, 0],
  ]);
  for (const lon of [0.015, 0]) {
    seedCoverage({ viewer: viewerAt(20_000, lon), records });
    refreshHorizonCulling();
    assert.deepEqual(
      markers().map((item) => item.cell.count),
      [3],
    );
    if (lon === 0)
      assert.equal(cctvLayer.getUIState().cameraIndex[0].id, 'cam-0');
  }
});

test('only members on the near side of the horizon count', () => {
  // At 20 km the limb crosses this cell between 4.55 and 4.69 degrees.
  // All three mounts project inside the screen in the query-port fixture.
  const { records } = recordsAt([
    [4.5, 0],
    [4.55, 0],
    [4.69, 0],
  ]);
  const viewer = {};
  const { port } = fakeCameraPort({
    pose: {
      position: Cesium.Cartesian3.fromDegrees(0, 0, 20_000),
      fovy: undefined,
    },
  });
  bindings.push(
    bindRenderer(viewer, {
      camera: port,
      canvas: { width: WIDTH, height: HEIGHT },
      query: { project: () => ({ x: 400, y: 300 }) },
    }),
  );
  seedCoverage({ viewer, records });
  refreshHorizonCulling();
  assert.deepEqual(
    markers().map((item) => item.cell.count),
    [2],
  );
});

test('co-located cameras separate below the minimum cell size', () => {
  const { records } = recordsAt([
    [0, 0],
    [0, 0],
  ]);
  seedCoverage({ viewer: viewerAt(300), records });
  refreshHorizonCulling();
  assert.deepEqual(shownIds(records), ['cam-0', 'cam-1']);
  assert.deepEqual(markers(), []);
});

test('a count click frames its members and preserves an explicit camera choice', () => {
  for (const spread of [0, 0.01]) {
    const flights = [];
    const { records } = recordsAt([
      [0, 0],
      [spread, 0],
      [0.2, 0],
    ]);
    seedCoverage({
      viewer: viewerAt(20_000, 0, flights),
      records,
      activeCameraId: 'cam-2',
      openingCameraProvisional: false,
    });
    refreshHorizonCulling();
    const marker = markers()[0];
    clickMarker(marker);
    assert.equal(flights.length, 1);
    const { bounds, options } = flights[0];
    for (const record of records.slice(0, 2))
      assert.ok(
        bounds.radius >
          Cesium.Cartesian3.distance(bounds.center, record.position),
      );
    const range = options.offset.range;
    assert.ok(range > 0 && range < 10_000);
    // Run the same view pass at the requested destination.
    const center = Cesium.Cartographic.fromCartesian(bounds.center);
    const destination = viewerAt(
      center.height + range,
      Cesium.Math.toDegrees(center.longitude),
    );
    assert.equal(reopenNearestCamera(), false);
    assert.equal(cctvLayer.getUIState().activeCameraId, 'cam-2');
    seedCoverage({
      viewer: destination,
      records,
      activeCameraId: 'cam-2',
    });
    refreshHorizonCulling();
    assert.deepEqual(markers(), []);
    assert.deepEqual(shownIds(records), ['cam-0', 'cam-1']);
  }
});

test('disabling the layer hides its counts', () => {
  const { records } = recordsAt(CLUSTER);
  seedCoverage({ viewer: viewerAt(20_000), records });
  refreshHorizonCulling();
  assert.equal(markers().length, 1);
  const [label] = paint();
  cctvLayer.disable();
  assert.deepEqual(paint(), []);
  assert.equal(cctvLayer._cctvDrawnForTest().counts.pickedCell(label), null);
});

test('coverage leaves grouped neighbors and returns when their icons separate', () => {
  const { records } = recordsAt([
    [0, 0],
    [0, 0],
    [0, 0],
  ]);
  // Lines already materialised at close zoom.
  for (const record of records) record.coverageEntities = [{ show: true }];
  const viewer = viewerAt(20_000);
  seedCoverage({ viewer, records, activeCameraId: 'cam-0' });
  refreshCoverageStyles();
  refreshHorizonCulling();
  assert.deepEqual(
    records.map((r) => r.coverageEntities[0].show),
    [true, false, false],
  );
  records[1].camera.lon = 0.05;
  records[1].position = Cesium.Cartesian3.fromDegrees(0.05, 0, 10);
  refreshHorizonCulling();
  assert.deepEqual(
    records.map((r) => r.coverageEntities[0].show),
    [true, true, true],
  );
  assert.deepEqual(markers(), []);
});

test('count markers share the camera focus fade and recover on release', () => {
  const { records } = recordsAt(CLUSTER);
  seedCoverage({ viewer: viewerAt(20_000), records });
  refreshHorizonCulling();
  const target = {
    screenRect: { left: 40, top: 40, right: 60, bottom: 60 },
    cameraDistance: 1000,
  };
  const params = DEFAULT_FOCUS_DEEMPHASIS_PARAMS;
  let previousActiveCount = 0;
  const tick = (nowMs, target) => {
    previousActiveCount = applyCctvFocusDeemphasis({
      records,
      nowMs,
      target,
      params,
      previousActiveCount,
      screenPositionFor: () => ({ x: 50, y: 50 }),
      cameraDistanceFor: () => 1200,
    }).activeCount;
  };
  tick(0, target);
  tick(params.attackMs + 1, target);
  assert.equal(paint()[0].alpha, params.dimFloor);
  tick(params.attackMs + 2, null);
  tick(params.attackMs + params.releaseMs + 3, null);
  assert.equal(paint()[0].alpha, 1);
});

test('overlapping cells merge at their weighted centre and keep every camera in the flight bounds', () => {
  // The meridian separates the two near cells at every grid level.
  const { records } = recordsAt([
    [-0.001, 0],
    [-0.001, 0],
    [0.002, 0],
    [0.002, 0],
    [0.002, 0],
    [0.05, 0],
    [0.05, 0],
    [0, 0.001],
    [0, -0.001],
  ]);
  const flights = [];
  let previous;
  for (const [pan, order] of [
    [0, records],
    [0.003, [...records].reverse()],
  ]) {
    seedCoverage({
      viewer: viewerAt(20_000, pan, flights),
      records: order,
      activeCameraId: 'cam-7',
      healthById: new Map([[order[0].camera.id, { status: 'ok' }]]),
    });
    refreshHorizonCulling();
    const shown = markers();
    assert.deepEqual(shownIds(records), ['cam-7', 'cam-8']);
    assert.equal(
      shown.reduce((sum, m) => sum + m.cell.count, 0),
      7,
    );
    assert.deepEqual(
      shown.map((m) => m.cell.count).sort((a, b) => a - b),
      [2, 5],
    );
    const merged = shown.find((m) => m.cell.count === 5);
    assert.ok(
      Cesium.Cartesian3.distance(
        merged.pos,
        Cesium.Cartesian3.fromDegrees(0.0008, 0, 10),
      ) < 0.01,
    );
    const positions = shown.map((m) => [m.cell.key, m.pos, m.height, m.width]);
    if (previous) assert.deepEqual(positions, previous);
    previous = positions;
    clickMarker(merged);
    const { bounds } = flights.at(-1);
    assert.ok(
      records
        .slice(0, 5)
        .every(
          (r) =>
            Cesium.Cartesian3.distance(r.position, bounds.center) <
            bounds.radius,
        ),
    );
    assert.ok(
      bounds.radius < 300,
      'the separate cell stays outside the flight bounds',
    );
  }
});

test('the overlay paints narrow count labels as circles and wide labels as pills', () => {
  glyphWidth = 10;
  const { records } = recordsAt([
    ...Array(1300).fill([-0.008, 0]),
    ...Array(99).fill([0.06, 0]),
    [0.1, 0],
  ]);
  seedCoverage({ viewer: viewerAt(20_000), records });
  refreshHorizonCulling();
  const short = markers().find((m) => m.cell.count === 99);
  const long = markers().find((m) => m.cell.count === 1300);
  const measurements = measured;
  assert.equal(measurements, 2);
  const pending = paint().map(({ text, x, y }) => [text, x, y]);
  const pendingShapes = [...ctx.shapes];
  const requests = paintRequests;
  assert.equal(ctx.glyphs.length, 0);
  assert.equal(spriteImages.length, 1);
  spriteImages[0].finish();
  assert.equal(paintRequests, requests + 1);
  const labels = paint();
  assert.deepEqual(
    labels.map(({ text, x, y }) => [text, x, y]),
    pending,
  );
  assert.deepEqual(ctx.shapes, pendingShapes);
  refreshHorizonCulling();
  assert.equal(measured, measurements);
  const text = '1.3K';
  assert.equal(labels.length, 2);
  assert.equal(ctx.shapes.length, labels.length);
  const [sx, sy, sw, sh] = ctx.shapes[labels.findIndex((l) => l.text === '99')];
  const [lx, ly, lw, lh] = ctx.shapes[labels.findIndex((l) => l.text === text)];
  assert.equal(sw, sh);
  assert.ok(lw > lh);
  assert.ok(lw > text.length * glyphWidth);
  assert.equal(sh + 4, 48);
  assert.equal(lh + 4, 54);
  // The four-pixel outer stroke extends two pixels on each side of the path.
  assert.equal(sw + 4, short.width);
  assert.equal(lw + 4, long.width);
  assert.equal(sy + sh / 2, HEIGHT / 2);
  assert.equal(ly + lh / 2, HEIGHT / 2);
  assert.ok(Math.abs(sx + sw / 2 - (WIDTH / 2 + short.pos.y / 30)) < 1e-9);
  assert.ok(Math.abs(lx + lw / 2 - (WIDTH / 2 + long.pos.y / 30)) < 1e-9);
  assert.equal(ctx.glyphs.length, labels.length);
  assert.equal(CAMERA_GREEN, '#5dff8f');
  assert.deepEqual(
    ctx.rings.filter((_, i) => i % 2 === 1),
    labels.map(() => CAMERA_GREEN),
  );
  for (const [i, label] of labels.entries()) {
    const glyph = ctx.glyphs[i];
    const [left, top, w, h] = ctx.shapes[i];
    const cx = left + w / 2,
      cy = top + h / 2;
    assert.equal(glyph.x, cx);
    assert.equal(label.x, cx);
    assert.deepEqual(glyph.image.stroke, [93, 255, 143, 1]);
    assert.deepEqual(glyph.image.fill, [23, 64, 36, 1]);
    assert.equal(label.color, CAMERA_GREEN);
    const radius = h / 2 - 1;
    // 48 and 54 px markers: the glyph and its top gap grow with the marker.
    const grown = (h + 4 - 40) / 18;
    assert.ok(Math.abs(glyph.height - (7.5 + 2.5 * grown)) < 1e-9);
    assert.ok(
      Math.abs(glyph.y - glyph.height / 2 - (cy - radius + 3 + grown)) < 1e-9,
    );
    // The middle of the digits sits a fifth of the inner radius below centre.
    assert.ok(Math.abs(label.y - (cy + 0.2 * radius)) < 1e-9);
    assert.ok(label.y - inkHalfHeight - (glyph.y + glyph.height / 2) >= 5);
    for (const [width, edgeY, padding] of [
      [glyph.width, glyph.y - glyph.height / 2, 2],
      [label.text.length * glyphWidth, label.y + inkHalfHeight, 6],
    ]) {
      const chord = 2 * Math.sqrt(radius ** 2 - (edgeY - cy) ** 2);
      assert.ok((w - h + chord - width) / 2 >= padding - 1e-9);
    }
  }
  const builds = rasters.length;
  const images = ctx.glyphs.map((glyph) => glyph.image);
  assert.notEqual(images[0], images[1]);
  const idleCamera = _cctvIconsForTest().item(records.at(-1).camera.id);
  assert.equal(idleCamera.show, true);
  for (const image of images) assert.equal(image.source, idleCamera.image);
  paint();
  assert.deepEqual(
    ctx.glyphs.map((glyph) => glyph.image),
    images,
  );
  assert.equal(rasters.length, builds);
  assert.equal(paintRequests, requests + 1);
  assert.match(labels[0].font, /JetBrains Mono/);
  assert.equal(ctx.font, 'initial');
  assert.equal(ctx.fillStyle, 'initial');
  assert.equal(ctx.lineWidth, 1);
  ctx.drawImage = () => {
    throw new Error('glyph paint failed');
  };
  assert.throws(() => paint(), /glyph paint failed/);
  assert.equal(ctx.font, 'initial');
  assert.equal(ctx.fillStyle, 'initial');
});

test('a wide count label merges a horizontal neighbor beyond the circle diameter', () => {
  glyphWidth = 12;
  // The centers are 56 CSS pixels apart. Only the pill reaches its neighbor.
  const at = (count) => {
    const { records } = recordsAt([
      ...Array(count).fill([-0.0097, 0]),
      [0.0097, 0],
      [0.0097, 0],
    ]);
    seedCoverage({ viewer: viewerAt(20_000), records });
    refreshHorizonCulling();
    return markers().map((m) => m.cell.count);
  };
  assert.deepEqual(at(2), [2, 2]);
  assert.deepEqual(at(1300), [1302]);
});

test('a merged centre can pick up a third count marker', () => {
  // The northern pair is 42 px apart. Its centre is 44.5 px from the
  // southern group, within reach only after the count grows from two to four.
  const { records } = recordsAt([
    [-0.0073, 0],
    [-0.0073, 0],
    [0.0073, 0],
    [0.0073, 0],
    [0, -0.0154],
    [0, -0.0154],
  ]);
  seedCoverage({ viewer: viewerAt(20_000), records });
  refreshHorizonCulling();
  assert.deepEqual(
    markers().map((m) => m.cell.count),
    [6],
  );
});

test('each paint follows the overlay projection, horizon and hard HUD exclusions', () => {
  const { records } = recordsAt([
    [-0.001, 0],
    [-0.001, 0],
    [0.001, 0],
    [0.001, 0],
  ]);
  seedCoverage({ viewer: viewerAt(20_000), records });
  refreshHorizonCulling();
  const counts = cctvLayer._cctvDrawnForTest().counts;
  assert.ok(paintRequests > 0);
  const requests = paintRequests;
  const widths = measured;
  const [label] = paint();
  assert.equal(label.text, '4');
  assert.equal(label.x, 400);
  assert.ok(label.y > 300);
  const first = { x: 400, y: 300 };
  assert.equal(counts.pickedCell(first).count, 4);
  const at = (x) => {
    const matrix = new Float64Array(16);
    matrix[12] = (2 * x) / WIDTH - 1;
    matrix[15] = 1;
    return { viewProjectionMatrix: matrix };
  };
  assert.equal(paint(at(100))[0].x, 100);
  assert.equal(counts.pickedCell(first), null);
  assert.deepEqual(paint(at(-100)), []);
  assert.deepEqual(paint({ occluder: { isPointVisible: () => false } }), []);
  assert.deepEqual(paint({ overlapsHardUi: () => true }), []);
  assert.equal(counts.pickedCell(first), null);
  refreshHorizonCulling();
  assert.equal(measured, widths);
  assert.equal(paintRequests, requests);
});

test('loaded font metrics remerge visible cells without waiting for a move', () => {
  glyphWidth = 3;
  const { records } = recordsAt([
    ...Array(1300).fill([-0.0097, 0]),
    [0.0097, 0],
    [0.0097, 0],
  ]);
  seedCoverage({ viewer: viewerAt(20_000), records });
  refreshHorizonCulling();
  assert.equal(markers().length, 2);
  glyphWidth = 14;
  fonts.dispatchEvent(new Event('loadingdone'));
  assert.deepEqual(
    markers().map((m) => m.cell.count),
    [1302],
  );
  assert.equal(paint().length, 1);
});

test('hits follow paint order and keep the last painted group until the overlay clears', () => {
  const { records } = recordsAt([
    [0, 0],
    [0, 0],
    [0.05, 0],
    [0.05, 0],
    [0.05, 0],
  ]);
  seedCoverage({ viewer: viewerAt(20_000), records });
  refreshHorizonCulling();
  const point = { x: WIDTH / 2, y: HEIGHT / 2 };
  const matrix = new Float64Array(16);
  matrix[15] = 1;
  const labels = paint({ viewProjectionMatrix: matrix });
  const counts = cctvLayer._cctvDrawnForTest().counts;
  assert.equal(labels.length, 2);
  const top = counts.pickedCell(point);
  assert.equal(String(top.count), labels.at(-1).text);
  counts.update([], () => null);
  assert.equal(counts.pickedCell(point), top);
  assert.deepEqual(paint(), []);
  assert.equal(counts.pickedCell(point), null);
});

test('paint, HUD exclusions and hit rectangles use the count-scaled height', () => {
  seedCoverage({ viewer: viewerAt(20_000) });
  const counts = cctvLayer._cctvDrawnForTest().counts;
  for (const [count, height] of [
    [2, 40],
    [10, 44],
    [100, 48],
    [1000, 54],
    [3162, 56],
    [3163, 56],
    [7350, 58],
    [1e8, 58],
  ]) {
    const cell = { ...createCameraCell('cell'), count };
    for (const lon of [0, 0.025]) {
      counts.update(
        [{ ...cell, lonSum: Math.round(lon * 1e7) * count }],
        () => null,
      );
      if (!spriteImages[0]?.loaded) spriteImages[0].finish();
      let rect;
      const [label] = paint({
        overlapsHardUi(value) {
          rect = { ...value };
          return false;
        },
      });
      if (height === 40 || height === 58)
        assert.equal(ctx.glyphs[0].height, height === 40 ? 7.5 : 10);
      const marker = markers()[0];
      assert.equal(marker.height, height);
      assert.equal(rect.h, height);
      assert.equal(rect.w, marker.width);
      const [x, y, w, h] = ctx.shapes[0];
      assert.deepEqual(
        [x - 2, y - 2, w + 4, h + 4],
        [rect.x, rect.y, rect.w, rect.h],
      );
      for (const sign of [-1, 1]) {
        const edgeY = rect.y + height / 2 + (sign * height) / 2;
        assert.equal(counts.pickedCell({ x: label.x, y: edgeY }).count, count);
        assert.equal(
          counts.pickedCell({ x: label.x, y: edgeY + sign * 0.1 }),
          null,
        );
      }
    }
    // Centred 23 px above the canvas: the taller badges still cross the edge.
    const matrix = new Float64Array(16);
    matrix[13] = 1 + 46 / HEIGHT;
    matrix[15] = 1;
    assert.equal(
      paint({ viewProjectionMatrix: matrix }).length,
      height > 46 ? 1 : 0,
    );
  }
});

test('measured ink width selects the circle or pill and clears the curved ring', () => {
  const { records } = recordsAt(Array(99).fill([0, 0]));
  seedCoverage({ viewer: viewerAt(20_000), records });
  for (const [width, extent, circle] of [
    [7, 4, true],
    [25, 4, false],
    // Width-only metrics reserve the full type height below the baseline.
    [6, undefined, true],
  ]) {
    glyphWidth = width;
    inkHalfHeight = extent;
    fonts.dispatchEvent(new Event('loadingdone'));
    refreshHorizonCulling();
    const [label] = paint();
    const [, top, pathWidth, pathHeight] = ctx.shapes[0];
    assert.equal(pathHeight + 4, 48);
    assert.equal(pathWidth === pathHeight, circle);
    // At the top of the ink, the circle ends narrow the usable inner width.
    const innerRadius = pathHeight / 2 - 1;
    const edge = label.y + (extent ?? 6) - (top + pathHeight / 2);
    const clearWidth =
      pathWidth - pathHeight + 2 * Math.sqrt(innerRadius ** 2 - edge ** 2);
    assert.ok((clearWidth - label.text.length * width) / 2 >= 6);
  }
});

test('equal-size camera groups share a camera sprite and follow overlay pixel density', () => {
  const { records } = recordsAt([
    [0, 0],
    [0, 0],
    [0.05, 0],
    [0.05, 0],
  ]);
  seedCoverage({ viewer: viewerAt(20_000), records });
  refreshHorizonCulling();
  spriteImages[0].finish();
  paint({ dpr: 1 });
  const low = ctx.glyphs[0].image;
  assert.equal(ctx.glyphs[1].image, low);
  const builds = rasters.length;
  paint({ dpr: 2 });
  const high = ctx.glyphs[0].image;
  assert.equal(ctx.glyphs[1].image, high);
  assert.notEqual(high, low);
  // The raster follows the device density; the painted size does not.
  assert.deepEqual([low.width, high.width], [16, 30]);
  assert.equal(ctx.glyphs[0].height, 7.5);
  paint({ dpr: 2 });
  assert.equal(rasters.length, builds + 1);
  paint({ dpr: 1 });
  assert.equal(ctx.glyphs[0].image, low);
  assert.equal(rasters.length, builds + 1);
});

test('the glyph cache draws its supplied map sprite and multiplies its colours', () => {
  const source =
    'data:image/svg+xml,' +
    encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg"><circle r="5"/></svg>',
    );
  const glyphFor = createCameraGlyphCache(markerCanvas, source);
  assert.equal(glyphFor(12, 2, CAMERA_GREEN), null);
  assert.equal(spriteImages[0].src, source);
  spriteImages[0].finish();
  const green = glyphFor(12, 2, CAMERA_GREEN);
  assert.equal(glyphFor(12, 2, CAMERA_GREEN), green);
  const white = glyphFor(12, 2, '#ffffff');
  assert.notEqual(white, green);
  assert.deepEqual(
    rasters.map(({ source: drawn }) => drawn),
    [source, source],
  );
  assert.deepEqual(white.canvas.stroke, [255, 255, 255, 1]);
  assert.deepEqual(white.canvas.fill, [64, 64, 64, 1]);
});

test('a sprite that loads after disposal does not request a paint', () => {
  const { records } = recordsAt(CLUSTER);
  seedCoverage({ viewer: viewerAt(20_000), records });
  refreshHorizonCulling();
  cctvLayer._cctvDrawnForTest().counts.dispose();
  const requests = paintRequests;
  spriteImages[0].finish();
  assert.equal(rasters.length, 0);
  assert.equal(paintRequests, requests);
});

test('counts still paint when an offscreen 2D context is unavailable', () => {
  document.createElement = () => ({ getContext: () => null });
  const { records } = recordsAt([
    [0, 0],
    [0, 0],
  ]);
  seedCoverage({ viewer: viewerAt(20_000), records });
  refreshHorizonCulling();
  spriteImages[0].finish();
  assert.deepEqual(
    paint().map((label) => label.text),
    ['2'],
  );
  assert.equal(ctx.glyphs.length, 0);
  assert.equal(ctx.shapes.length, 1);
});
