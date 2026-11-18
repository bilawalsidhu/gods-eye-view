// src/data/cctvViewThinning.test.mjs — the CCTV view pass: only cameras on or
// near the screen show, a zoomed-out view keeps one camera per world-anchored
// cell, and the layer's UI state never rebuilds every camera for a listener
// that does not read the list.
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { bindRenderer } from '../render/rendererOf.js';
import { fakeCameraPort } from '../testSupport/fakeCameraPort.mjs';
import cctvLayer, {
  _cctvIconsForTest,
  _setCctvCoverageStateForTest,
  _viewRecordIdsForTest,
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
function viewerAt(heightM, lonDeg = 0) {
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
afterEach(() => {
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

test('zoomed out, cameras sharing a ground cell show one icon', () => {
  const { records } = recordsAt(CLUSTER);
  _setCctvCoverageStateForTest({
    viewer: viewerAt(20_000),
    records,
  });
  assert.equal(
    refreshHorizonCulling(),
    true,
    'the first pass changes the view',
  );
  const shown = shownIds(records);
  assert.equal(shown.length, 2, 'one for the cluster, one for the far camera');
  assert.ok(shown.includes('cam-3'), 'a camera alone in its cell shows');
  assert.deepEqual(_viewRecordIdsForTest().sort(), shown);
});

test('a pan keeps the same winners, and an unchanged view keeps its list', () => {
  const { records } = recordsAt(CLUSTER);
  _setCctvCoverageStateForTest({
    viewer: viewerAt(20_000),
    records,
  });
  refreshHorizonCulling();
  const before = shownIds(records);
  const list = _viewRecordIdsForTest();
  // A pan of a few to some 40 px (a pixel is about 30 m from 20 km up).
  for (const shiftM of [90, 330, 600, 1110]) {
    _setCctvCoverageStateForTest({
      viewer: viewerAt(20_000, shiftM / 111_320),
      records,
    });
    refreshHorizonCulling();
    assert.deepEqual(shownIds(records), before, `pan by ${shiftM} m`);
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
    return shownIds(records);
  };
  // Cells come in power-of-two metre steps: about 1.5 km and 1.6 km cells at
  // these heights fall in the same step, so the same cameras win.
  assert.deepEqual(shownAt(20_500), shownAt(20_000));
});

test('a healthy camera wins its cell over an unknown one', () => {
  const { records } = recordsAt(CLUSTER.slice(0, 2));
  // Whichever camera the id order would pick, the healthy one must win.
  for (const id of ['cam-0', 'cam-1']) {
    _setCctvCoverageStateForTest({
      viewer: viewerAt(20_000),
      records,
      healthById: new Map([[id, { status: 'ok' }]]),
    });
    refreshHorizonCulling();
    assert.deepEqual(shownIds(records), [id]);
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
