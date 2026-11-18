// src/data/cctvViewThinning.test.mjs — the CCTV view pass: only cameras on or
// near the screen show, a zoomed-out view groups neighboring cameras, and the layer's UI state never rebuilds every camera for a listener
// that does not read the list.
import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { getLocale, setLocale } from '../i18n/index.js';
import { bindRenderer } from '../render/rendererOf.js';
import { DEFAULT_FOCUS_DEEMPHASIS_PARAMS } from './focusDeemphasis.js';
import { fakeCameraPort } from '../testSupport/fakeCameraPort.mjs';
import cctvLayer, {
  _cctvIconsForTest,
  _extractPickedCameraIdForTest,
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
const paintedLabels = new Map();
beforeEach(() => {
  globalThis.document = {
    createElement: () => ({
      getContext: () => ({
        beginPath() {},
        arc() {},
        roundRect() {},
        measureText: (text) => ({ width: text.length * 15 }),
        fill() {},
        stroke() {},
        fillText(text, x, y, maxWidth) {
          paintedLabels.set(text, maxWidth ?? Infinity);
        },
      }),
    }),
  };
});

afterEach(() => {
  paintedLabels.clear();
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

/** Count billboards the layer currently shows. */
function markers() {
  const book = cctvLayer._cctvDrawnForTest().counts;
  return book.show
    ? book
        .ids()
        .map(book.item)
        .filter((item) => item.show)
    : [];
}

/** Send a clean count-marker click through the layer's world click handler. */
function clickMarker(marker) {
  const set = cctvLayer._cctvDrawnForTest().counts.setId;
  const hit = { set, id: marker.id, meta: marker.meta };
  assert.equal(_extractPickedCameraIdForTest(hit), null);
  const click = bindCctvWorldClickGesture({ onClick: (fn) => fn }, () => {
    assert.fail('a count click reached activation or empty-click deselection');
  });
  click({ drawHit: hit, gesture: { travelPx: 0, durationMs: 20 } });
}

test('a crowded cell shows its count and a singleton keeps its icon', () => {
  const { records } = recordsAt(CLUSTER);
  _setCctvCoverageStateForTest({ viewer: viewerAt(20_000), records });
  assert.equal(refreshHorizonCulling(), true);
  assert.deepEqual(shownIds(records), ['cam-3']);
  assert.deepEqual(_viewRecordIdsForTest(), ['cam-3']);
  assert.deepEqual(
    markers().map((item) => item.meta.count),
    [3],
  );
  assert.deepEqual(
    cctvLayer.getDetectableObjects().map((o) => o.sourceId),
    ['cam-3'],
  );
});

test('a pan keeps the same winners, and an unchanged view keeps its list', () => {
  const { records } = recordsAt(CLUSTER);
  _setCctvCoverageStateForTest({
    viewer: viewerAt(20_000),
    records,
  });
  refreshHorizonCulling();
  const before = cctvLayer.getUIState().cameraIndex;
  const list = _viewRecordIdsForTest();
  // A pan of a few to some 40 px (a pixel is about 30 m from 20 km up).
  for (const shiftM of [90, 330, 600, 1110]) {
    _setCctvCoverageStateForTest({
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
  _setCctvCoverageStateForTest({ viewer: viewerAt(20_000), records });
  refreshHorizonCulling();
  assert.equal(refreshHorizonCulling(), false, 'the same view changes nothing');
  assert.deepEqual(_viewRecordIdsForTest(), list);
});

test('a small zoom within one cell size keeps the same winners', () => {
  const { records } = recordsAt(CLUSTER);
  const shownAt = (heightM) => {
    _setCctvCoverageStateForTest({
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
    _setCctvCoverageStateForTest({
      viewer: viewerAt(20_000),
      records,
      healthById: new Map([[id, { status: 'ok' }]]),
    });
    refreshHorizonCulling();
    assert.deepEqual(
      cctvLayer.getUIState().cameraIndex.map((c) => c.id),
      [id],
    );
    const { pos } = markers()[0];
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
    _setCctvCoverageStateForTest({
      viewer: viewerAt(20_000),
      records,
      activeCameraId: active.camera.id,
    });
    refreshHorizonCulling();
    assert.deepEqual(
      markers().map((item) => item.meta.count),
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
  _setCctvCoverageStateForTest({
    viewer: viewerAt(300),
    records,
  });
  refreshHorizonCulling();
  assert.deepEqual(shownIds(records), ['cam-0', 'cam-1']);
});

test('a disabled layer skips the view pass', () => {
  const { records } = recordsAt(CLUSTER);
  _setCctvCoverageStateForTest({
    viewer: viewerAt(20_000),
    records,
    enabled: false,
  });
  assert.equal(refreshHorizonCulling(), false);
  assert.deepEqual(_viewRecordIdsForTest(), []);
});

test('UI state builds the full camera list only when it is read', () => {
  const { records } = recordsAt(CLUSTER.slice(0, 2));
  _setCctvCoverageStateForTest({
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
  _setCctvCoverageStateForTest({
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
    _setCctvCoverageStateForTest({ viewer: viewerAt(20_000, lon), records });
    refreshHorizonCulling();
    assert.deepEqual(
      markers().map((item) => item.meta.count),
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
  _setCctvCoverageStateForTest({ viewer, records });
  refreshHorizonCulling();
  assert.deepEqual(
    markers().map((item) => item.meta.count),
    [2],
  );
});

test('co-located cameras separate below the minimum cell size', () => {
  const { records } = recordsAt([
    [0, 0],
    [0, 0],
  ]);
  _setCctvCoverageStateForTest({ viewer: viewerAt(300), records });
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
    _setCctvCoverageStateForTest({
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
    _setCctvCoverageStateForTest({
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
  _setCctvCoverageStateForTest({ viewer: viewerAt(20_000), records });
  refreshHorizonCulling();
  assert.equal(markers().length, 1);
  cctvLayer.disable();
  assert.deepEqual(markers(), []);
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
  _setCctvCoverageStateForTest({ viewer, records, activeCameraId: 'cam-0' });
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
  _setCctvCoverageStateForTest({ viewer: viewerAt(20_000), records });
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
  assert.equal(markers()[0].focus, params.dimFloor);
  tick(params.attackMs + 2, null);
  tick(params.attackMs + params.releaseMs + 3, null);
  assert.equal(markers()[0].focus, 1);
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
    _setCctvCoverageStateForTest({
      viewer: viewerAt(20_000, pan, flights),
      records: order,
      activeCameraId: 'cam-7',
      healthById: new Map([[order[0].camera.id, { status: 'ok' }]]),
    });
    refreshHorizonCulling();
    const shown = markers();
    assert.deepEqual(shownIds(records), ['cam-7', 'cam-8']);
    assert.equal(
      shown.reduce((sum, m) => sum + m.meta.count, 0),
      7,
    );
    assert.deepEqual(
      shown.map((m) => m.meta.count).sort((a, b) => a - b),
      [2, 5],
    );
    const merged = shown.find((m) => m.meta.count === 5);
    assert.ok(
      Cesium.Cartesian3.distance(
        merged.pos,
        Cesium.Cartesian3.fromDegrees(0.0008, 0, 10),
      ) < 0.01,
    );
    const positions = shown.map((m) => [m.id, m.pos]);
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

test('long localized labels use their measured width on the canvas and billboard', () => {
  const locale = getLocale();
  try {
    setLocale('ru');
    const { records } = recordsAt([
      ...Array(1300).fill([-0.008, 0]),
      [0.06, 0],
      [0.06, 0],
    ]);
    _setCctvCoverageStateForTest({ viewer: viewerAt(20_000), records });
    refreshHorizonCulling();
    const short = markers().find((m) => m.meta.count === 2);
    const long = markers().find((m) => m.meta.count === 1300);
    assert.equal(short.image.canvas.width, short.image.canvas.height);
    assert.ok(long.image.canvas.width > long.image.canvas.height);
    assert.equal(long.size[1], short.size[1]);
    assert.equal(
      long.size[0] / long.size[1],
      long.image.canvas.width / long.image.canvas.height,
    );
    const text = new Intl.NumberFormat('ru', { notation: 'compact' }).format(
      1300,
    );
    assert.ok(paintedLabels.get(text) >= text.length * 15);
    assert.ok(
      long.image.canvas.width > text.length * 15,
      'the digits have padding',
    );
  } finally {
    setLocale(locale);
  }
});

test('a wider localized pill merges a horizontal neighbor beyond the circle diameter', () => {
  const locale = getLocale();
  try {
    setLocale('ru');
    // The centers are 46 CSS pixels apart. Only the pill reaches its neighbor.
    const at = (count) => {
      const { records } = recordsAt([
        ...Array(count).fill([-0.008, 0]),
        [0.008, 0],
        [0.008, 0],
      ]);
      _setCctvCoverageStateForTest({ viewer: viewerAt(20_000), records });
      refreshHorizonCulling();
      return markers().map((m) => m.meta.count);
    };
    assert.deepEqual(at(2), [2, 2]);
    assert.deepEqual(at(1300), [1302]);
  } finally {
    setLocale(locale);
  }
});

test('a merged centre can pick up a third count marker', () => {
  // The two northern centres are 35 px apart. Each is 40 px from the
  // southern one, but their combined centre is only 36 px away.
  const { records } = recordsAt([
    [-0.006, 0],
    [-0.006, 0],
    [0.006, 0],
    [0.006, 0],
    [0, -0.0126],
    [0, -0.0126],
  ]);
  _setCctvCoverageStateForTest({ viewer: viewerAt(20_000), records });
  refreshHorizonCulling();
  assert.deepEqual(
    markers().map((m) => m.meta.count),
    [6],
  );
});
