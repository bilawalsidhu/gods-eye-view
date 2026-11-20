import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { bindRenderer } from '../render/rendererOf.js';
import { fakeCameraPort } from '../testSupport/fakeCameraPort.mjs';
import { fakeDrawPort } from '../testSupport/fakeDrawPort.mjs';
import cctvLayer, {
  _cctvIconsForTest,
  _setCctvCoverageStateForTest,
  refreshHorizonCulling,
} from './cctv.js';

const WIDTH = 800;
const HEIGHT = 600;
const bindings = [];
beforeEach(() => {
  globalThis.document = {
    createElement: () => ({
      getContext: () => ({
        measureText: (text) => ({
          width: text.length * 8,
          actualBoundingBoxAscent: 4,
          actualBoundingBoxDescent: 4,
        }),
      }),
    }),
  };
});
afterEach(() => {
  delete globalThis.document;
  for (const unbind of bindings.splice(0)) unbind();
});

function recordsAt(lonLats, height = 10) {
  return lonLats.map(([lon, lat], index) => {
    const position = Cesium.Cartesian3.fromDegrees(lon, lat, height);
    return {
      camera: {
        id: `cam-${String(index).padStart(4, '0')}`,
        name: `Camera ${index}`,
        city: 'Test',
        lat,
        lon,
        headingDeg: 0,
        pitchDeg: -18,
        fovDeg: 44,
        rangeM: 145,
        mountHeightM: 8,
        absoluteHeightM: height,
      },
      position: { x: position.x, y: position.y, z: position.z },
      groundSamples: {},
      groundResolved: {},
      coverageEntities: [],
      projection: null,
    };
  });
}

const plain = ({ x, y, z }) => ({ x, y, z });

function lookingAt(eye, target, ports = {}) {
  const direction = Cesium.Cartesian3.normalize(
    Cesium.Cartesian3.subtract(target, eye, new Cesium.Cartesian3()),
    new Cesium.Cartesian3(),
  );
  const right = Cesium.Cartesian3.normalize(
    Cesium.Cartesian3.cross(direction, eye, new Cesium.Cartesian3()),
    new Cesium.Cartesian3(),
  );
  const up = Cesium.Cartesian3.cross(right, direction, new Cesium.Cartesian3());
  return {
    viewer: viewerWithAxes(eye, direction, right, up, ports),
    direction,
    right,
    up,
  };
}

function topDown(height, ports = {}) {
  const eye = Cesium.Cartesian3.fromDegrees(0, 0, height);
  return viewerWithAxes(
    eye,
    { x: -1, y: 0, z: 0 },
    { x: 0, y: 1, z: 0 },
    { x: 0, y: 0, z: 1 },
    ports,
  );
}

function viewerWithAxes(eye, direction, right, up, ports) {
  const carto = Cesium.Cartographic.fromCartesian(eye);
  const { port } = fakeCameraPort({
    pose: {
      lon: Cesium.Math.toDegrees(carto.longitude),
      lat: Cesium.Math.toDegrees(carto.latitude),
      height: carto.height,
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
  const viewer = {};
  bindings.push(
    bindRenderer(viewer, {
      camera: port,
      canvas: { clientWidth: WIDTH, clientHeight: HEIGHT },
      draw: fakeDrawPort(),
      ...ports,
    }),
  );
  return viewer;
}

/** Pinhole projection, as the layer's projector. */
function project(view, eye, point) {
  const d = Cesium.Cartesian3.subtract(point, eye, new Cesium.Cartesian3());
  const z = Cesium.Cartesian3.dot(d, view.direction);
  const t = Math.tan(Math.PI / 6);
  const x = Cesium.Cartesian3.dot(d, view.right) / z / (t * (WIDTH / HEIGHT));
  const y = Cesium.Cartesian3.dot(d, view.up) / z / t;
  return { x: (0.5 + x / 2) * WIDTH, y: (0.5 - y / 2) * HEIGHT, z };
}

for (const [label, horizontalM, aboveM] of [
  ['100 m approach', 100, 4],
  ['800 m approach', 800, 50],
]) {
  test(`a camera with a stale height is read even when it projects off the screen at ${label}`, () => {
    const ground = 1872;
    const records = recordsAt([
      [0, 0],
      [0, 0],
    ]);
    // geoid fallback after a 429
    for (const r of records)
      r.groundPrior = { ellipsoid: 2, source: 'geoid-fallback' };
    const mount = Cesium.Cartesian3.fromDegrees(0, 0, ground + 8);
    const eye = Cesium.Cartesian3.fromDegrees(
      0,
      -horizontalM / 111_320,
      ground + 8 + aboveM,
    );
    const reads = [];
    const view = lookingAt(eye, mount, {
      globe: { isGlobeVisible: () => true },
      query: {
        sampleHeightNow(point) {
          reads.push(point);
          return ground;
        },
      },
    });
    _setCctvCoverageStateForTest({ viewer: view.viewer, records });
    const stale = project(view, eye, records[0].position);
    const truth = project(view, eye, mount);

    assert.ok(stale.y > HEIGHT * 2);
    assert.ok(truth.y > 0 && truth.y < HEIGHT);
    refreshHorizonCulling();
    refreshHorizonCulling();
    assert.equal(records[0].groundPrior.ellipsoid, ground);

    assert.ok(reads.length > 0, 'the stale camera was never read');
  });
}

test('cameras off the visible screen cannot spend the whole terrain read budget', () => {
  // 300 cameras with no prior around the screen edge, tiles not loaded; the
  // 301st at the screen centre over a loaded tile.
  const lonLats = [];
  for (let i = 0; i < 300; i++) {
    const a = (i / 300) * 2 * Math.PI;
    // ~ 0.8 screen widths out at 200 m altitude (screen ~ 307 m wide)
    lonLats.push([
      (Math.cos(a) * 250) / 111_320,
      (Math.sin(a) * 190) / 111_320,
    ]);
  }
  lonLats.push([0, 0]);
  const records = recordsAt(lonLats);
  const perPass = [];
  let reads;
  const viewer = topDown(200, {
    globe: { isGlobeVisible: () => true },
    query: {
      sampleHeightNow(point) {
        reads.push(point);
        return Math.abs(point.lon) < 1e-9 && Math.abs(point.lat) < 1e-9
          ? 40
          : null;
      },
    },
  });
  _setCctvCoverageStateForTest({ viewer, records });
  for (let pass = 0; pass < 3; pass++) {
    reads = [];
    refreshHorizonCulling();
    perPass.push(reads.length);
  }
  const last = records.at(-1);

  assert.equal(last.groundPrior?.ellipsoid, 40);
  assert.ok(perPass.every((n) => n <= 300));
});

test("the active camera's icon moves beside a count that would cover it", () => {
  const records = recordsAt([
    [0, 0],
    [0, 0],
    [0, 0],
  ]);
  const viewer = topDown(20_000);
  _setCctvCoverageStateForTest({ viewer, records, activeCameraId: 'cam-0000' });
  refreshHorizonCulling();
  const icons = _cctvIconsForTest();
  const [marker] = cctvLayer._cctvDrawnForTest().counts.markers;
  const metresPerPixel = ((2 * Math.tan(Math.PI / 6)) / HEIGHT) * 19_990;
  const apartPx =
    Cesium.Cartesian3.distance(marker.pos, icons.item('cam-0000').pos) /
    metresPerPixel;

  assert.ok(apartPx > marker.width / 2, 'the marker covers the active icon');
});

test('a lone camera just inside the grouping threshold joins the count beside it', () => {
  const h = 740;
  // mounts at 8 m mount height above a 0 m ground: positions at 10 m, eye at h+10
  const records = recordsAt([
    [0, 235 / 111_320],
    [0, 255 / 111_320],
    [0, 255 / 111_320],
  ]);
  for (const r of records) r.groundPrior = { ellipsoid: 2, source: 'reearth' };
  const viewer = topDown(h + 10);
  _setCctvCoverageStateForTest({ viewer, records });
  refreshHorizonCulling();
  const icons = _cctvIconsForTest();
  const markers = cctvLayer._cctvDrawnForTest().counts.markers;
  assert.deepEqual(
    markers.map((marker) => marker.cell.count),
    [3],
  );
  assert.equal(
    icons.item('cam-0000').show,
    false,
    'the near singleton still draws beside the count',
  );
});
