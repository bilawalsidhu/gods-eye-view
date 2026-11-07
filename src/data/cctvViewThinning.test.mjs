// src/data/cctvViewThinning.test.mjs — the CCTV view pass: only cameras on or
// near the screen show, a zoomed-out view keeps one camera per world-anchored
// cell, and the layer's UI state never rebuilds every camera for a listener
// that does not read the list.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import cctvLayer, {
  _setCctvCoverageStateForTest,
  _viewRecordIdsForTest,
  refreshHorizonCulling,
} from './cctv.js';

const WIDTH = 800;
const HEIGHT = 600;

/**
 * Records at the given [lon, lat] degrees near the origin, each drawn at the
 * screen point `screenAt` gives it (default: the middle of the screen).
 */
function recordsAt(
  lonLats,
  screenAt = () => ({ x: WIDTH / 2, y: HEIGHT / 2 }),
) {
  const screenByPosition = new Map();
  const records = lonLats.map(([lon, lat], index) => {
    const position = Cesium.Cartesian3.fromDegrees(lon, lat, 10);
    screenByPosition.set(position, screenAt(index));
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
      position,
      billboard: { position, show: true },
      coverageEntities: [],
      projection: null,
    };
  });
  return { records, screenByPosition };
}

function viewerAt(heightM, screenByPosition, shiftX = 0) {
  return {
    isDestroyed: () => false,
    camera: {
      positionWC: Cesium.Cartesian3.fromDegrees(0, 0, heightM),
      positionCartographic: { latitude: 0, longitude: 0, height: heightM },
      frustum: { fovy: Math.PI / 3 },
    },
    scene: {
      canvas: { clientWidth: WIDTH, clientHeight: HEIGHT },
      cartesianToCanvasCoordinates: (position) => {
        const screen = screenByPosition.get(position);
        return screen && { x: screen.x + shiftX, y: screen.y };
      },
    },
  };
}

function shownIds(records) {
  return records
    .filter((record) => record.billboard.show)
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
  const { records, screenByPosition } = recordsAt(CLUSTER);
  _setCctvCoverageStateForTest({
    viewer: viewerAt(20_000, screenByPosition),
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
  const { records, screenByPosition } = recordsAt(CLUSTER, (index) => ({
    x: 100 + index * 7,
    y: 300,
  }));
  _setCctvCoverageStateForTest({
    viewer: viewerAt(20_000, screenByPosition),
    records,
  });
  refreshHorizonCulling();
  const before = shownIds(records);
  const list = _viewRecordIdsForTest();
  for (const shiftX of [3, 11, 20, 37]) {
    _setCctvCoverageStateForTest({
      viewer: viewerAt(20_000, screenByPosition, shiftX),
      records,
    });
    refreshHorizonCulling();
    assert.deepEqual(shownIds(records), before, `pan by ${shiftX} px`);
  }
  assert.equal(refreshHorizonCulling(), false, 'the same view changes nothing');
  assert.deepEqual(_viewRecordIdsForTest(), list);
});

test('a small zoom within one cell size keeps the same winners', () => {
  const { records, screenByPosition } = recordsAt(CLUSTER);
  const shownAt = (heightM) => {
    _setCctvCoverageStateForTest({
      viewer: viewerAt(heightM, screenByPosition),
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
  const { records, screenByPosition } = recordsAt(CLUSTER.slice(0, 2));
  // Whichever camera the id order would pick, the healthy one must win.
  for (const id of ['cam-0', 'cam-1']) {
    _setCctvCoverageStateForTest({
      viewer: viewerAt(20_000, screenByPosition),
      records,
      healthById: new Map([[id, { status: 'ok' }]]),
    });
    refreshHorizonCulling();
    assert.deepEqual(shownIds(records), [id]);
  }
});

test('the active camera always shows, even in a crowded cell', () => {
  const { records, screenByPosition } = recordsAt(CLUSTER.slice(0, 3));
  for (const active of records) {
    _setCctvCoverageStateForTest({
      viewer: viewerAt(20_000, screenByPosition),
      records,
      activeCameraId: active.camera.id,
    });
    refreshHorizonCulling();
    assert.ok(active.billboard.show, `${active.camera.id} shows while active`);
  }
});

test('close up, every camera near the screen shows and far-off ones hide', () => {
  const { records, screenByPosition } = recordsAt(
    [
      [0, 0],
      [0.0001, 0],
      [0.0002, 0],
    ],
    (index) =>
      index === 2 ? { x: WIDTH * 3, y: HEIGHT / 2 } : { x: 100, y: 100 },
  );
  _setCctvCoverageStateForTest({
    viewer: viewerAt(300, screenByPosition),
    records,
  });
  refreshHorizonCulling();
  assert.deepEqual(shownIds(records), ['cam-0', 'cam-1']);
});

test('a disabled layer skips the view pass', () => {
  const { records, screenByPosition } = recordsAt(CLUSTER);
  _setCctvCoverageStateForTest({
    viewer: viewerAt(20_000, screenByPosition),
    records,
    enabled: false,
  });
  assert.equal(refreshHorizonCulling(), false);
  assert.deepEqual(_viewRecordIdsForTest(), []);
});

test('UI state builds the full camera list only when it is read', () => {
  const { records, screenByPosition } = recordsAt(CLUSTER.slice(0, 2));
  _setCctvCoverageStateForTest({
    viewer: viewerAt(300, screenByPosition),
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
  const { records, screenByPosition } = recordsAt(
    [
      [0, 0],
      [0.0001, 0],
      [0.0002, 0],
    ],
    (index) => (index === 1 ? { x: WIDTH * 3, y: 0 } : { x: 100, y: 100 }),
  );
  _setCctvCoverageStateForTest({
    viewer: viewerAt(300, screenByPosition),
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
