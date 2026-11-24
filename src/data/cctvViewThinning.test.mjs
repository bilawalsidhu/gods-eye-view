// src/data/cctvViewThinning.test.mjs — the CCTV view pass: only cameras on or
// near the screen show, a zoomed-out view groups neighboring cameras, and
// the layer's UI state never rebuilds every camera for a listener
// that does not read the list.
import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { CAMERA_GREEN, COUNT_CAMERA_ICON } from '../layers/cctv/policy.js';
import { fakeDrawPort } from '../testSupport/fakeDrawPort.mjs';
import { createCameraCell } from './cctvCellCounts.js';
import { bindRenderer, findCamera } from '../render/rendererOf.js';
import { DEFAULT_FOCUS_DEEMPHASIS_PARAMS } from './focusDeemphasis.js';
import { fakeCameraPort } from '../testSupport/fakeCameraPort.mjs';
import cctvLayer, {
  _cctvIconsForTest,
  focusCctvRecord,
  CCTV_FOCUS_RESULT,
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
function poseAt(heightM, lonDeg) {
  const eye = Cesium.Cartesian3.fromDegrees(lonDeg, 0, heightM);
  const down = Cesium.Cartesian3.normalize(
    Cesium.Cartesian3.negate(eye, new Cesium.Cartesian3()),
    new Cesium.Cartesian3(),
  );
  const north = { x: 0, y: 0, z: 1 };
  const right = Cesium.Cartesian3.cross(down, north, new Cesium.Cartesian3());
  return {
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
  };
}

function viewerAt(heightM, lonDeg = 0, flights = [], ports = {}) {
  const { port, setPose } = fakeCameraPort({ pose: poseAt(heightM, lonDeg) });
  port.flyToBounds = (bounds, options) => flights.push({ bounds, options });
  const viewer = { moveTo: (lon) => setPose(poseAt(heightM, lon)) };
  bindings.push(
    bindRenderer(viewer, {
      camera: port,
      canvas: { clientWidth: WIDTH, clientHeight: HEIGHT },
      ...ports,
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
let spriteImages;

function markerCanvas() {
  const context = {
    measureText(text) {
      measured++;
      return {
        width: text.length * glyphWidth,
        actualBoundingBoxAscent: inkHalfHeight,
        actualBoundingBoxDescent: inkHalfHeight,
      };
    },
  };
  return { getContext: () => context };
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
      assert.ok(image.loaded);
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

test('a lone camera beside a count joins it, unless it is the active camera', () => {
  // Three cameras north of a cell boundary, one 111 m away south of it.
  const { records } = recordsAt([
    [0.0005, 0.0005],
    [0.0006, 0.0005],
    [0.0007, 0.0005],
    [0.0006, -0.0005],
    [0.2, 0],
  ]);
  seedCoverage({ viewer: viewerAt(20_000), records });
  refreshHorizonCulling();
  assert.deepEqual(shownIds(records), ['cam-4']);
  assert.deepEqual(_viewRecordIdsForTest(), ['cam-4']);
  assert.deepEqual(
    markers().map((item) => item.cell.count),
    [4],
  );
  assert.deepEqual(
    cctvLayer.getDetectableObjects().map((o) => o.sourceId),
    ['cam-4'],
  );
  // The picker still offers one camera from each ground cell.
  assert.equal(cctvLayer.getUIState().cameraIndex.length, 3);

  seedCoverage({
    viewer: viewerAt(20_000),
    records,
    activeCameraId: 'cam-3',
  });
  refreshHorizonCulling();
  assert.deepEqual(shownIds(records), ['cam-3', 'cam-4']);
  assert.deepEqual(
    markers().map((item) => item.cell.count),
    [3],
  );
});

test('cameras the height batch never answered for take the drawn terrain', () => {
  // Two mounts on one pole in the mountains and a lone camera. The batch
  // answered for none of them, so they hold the catalog height (10 m), far
  // under the terrain; a fourth camera has its answer and keeps it.
  const { records } = recordsAt([
    [0.001, 0.0005],
    [0.001, 0.0005],
    [0.2, 0],
    [0.3, 0],
  ]);
  // A failed chunk leaves the geoid fallback; a real answer is 'reearth'.
  records[2].groundPrior = { ellipsoid: -20, source: 'geoid-fallback' };
  records[3].groundPrior = { ellipsoid: 2, source: 'reearth' };
  const flights = [];
  const samples = [];
  let terrain = 1872.4;
  let globeShown = true;
  const ports = {
    globe: { isGlobeVisible: () => globeShown },
    query: {
      sampleHeightNow(point, options) {
        samples.push([point, options]);
        return terrain;
      },
    },
  };
  const heightOf = (position) =>
    Cesium.Cartographic.fromCartesian(position).height;
  const icon = (i) => _cctvIconsForTest().item(records[i].camera.id);
  seedCoverage({ viewer: viewerAt(20_000, 0, flights, ports), records });

  // The photoreal stack hides the globe: terrain is not the surface there.
  globeShown = false;
  refreshHorizonCulling();
  assert.equal(samples.length, 0);
  assert.ok(Math.abs(heightOf(records[0].position) - 10) < 0.01);

  // Terrain that has not loaded leaves a camera where it is, to be read again.
  globeShown = true;
  terrain = null;
  refreshHorizonCulling();
  assert.ok(samples.length >= 3);
  assert.ok(samples.every(([, options]) => options.against === 'terrain'));
  assert.equal(records[0].groundPrior, undefined);
  assert.ok(Math.abs(heightOf(markers()[0].pos) - 10) < 0.01);

  terrain = 1872.4;
  refreshHorizonCulling();
  // Each unanswered camera stands its mount height above the drawn terrain.
  for (const i of [0, 1, 2]) {
    assert.equal(records[i].groundPrior.source, 'drawn-terrain');
    assert.ok(Math.abs(records[i].camera.absoluteHeightM - 1880.4) < 1e-9);
    assert.ok(Math.abs(heightOf(records[i].position) - 1880.4) < 0.01);
    assert.ok(Math.abs(heightOf(icon(i).pos) - 1880.4) < 0.01);
  }
  // The answered one is left alone.
  assert.equal(records[3].groundPrior.source, 'reearth');
  assert.ok(Math.abs(heightOf(records[3].position) - 10) < 0.01);
  // The count stands on the terrain and its click frames the ground there.
  const [marker] = markers();
  assert.equal(marker.cell.count, 2);
  assert.ok(Math.abs(heightOf(marker.pos) - 1872) < 0.01);
  clickMarker(marker);
  assert.ok(Math.abs(heightOf(flights.at(-1).bounds.center) - 1872) < 0.01);

  // Read once: the same view does not read a camera's terrain again.
  samples.length = 0;
  refreshHorizonCulling();
  assert.ok(samples.every(([point]) => Math.abs(point.lat - 0.0005) < 1e-9));

  // From less than half as far the finer terrain is read and replaces it.
  terrain = 1890;
  seedCoverage({ viewer: viewerAt(9_000, 0, flights, ports), records });
  refreshHorizonCulling();
  assert.ok(Math.abs(records[0].camera.absoluteHeightM - 1898) < 1e-9);
  assert.equal(records[3].groundPrior.source, 'reearth');
});

test('a tilted view keeps the count of cameras that stood under the terrain', () => {
  // The same pole seen from 200 m above the terrain and 1 km away, a view
  // 11 degrees below the horizontal. Projected from its catalog height the
  // pole falls below the padded screen and its count vanishes; on the
  // terrain it is in the middle of the view.
  const { records } = recordsAt([
    [0, 0],
    [0, 0],
  ]);
  const ground = 1872;
  const eye = Cesium.Cartesian3.fromDegrees(0, -0.009, ground + 200);
  const target = Cesium.Cartesian3.fromDegrees(0, 0, ground);
  const direction = Cesium.Cartesian3.normalize(
    Cesium.Cartesian3.subtract(target, eye, new Cesium.Cartesian3()),
    new Cesium.Cartesian3(),
  );
  const right = Cesium.Cartesian3.normalize(
    Cesium.Cartesian3.cross(direction, eye, new Cesium.Cartesian3()),
    new Cesium.Cartesian3(),
  );
  const up = Cesium.Cartesian3.cross(right, direction, new Cesium.Cartesian3());
  const plain = ({ x, y, z }) => ({ x, y, z });
  const { port } = fakeCameraPort({
    pose: {
      lon: 0,
      lat: -0.009,
      height: ground + 200,
      position: plain(eye),
      direction: plain(direction),
      up: plain(up),
      right: plain(right),
      fovy: Math.PI / 3,
      aspectRatio: WIDTH / HEIGHT,
      near: 0.1,
      far: 5e8,
    },
  });
  let terrain = null;
  const viewer = {};
  bindings.push(
    bindRenderer(viewer, {
      camera: port,
      canvas: { clientWidth: WIDTH, clientHeight: HEIGHT },
      globe: { isGlobeVisible: () => true },
      query: { sampleHeightNow: () => terrain },
    }),
  );
  seedCoverage({ viewer, records });
  refreshHorizonCulling();
  assert.equal(markers().length, 0, 'under the terrain it is off the screen');
  terrain = ground;
  refreshHorizonCulling();
  assert.deepEqual(
    markers().map((item) => item.cell.count),
    [2],
  );
});

test('cameras on one mount draw side by side once they show as icons', () => {
  const { records } = recordsAt([
    [0.001, 0.0005],
    [0.001, 0.0005],
    [0.0011, 0.0005],
  ]);
  // Close enough that every camera shows: about 0.87 m a pixel.
  seedCoverage({ viewer: viewerAt(460), records });
  refreshHorizonCulling();
  assert.deepEqual(shownIds(records), ['cam-0', 'cam-1', 'cam-2']);
  const icons = _cctvIconsForTest();
  const [a, b, c] = records.map((record) => icons.item(record.camera.id).pos);
  // 30 px apart along the screen's horizontal, centred on the shared mount.
  const metres = Cesium.Cartesian3.distance(a, b);
  const metresPerPixel = ((2 * Math.tan(Math.PI / 6)) / HEIGHT) * 450;
  assert.ok(Math.abs(metres / metresPerPixel - 30) < 0.5);
  const middle = Cesium.Cartesian3.midpoint(a, b, new Cesium.Cartesian3());
  assert.ok(Cesium.Cartesian3.distance(middle, records[0].position) < 1e-6);
  // The third camera, 11 m away, has a mount of its own.
  assert.ok(Cesium.Cartesian3.distance(c, records[2].position) < 1e-6);
  // The records keep the mount; callouts follow the drawn icons.
  assert.ok(
    Cesium.Cartesian3.distance(records[0].position, records[1].position) < 1e-9,
  );
  const callouts = cctvLayer.getDetectableObjects();
  for (const [i, pos] of [a, b].entries()) {
    const callout = callouts.find((o) => o.sourceId === `cam-${i}`);
    assert.ok(Cesium.Cartesian3.distance(callout.position, pos) < 1e-9);
  }
  // An unchanged view writes nothing more.
  const before = [a, b];
  refreshHorizonCulling();
  assert.equal(icons.item('cam-0').pos, before[0]);
  assert.equal(icons.item('cam-1').pos, before[1]);

  // Grouped again, both icons are back on the mount for their next showing.
  seedCoverage({ viewer: viewerAt(20_000), records });
  refreshHorizonCulling();
  assert.deepEqual(shownIds(records), []);
  for (const i of [0, 1])
    assert.ok(
      Cesium.Cartesian3.distance(
        _cctvIconsForTest().item(`cam-${i}`).pos,
        records[i].position,
      ) < 1e-6,
    );
});

test('a pan keeps the same winners, and an unchanged view keeps its list', () => {
  const { records } = recordsAt(CLUSTER);
  const viewer = viewerAt(20_000);
  seedCoverage({ viewer, records });
  refreshHorizonCulling();
  const before = cctvLayer.getUIState().cameraIndex;
  const list = _viewRecordIdsForTest();
  // A pan of a few to some 40 px (a pixel is about 30 m from 20 km up).
  for (const shiftM of [90, 330, 600, 1110]) {
    viewer.moveTo(shiftM / 111_320);
    refreshHorizonCulling();
    assert.equal(
      cctvLayer.getUIState().cameraIndex,
      before,
      `pan by ${shiftM} m`,
    );
  }
  viewer.moveTo(0);
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

test('a dimmed count keeps its alpha when its cell changes and recovers on release', () => {
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

  const record = records[0];
  record.camera.lon += 2 / 111_320;
  record.position = Cesium.Cartesian3.fromDegrees(
    record.camera.lon,
    record.camera.lat,
    record.camera.absoluteHeightM,
  );
  refreshHorizonCulling();
  tick(params.attackMs + 2, target);
  assert.equal(paint()[0].alpha, params.dimFloor);

  tick(params.attackMs + 3, null);
  tick(params.attackMs + params.releaseMs + 4, null);
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
    // The lone camera 111 m south sits under the merged marker and joins it;
    // the active one beside it keeps its own icon.
    assert.deepEqual(shownIds(records), ['cam-7']);
    assert.equal(
      shown.reduce((sum, m) => sum + m.cell.count, 0),
      8,
    );
    assert.deepEqual(
      shown.map((m) => m.cell.count).sort((a, b) => a - b),
      [2, 6],
    );
    const merged = shown.find((m) => m.cell.count === 6);
    assert.ok(
      Cesium.Cartesian3.distance(
        merged.pos,
        Cesium.Cartesian3.fromDegrees(0.004 / 6, -0.001 / 6, 10),
      ) < 0.01,
    );
    const positions = shown.map((m) => [m.cell.key, m.pos, m.height, m.width]);
    if (previous) assert.deepEqual(positions, previous);
    previous = positions;
    clickMarker(merged);
    const { bounds } = flights.at(-1);
    assert.ok(
      [...records.slice(0, 5), records[8]].every(
        (r) =>
          Cesium.Cartesian3.distance(r.position, bounds.center) < bounds.radius,
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
  assert.equal(sy + sh / 2, HEIGHT / 2);
  assert.equal(ly + lh / 2, HEIGHT / 2);
  assert.ok(Math.abs(sx + sw / 2 - (WIDTH / 2 + short.pos.y / 30)) < 1e-9);
  assert.ok(Math.abs(lx + lw / 2 - (WIDTH / 2 + long.pos.y / 30)) < 1e-9);
  assert.equal(ctx.glyphs.length, labels.length);
  assert.deepEqual(
    ctx.rings.filter((_, i) => i % 2 === 1),
    labels.map(() => CAMERA_GREEN),
  );
  for (const [i, label] of labels.entries()) {
    const glyph = ctx.glyphs[i];
    assert.equal(glyph.x, label.x);
    assert.equal(label.color, CAMERA_GREEN);
    assert.ok(label.y - inkHalfHeight >= glyph.y + glyph.height / 2);
  }
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
  const replacements = counts.markers.map((marker) => ({
    ...marker.cell,
    count: 7,
  }));
  counts.update(replacements, () => null);
  assert.equal(counts.pickedCell(point), top);
  counts.update([], () => null);
  assert.equal(counts.pickedCell(point), top);
  assert.deepEqual(paint(), []);
  assert.equal(counts.pickedCell(point), null);
});

test('paint, HUD exclusions and hit rectangles use the count-scaled height', () => {
  seedCoverage({ viewer: viewerAt(20_000) });
  const counts = cctvLayer._cctvDrawnForTest().counts;
  let previous = 0;
  for (const count of [2, 10, 100, 1000, 3162, 3163, 7350, 1e8]) {
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
      const marker = markers()[0];
      const height = marker.height;
      assert.ok(height >= previous);
      if (count === 2) assert.equal(height, 40);
      previous = height;
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
  }
  assert.equal(previous, 58);
});

test('measured ink width selects the circle or pill', () => {
  const { records } = recordsAt(Array(99).fill([0, 0]));
  seedCoverage({ viewer: viewerAt(20_000), records });
  for (const [width, extent, circle] of [
    [7, 4, true],
    [25, 4, false],
  ]) {
    glyphWidth = width;
    inkHalfHeight = extent;
    fonts.dispatchEvent(new Event('loadingdone'));
    refreshHorizonCulling();
    paint();
    const [, , pathWidth, pathHeight] = ctx.shapes[0];
    assert.equal(pathWidth === pathHeight, circle);
  }
});

test('count markers draw the green camera sprite once it has loaded', () => {
  const { records } = recordsAt([
    [0, 0],
    [0, 0],
    [0.05, 0],
    [0.05, 0],
  ]);
  seedCoverage({ viewer: viewerAt(20_000), records });
  refreshHorizonCulling();
  paint();
  assert.equal(ctx.glyphs.length, 0);
  const requests = paintRequests;
  const [image] = spriteImages;
  assert.equal(image.src, COUNT_CAMERA_ICON);
  image.finish();
  assert.equal(paintRequests, requests + 1);
  paint();
  assert.deepEqual(
    ctx.glyphs.map((glyph) => glyph.image),
    [image, image],
  );
});

test('a sprite that loads after disposal does not request a paint', () => {
  const { records } = recordsAt(CLUSTER);
  seedCoverage({ viewer: viewerAt(20_000), records });
  refreshHorizonCulling();
  cctvLayer._cctvDrawnForTest().counts.dispose();
  const requests = paintRequests;
  spriteImages[0].finish();
  assert.equal(paintRequests, requests);
});

test('cameras less than a metre apart spread even across a rounding boundary', () => {
  const { records } = recordsAt([
    [0.000004, 0],
    [0.000006, 0],
  ]);
  seedCoverage({ viewer: viewerAt(460), records });
  refreshHorizonCulling();
  const icons = _cctvIconsForTest();
  const metresPerPixel = ((2 * Math.tan(Math.PI / 6)) / HEIGHT) * 450;
  const apart = Cesium.Cartesian3.distance(
    icons.item('cam-0').pos,
    icons.item('cam-1').pos,
  );
  assert.ok(Math.abs(apart / metresPerPixel - 30) < 0.5);
});

test('a drawn height read before the terrain settled, or on another surface, is read again', () => {
  const { records } = recordsAt([
    [0, 0],
    [0.2, 0],
  ]);
  records[0].groundPrior = { ellipsoid: -20, source: 'geoid-fallback' };
  let settled = false,
    version = 1,
    terrain = 100;
  const ports = {
    globe: {
      isGlobeVisible: () => true,
      isSettled: () => settled,
      surfaceVersion: () => version,
    },
    query: { sampleHeightNow: () => terrain },
  };
  seedCoverage({ viewer: viewerAt(20000, 0, [], ports), records });
  refreshHorizonCulling();
  assert.equal(records[0].groundPrior.ellipsoid, 100);
  assert.equal(records[0].groundPrior.settled, false);
  terrain = 150;
  refreshHorizonCulling();
  assert.equal(records[0].groundPrior.ellipsoid, 100);
  settled = true;
  refreshHorizonCulling();
  assert.equal(records[0].groundPrior.ellipsoid, 150);
  terrain = 0;
  version++;
  refreshHorizonCulling();
  assert.equal(records[0].groundPrior.ellipsoid, 0);
});

test('a camera with geometry takes the drawn terrain once, after the pass that read it', async () => {
  const { records } = recordsAt([
    [0, 0],
    [0.2, 0],
  ]);
  records[1].groundPrior = { ellipsoid: 2, source: 'reearth' };
  const record = records[0];
  Object.assign(record, {
    groundPrior: { ellipsoid: -20, source: 'geoid-fallback' },
    groundSamples: {},
    groundResolved: {},
  });
  const samples = [];
  const ports = {
    globe: { isGlobeVisible: () => true },
    query: {
      sampleHeightNow(point) {
        samples.push(point);
        return 1872;
      },
    },
    draw: fakeDrawPort(),
  };
  seedCoverage({
    viewer: viewerAt(2200, 0, [], ports),
    records,
    activeCameraId: 'cam-0',
  });
  refreshCoverageStyles();
  assert.ok(record.frustumGeometry);
  samples.length = 0;
  refreshHorizonCulling();
  refreshHorizonCulling();
  assert.equal(
    samples.filter((point) => point.lon === 0 && point.lat === 0).length,
    1,
  );
  assert.equal(record.groundPrior.source, 'geoid-fallback');
  await Promise.resolve();
  assert.equal(record.groundPrior.source, 'drawn-terrain');
  for (const pos of [record.position, _cctvIconsForTest().item('cam-0').pos])
    assert.ok(
      Math.abs(Cesium.Cartographic.fromCartesian(pos).height - 1880) < 0.01,
    );
});

/** Painted centre of a count marker in CSS px. */
function markerCentre(marker) {
  const label = paint().find((l) => l.text === marker.text);
  return { x: label.x, y: label.y - marker.labelY };
}

test('building geometry for spread mount mates keeps their icons beside the mount', () => {
  const { records } = recordsAt([
    [0.001, 0.0005],
    [0.001, 0.0005],
    [0.0011, 0.0005],
  ]);
  const draw = fakeDrawPort();
  seedCoverage({
    viewer: viewerAt(460, 0, [], { draw }),
    records,
    activeCameraId: 'cam-2',
  });
  refreshHorizonCulling();
  const icons = _cctvIconsForTest();
  const before = Cesium.Cartesian3.distance(
    icons.item('cam-0').pos,
    icons.item('cam-1').pos,
  );

  assert.ok(before > 10);
  refreshCoverageStyles();

  const after = Cesium.Cartesian3.distance(
    icons.item('cam-0').pos,
    icons.item('cam-1').pos,
  );
  const callouts = cctvLayer.getDetectableObjects();
  const ca = callouts.find((o) => o.sourceId === 'cam-0').position;

  assert.ok(after > 10, 'icons stay side by side after geometry is built');
  assert.ok(
    Cesium.Cartesian3.distance(icons.item('cam-0').pos, ca) < 1e-6,
    'icon and callout agree',
  );
});

test('a count click does not fly while the cockpit or a followed target owns the camera', () => {
  const { records } = recordsAt(CLUSTER);
  // Cockpit
  let flights = [];
  globalThis.document.body = {
    classList: { contains: (c) => c === 'cockpit-mode' },
  };
  let viewer = viewerAt(20_000, 0, flights);
  seedCoverage({ viewer, records });
  refreshHorizonCulling();
  assert.equal(
    focusCctvRecord(viewer, records[0]),
    CCTV_FOCUS_RESULT.COCKPIT_ACTIVE,
  );
  assert.equal(flights.length, 0);
  clickMarker(markers()[0]);

  assert.equal(flights.length, 0, 'count click must not fly in cockpit mode');
  // Tracking
  delete globalThis.document.body;
  flights = [];
  viewer = viewerAt(20_000, 0, flights);
  Object.defineProperty(findCamera(viewer), 'followed', {
    value: { key: 'flights:abc' },
    configurable: true,
  });
  seedCoverage({ viewer, records });
  refreshHorizonCulling();
  assert.equal(
    focusCctvRecord(viewer, records[0]),
    CCTV_FOCUS_RESULT.TRACKING_HOLDS_VIEW,
  );
  assert.equal(flights.length, 0);
  clickMarker(markers()[0]);

  assert.equal(flights.length, 0, 'count click must not fly while tracking');
});

test('each click on a long dense chain flies closer than the last', () => {
  const lons = [];
  const n = 200;
  const step = 50 / 111_320;
  for (let i = 0; i < n; i++) lons.push([(i - (n - 1) / 2) * step, 0]);
  const { records } = recordsAt(lons);
  const flights = [];
  seedCoverage({ viewer: viewerAt(24_000, 0, flights), records });
  refreshHorizonCulling();

  let marker = markers().find((m) => m.cell.count === n);
  assert.ok(marker, 'one count of 200');
  const clickAt = (m) => {
    const { x, y } = markerCentre(m);
    const click = bindCctvWorldClickGesture({ onClick: (fn) => fn }, () => {});
    click({
      screenPosition: { x, y },
      gesture: { travelPx: 0, durationMs: 20 },
    });
  };
  clickAt(marker);
  const first = flights.at(-1);
  const c1 = Cesium.Cartographic.fromCartesian(first.bounds.center);

  seedCoverage({
    viewer: viewerAt(
      c1.height + first.options.offset.range,
      Cesium.Math.toDegrees(c1.longitude),
      flights,
    ),
    records,
  });
  refreshHorizonCulling();

  marker = markers().find((m) => m.cell.count === n);
  assert.ok(marker, 'the full count of 200 reforms at the destination');
  clickAt(marker);
  const second = flights.at(-1);

  assert.ok(
    second.options.offset.range < first.options.offset.range - 1,
    'second click makes progress',
  );
});

test("a click outside a round count's circle does not hit it", () => {
  const { records } = recordsAt(CLUSTER);
  seedCoverage({ viewer: viewerAt(20_000), records });
  refreshHorizonCulling();
  const [marker] = markers();
  assert.equal(marker.width, marker.height, 'a round marker');
  const c = markerCentre(marker);
  const counts = cctvLayer._cctvDrawnForTest().counts;
  const r = marker.height / 2;
  const corner = { x: c.x + r - 1, y: c.y + r - 1 };
  const dist = Math.hypot(r - 1, r - 1);

  assert.ok(dist > r, 'corner is outside the painted circle');
  assert.equal(
    counts.pickedCell(corner),
    null,
    'a click outside the painted circle must not hit the count',
  );
});

test('an unresolved batch result takes the drawn terrain', () => {
  const { records } = recordsAt([
    [0, 0],
    [0.2, 0],
  ]);
  records[0].groundPrior = { ellipsoid: null, source: 'unresolved' };
  const ports = {
    globe: { isGlobeVisible: () => true },
    query: { sampleHeightNow: () => 1872 },
  };
  seedCoverage({ viewer: viewerAt(20_000, 0, [], ports), records });
  refreshHorizonCulling();
  const h = (r) => Cesium.Cartographic.fromCartesian(r.position).height;

  assert.ok(
    Math.abs(h(records[0]) - 1880) < 0.01,
    'an unresolved camera takes the drawn terrain',
  );
  assert.equal(records[1].groundPrior.source, 'drawn-terrain');
});

const metresPerPixel = ((2 * Math.tan(Math.PI / 6)) / HEIGHT) * 450;
const separationPx = () => {
  const icons = _cctvIconsForTest();
  return (
    Cesium.Cartesian3.distance(
      icons.item('cam-0').pos,
      icons.item('cam-1').pos,
    ) / metresPerPixel
  );
};

test('shared-mount icons stay spread after coverage geometry is built', () => {
  // cam-0/cam-1 share a mount, cam-2 is active 11 m away.
  const { records } = recordsAt([
    [0.001, 0.0005],
    [0.001, 0.0005],
    [0.0011, 0.0005],
  ]);
  for (const r of records) r.groundPrior = { ellipsoid: 2, source: 'reearth' };
  seedCoverage({
    viewer: viewerAt(460, 0, [], { draw: fakeDrawPort() }),
    records,
    activeCameraId: 'cam-2',
    coverageMode: 'on',
  });
  refreshHorizonCulling();
  const before = separationPx();

  // selection.setActiveCamera order: refreshHorizonCulling, then refreshCoverageStyles.
  refreshCoverageStyles();
  const after = separationPx();

  assert.ok(Math.abs(before - 30) < 0.5);
  assert.ok(Math.abs(after - 30) < 0.5, `icons collapsed to ${after} px`);
});
